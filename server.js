// server.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const YTDlpWrap = require("yt-dlp-wrap");
const { spawn } = require("child_process");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const JOBS = {};

const VALID_AUDIO_FORMATS = ["mp3", "aac", "m4a", "opus", "wav", "flac"];
const VALID_VIDEO_FORMATS = ["mp4", "mkv", "webm"];

app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

function formatDuration(isoDuration) {
  const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
  const [, h, m, s] = isoDuration.match(regex) || [];
  const hours = h ? String(h).padStart(2, "0") : "00";
  const mins = m ? String(m).padStart(2, "0") : "00";
  const secs = s ? String(s).padStart(2, "0") : "00";
  return `${hours}:${mins}:${secs}`.replace(/^00:/, "");
}

app.get("/", (req, res) => {
  res.send("Server is running!");
});

async function getVideoInfo(id) {
  const ytdlp = new YTDlpWrap();
  const jsonResult = await ytdlp.execPromise([
    `https://www.youtube.com/watch?v=${id}`,
    "--dump-json",
  ]);
  const info = JSON.parse(jsonResult);
  const videoFormats = [];
  const audioFormats = [];

  info.formats.forEach((format) => {
    const entry = {
      quality: format.format_note || format.quality_label || format.audio_quality,
      download_url: `/api/download?url=${encodeURIComponent(format.url)}&title=${encodeURIComponent(info.title)}`,
    };
    if (format.vcodec !== "none" && format.acodec !== "none") videoFormats.push(entry);
    else if (format.vcodec === "none" && format.acodec !== "none") audioFormats.push(entry);
  });

  return {
    title: info.title,
    thumbnail: info.thumbnail,
    videoFormats,
    audioFormats,
  };
}

app.get("/api/video/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const info = await getVideoInfo(id);
    res.json({ id: uuidv4(), ...info });
  } catch (error) {
    res.status(500).json({ error: "yt-dlp failed", details: error.message });
  }
});

app.post("/api/convert/start", async (req, res) => {
  const { id, format: inputFormat, type } = req.body;
  const formatAliases = {
    "360p": "mp4",
    "480p": "mp4",
    "720p": "mp4",
    "1080p": "mp4",
  };
  const format = formatAliases[inputFormat] || inputFormat;
  const formatList = type === "audio" ? VALID_AUDIO_FORMATS : VALID_VIDEO_FORMATS;
  if (!formatList.includes(format)) {
    return res.status(400).json({ error: "Unsupported output format" });
  }

  const jobId = uuidv4();
  const outputExt = type === "audio" ? format : "mp4";
  const title = `yt-${id}`;
  const baseName = title.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const tempInput = path.join(__dirname, `temp_${jobId}_input.mkv`);
  const outFile = path.join(__dirname, `temp_${jobId}.${outputExt}`);
  const filename = `${baseName}.${outputExt}`;

  JOBS[jobId] = { progress: 0, path: outFile, done: false, ext: outputExt, name: filename };

  try {
    const ytdlp = new YTDlpWrap();
    await ytdlp.execPromise([
      `https://www.youtube.com/watch?v=${id}`,
      "-f",
      "bestvideo+bestaudio",
      "--merge-output-format",
      "mkv",
      "-o",
      tempInput,
    ]);

    const ffmpegArgs = type === "audio"
      ? ["-i", tempInput, "-f", format, "-vn", "-ab", "192k", "-progress", "pipe:2", outFile]
      : ["-i", tempInput, "-f", "mp4", "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-progress", "pipe:2", outFile];

    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    ffmpeg.on("error", (err) => {
      console.error("ffmpeg spawn error:", err);
      return res.status(500).json({ error: "FFmpeg execution failed" });
    });

    ffmpeg.stderr.on("data", (data) => {
      console.error("ffmpeg error:", data.toString());
    });

    ffmpeg.stdio[2].on("data", (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      lines.forEach((line) => {
        if (line.startsWith("out_time_ms=")) {
          const ms = parseInt(line.split("=")[1]);
          JOBS[jobId].progress = Math.min(100, Math.round((ms / 60000) * 100));
        }
        if (line.startsWith("progress=end")) {
          JOBS[jobId].progress = 100;
          JOBS[jobId].done = true;
        }
      });
    });

    ffmpeg.on("exit", () => {
      JOBS[jobId].progress = 100;
      JOBS[jobId].done = true;
      fs.unlink(tempInput, () => {});
    });

    setTimeout(() => {
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
      if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
      delete JOBS[jobId];
      console.log(`Expired and cleaned up job ${jobId}`);
    }, 10 * 60 * 1000);

    res.json({ jobId });
  } catch (err) {
    console.error("Conversion error:", err);
    return res.status(500).json({ error: "Failed to convert video" });
  }
});

app.get("/api/convert/download", (req, res) => {
  const { id } = req.query;
  const job = JOBS[id];
  if (!job || !fs.existsSync(job.path)) return res.status(404).json({ error: "Download not ready" });

  const rawTitle = job.name?.replace(/_/g, " ") || `converted_${id}`;
  const safeTitle = rawTitle.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const filename = `${safeTitle}.${job.ext || "mp4"}`;

  res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Encoding", "gzip");

  const stream = fs.createReadStream(job.path);
  stream.on("error", (err) => {
    console.error("Stream error:", err);
    res.status(500).json({ error: "Failed to stream file" });
  });
  stream.pipe(res);
  stream.on("close", () => {
    fs.unlink(job.path, () => {});
    delete JOBS[id];
  });
});

app.get("/api/progress", (req, res) => {
  const { id } = req.query;
  const job = JOBS[id];
  if (!job) return res.status(404).json({ error: "Job not found" });
  const ready = job.progress >= 100 && job.done && fs.existsSync(job.path);
  const payload = { progress: job.progress, ready };
  console.log("Progress response:", payload);
  res.json(payload);
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
