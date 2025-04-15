// backend/server.js

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const JOBS = {};

const VALID_AUDIO_FORMATS = ['mp3', 'aac', 'm4a', 'opus', 'wav', 'flac'];
const VALID_VIDEO_FORMATS = ['mp4', 'mkv', 'webm'];

function formatDuration(isoDuration) {
  const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
  const [, h, m, s] = isoDuration.match(regex) || [];
  const hours = h ? String(h).padStart(2, '0') : '00';
  const mins = m ? String(m).padStart(2, '0') : '00';
  const secs = s ? String(s).padStart(2, '0') : '00';
  return `${hours}:${mins}:${secs}`.replace(/^00:/, '');
}

function runYtDlp(cmd) {
  console.log('Executing command:', cmd);
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function searchYoutubeViaAPI(query) {
  const searchUrl = 'https://www.googleapis.com/youtube/v3/search';
  const videosUrl = 'https://www.googleapis.com/youtube/v3/videos';

  const searchResponse = await axios.get(searchUrl, {
    params: {
      part: 'snippet',
      q: query,
      maxResults: 9,
      type: 'video',
      key: YOUTUBE_API_KEY,
    },
  });

  const videoIds = searchResponse.data.items.map(item => item.id.videoId).join(',');

  const videosResponse = await axios.get(videosUrl, {
    params: {
      part: 'contentDetails,snippet',
      id: videoIds,
      key: YOUTUBE_API_KEY,
    },
  });

  return videosResponse.data.items.map(video => ({
    title: video.snippet.title,
    videoId: video.id,
    thumbnail: video.snippet.thumbnails.medium.url,
    duration: formatDuration(video.contentDetails.duration)
  }));
}

async function getVideoInfo(id) {
  const raw = await runYtDlp(`yt-dlp -f bestaudio+bestvideo --dump-json https://www.youtube.com/watch?v=${id}`);
  const info = JSON.parse(raw);
  const videoFormats = [];
  const audioFormats = [];

  info.formats.forEach(format => {
    const entry = {
      quality: format.format_note || format.quality_label || format.audio_quality,
      download_url: `/api/download?url=${encodeURIComponent(format.url)}&title=${encodeURIComponent(info.title)}`,
    };

    if (format.vcodec !== 'none' && format.acodec !== 'none') videoFormats.push(entry);
    else if (format.vcodec === 'none' && format.acodec !== 'none') audioFormats.push(entry);
  });

  return {
    title: info.title,
    thumbnail: info.thumbnail,
    videoFormats,
    audioFormats,
  };
}

app.post('/api/convert/start', async (req, res) => {
  console.log('Received conversion request:', req.body);
  const { id, format: inputFormat, type } = req.body;
  const formatAliases = {
    '360p': 'mp4',
    '480p': 'mp4',
    '720p': 'mp4',
    '1080p': 'mp4'
  };
  const format = formatAliases[inputFormat] || inputFormat;
  const formatList = type === 'audio' ? VALID_AUDIO_FORMATS : VALID_VIDEO_FORMATS;
  if (!formatList.includes(format)) {
    return res.status(400).json({ error: 'Unsupported output format' });
  }

  const jobId = uuidv4();
  const outputExt = type === 'audio' ? format : 'mp4';
  const title = `yt-${id}`;
  const baseName = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const tempInput = path.join(__dirname, `temp_${jobId}_input.mkv`);
  const outFile = path.join(__dirname, `temp_${jobId}.${outputExt}`);
  const filename = `${baseName}.${outputExt}`;

  JOBS[jobId] = { progress: 0, path: outFile, done: false, ext: outputExt, name: filename };

  setTimeout(() => {
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
    delete JOBS[jobId];
    console.log(`Expired and cleaned up job ${jobId}`);
  }, 10 * 60 * 1000); // cleanup in 10 minutes

  try {
    await runYtDlp(`yt-dlp -f bestvideo+bestaudio --merge-output-format mkv -o ${tempInput} https://www.youtube.com/watch?v=${id}`);

    const ffmpegArgs = type === 'audio'
      ? ['-i', tempInput, '-f', format, '-vn', '-ab', '192k', '-progress', 'pipe:2', outFile]
      : ['-i', tempInput, '-f', 'mp4', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:2', outFile];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.stderr.on('data', (data) => {
      console.error('ffmpeg error:', data.toString());
    });

    ffmpeg.stdio[2].on('data', (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      lines.forEach(line => {
        if (line.startsWith('out_time_ms=')) {
          const ms = parseInt(line.split('=')[1]);
          JOBS[jobId].progress = Math.min(100, Math.round((ms / 60000) * 100));
        }
        if (line.startsWith('progress=end')) {
          JOBS[jobId].progress = 100;
          JOBS[jobId].done = true;
        }
      });
    });

    ffmpeg.on('exit', () => {
      JOBS[jobId].progress = 100;
      JOBS[jobId].done = true;
      fs.unlink(tempInput, () => {});
    });

    res.json({ jobId });
  } catch (err) {
    console.error('Conversion error:', err);
    return res.status(500).json({ error: 'Failed to convert video' });
  }
});

app.get('/api/convert/download', (req, res) => {
  const { id } = req.query;
  const job = JOBS[id];
  if (!job || !fs.existsSync(job.path)) return res.status(404).json({ error: 'Download not ready' });

  const rawTitle = job.name?.replace(/_/g, ' ') || `converted_${id}`;
  const safeTitle = rawTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const filename = `${safeTitle}.${job.ext || 'mp4'}`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/octet-stream');

  const stream = fs.createReadStream(job.path);
  stream.on('error', (err) => {
    console.error('Stream error:', err);
    res.status(500).json({ error: 'Failed to stream file' });
  });
  stream.pipe(res);
  stream.on('close', () => {
    fs.unlink(job.path, () => {});
    delete JOBS[id];
  });
});


app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query parameter' });

  try {
    const results = await searchYoutubeViaAPI(q);
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch search results' });
  }
});

app.get('/api/video/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const info = await getVideoInfo(id);
    res.json(info);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch video info' });
  }
});

app.get('/api/progress', (req, res) => {
  const { id } = req.query;
  const job = JOBS[id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const ready = job.progress >= 100 && job.done && fs.existsSync(job.path);
  const payload = { progress: job.progress, ready };
  console.log('Progress response:', payload);
  res.json(payload);
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
