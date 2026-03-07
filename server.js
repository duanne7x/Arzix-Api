const express = require("express")
const { exec } = require("child_process")
const rateLimit = require("express-rate-limit")
const helmet = require("helmet")

const app = express()

app.use(helmet())
app.use(express.json())

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

function safeExec(command, timeout = 20000) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr?.trim() || err.message || "erro ao executar comando"))
      }
      resolve(stdout.trim())
    })
  })
}

function sanitizeQuery(query) {
  return String(query || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120)
}

function sanitizeId(id) {
  return String(id || "").trim().replace(/[^a-zA-Z0-9_-]/g, "")
}

// STATUS
app.get("/status", (req, res) => {
  res.json({
    status: "online",
    uptime: process.uptime()
  })
})

// SEARCH
app.get("/search", async (req, res) => {
  try {
    let query = sanitizeQuery(req.query.q)

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

    const command = `yt-dlp "ytsearch6:${query}" --dump-single-json --no-warnings --flat-playlist`

    const stdout = await safeExec(command, 20000)
    const parsed = JSON.parse(stdout)

    const entries = Array.isArray(parsed.entries) ? parsed.entries : []

    const results = entries.map((item) => ({
      title: item.title || "Sem título",
      artist: item.channel || item.uploader || "Desconhecido",
      videoId: item.id || null,
      duration: item.duration || null,
      artwork: item.thumbnail || null
    })).filter(item => item.videoId)

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

    const url = `https://music.youtube.com/watch?v=${id}`

    const command = `yt-dlp -f bestaudio --no-playlist --no-warnings --add-header "User-Agent: Mozilla/5.0" -g "${url}"`

    const stream = await safeExec(command, 15000)

    setCache(cacheKey, stream, 60 * 60 * 1000)

    res.json({
      status: "success",
      cached: false,
      stream
    })
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: "erro ao extrair áudio"
    })
  }
})

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`API rodando na porta ${PORT}`)
})