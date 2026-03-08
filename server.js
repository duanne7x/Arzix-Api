const express = require("express")
const { exec } = require("child_process")
const rateLimit = require("express-rate-limit")
const helmet = require("helmet")

const app = express()

app.use(helmet())
app.use(express.json())

// RATE LIMIT
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "error",
    message: "muitas requisições, tente novamente em instantes"
  }
})

app.use(limiter)

// CACHE
const cache = new Map()

function setCache(key, value, ttlMs = 60 * 60 * 1000) {
  cache.set(key, {
    data: value,
    expire: Date.now() + ttlMs
  })
}

function getCache(key) {
  const item = cache.get(key)
  if (!item) return null

  if (Date.now() > item.expire) {
    cache.delete(key)
    return null
  }

  return item.data
}

// SANITIZE
function sanitizeQuery(query) {
  return String(query || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120)
}

function sanitizeId(id) {
  return String(id || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
}

// EXEC COMMAND
function safeExec(command, timeout = 20000) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr?.trim() || err.message))
      }
      resolve(stdout.trim())
    })
  })
}

// FIND yt-dlp
async function getYtDlpCommand() {
  const candidates = [
    process.env.YTDLP_PATH,
    "python3 -m yt_dlp",
    "yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/opt/render/project/.local/bin/yt-dlp",
    "/opt/render/.local/bin/yt-dlp"
  ].filter(Boolean)

  for (const cmd of candidates) {
    try {
      await safeExec(`${cmd} --version`, 8000)
      return cmd
    } catch {}
  }

  throw new Error("yt-dlp não encontrado no servidor")
}

// STATUS
app.get("/status", async (req, res) => {
  try {
    let ytdlp = null

    try {
      ytdlp = await getYtDlpCommand()
    } catch {}

    res.json({
      status: "online",
      uptime: process.uptime(),
      ytdlp: ytdlp || "não encontrado"
    })
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message
    })
  }
})

// SEARCH
app.get("/search", async (req, res) => {
  try {
    const query = sanitizeQuery(req.query.q)

    if (!query) {
      return res.status(400).json({
        status: "error",
        message: "query obrigatória"
      })
    }

    const cacheKey = `search:${query}`
    const cached = getCache(cacheKey)

    if (cached) {
      return res.json({
        status: "success",
        cached: true,
        total: cached.length,
        results: cached
      })
    }

    const ytdlp = await getYtDlpCommand()

    const command = `${ytdlp} "ytsearch10:${query}" --dump-single-json --no-warnings`

    const stdout = await safeExec(command, 25000)
    const parsed = JSON.parse(stdout)
    const entries = Array.isArray(parsed.entries) ? parsed.entries : []

    const blockedWords = [
      "slowed",
      "reverb",
      "nightcore",
      "live",
      "ao vivo",
      "remix",
      "lyrics",
      "letra",
      "status"
    ]

    const results = entries
      .map((item) => {
        const title = item.title || "Sem título"
        const artist = item.channel || item.uploader || "Desconhecido"
        const text = `${title} ${artist}`.toLowerCase()

        let score = 0

        if (text.includes("official")) score += 5
        if (text.includes("topic")) score += 4
        if (text.includes("audio")) score += 3
        if (text.includes("music")) score += 2

        for (const word of blockedWords) {
          if (text.includes(word)) score -= 8
        }

        return {
          title,
          artist,
          videoId: item.id,
          duration: item.duration,
          artwork: item.thumbnail || null,
          score
        }
      })
      .filter(v => v.videoId)
      .sort((a, b) => b.score - a.score)
      .map(({ score, ...rest }) => rest)
      .slice(0, 6)

    setCache(cacheKey, results, 30 * 60 * 1000)

    res.json({
      status: "success",
      cached: false,
      total: results.length,
      results
    })

  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message
    })
  }
})

// DOWNLOAD
app.get("/download", async (req, res) => {
  try {
    const id = sanitizeId(req.query.id)

    if (!id) {
      return res.status(400).json({
        status: "error",
        message: "id obrigatório"
      })
    }

    const cacheKey = `download:${id}`
    const cached = getCache(cacheKey)

    if (cached) {
      return res.json({
        status: "success",
        cached: true,
        stream: cached
      })
    }

    const ytdlp = await getYtDlpCommand()
    const url = `https://music.youtube.com/watch?v=${id}`

    const command = `${ytdlp} -f bestaudio --no-playlist --no-warnings -g "${url}"`

    const stream = await safeExec(command, 20000)

    if (!stream) {
      throw new Error("nenhum stream retornado")
    }

    setCache(cacheKey, stream, 60 * 60 * 1000)

    res.json({
      status: "success",
      cached: false,
      stream
    })

  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message
    })
  }
})

// SERVER
const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`API rodando na porta ${PORT}`)
})