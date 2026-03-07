const express = require("express")
const { exec } = require("child_process")
const { YTMusic } = require("ytmusic-api")
const rateLimit = require("express-rate-limit")
const helmet = require("helmet")

const app = express()

app.use(helmet())

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40
})

app.use(limiter)

const ytmusic = new YTMusic()

let ready = false
const cache = new Map()

async function init() {
  if (!ready) {
    await ytmusic.initialize()
    ready = true
    console.log("YTMusic iniciado")
  }
}

init()

function setCache(key,value){
  cache.set(key,{
    data:value,
    expire:Date.now()+1000*60*60
  })
}

function getCache(key){
  const item = cache.get(key)

  if(!item) return null

  if(Date.now()>item.expire){
    cache.delete(key)
    return null
  }

  return item.data
}


// STATUS
app.get("/status",(req,res)=>{
  res.json({
    status:"online",
    uptime:process.uptime()
  })
})


// SEARCH
app.get("/search",async(req,res)=>{

  try{

    await init()

    let query = req.query.q

    if(!query){
      return res.status(400).json({
        error:"query obrigatória"
      })
    }

    query = query.trim().slice(0,100)

    const results = await ytmusic.searchSongs(query)

    const songs = results.slice(0,6).map(song=>({
      title:song.name,
      artist:song.artist.name,
      videoId:song.videoId,
      duration:song.duration,
      artwork:song.thumbnails?.[0]?.url || null
    }))

    res.json({
      status:"success",
      total:songs.length,
      results:songs
    })

  }catch(err){

    res.status(500).json({
      status:"error",
      message:err.message
    })

  }

})


// DOWNLOAD
app.get("/download",(req,res)=>{

  const id = req.query.id

  if(!id){
    return res.status(400).json({error:"id obrigatório"})
  }

  const cached = getCache(id)

  if(cached){
    return res.json({
      status:"success",
      cached:true,
      stream:cached
    })
  }

  const url = `https://music.youtube.com/watch?v=${id}`

  const command = `yt-dlp -f bestaudio --no-playlist --no-warnings --add-header "User-Agent: Mozilla/5.0" -g "${url}"`

  exec(command,{timeout:15000},(err,stdout)=>{

    if(err){
      return res.status(500).json({
        status:"error",
        message:"erro ao extrair áudio"
      })
    }

    const stream = stdout.trim()

    setCache(id,stream)

    res.json({
      status:"success",
      cached:false,
      stream
    })

  })

})


const PORT = process.env.PORT || 3000

app.listen(PORT,()=>{
  console.log(`API rodando na porta ${PORT}`)
})