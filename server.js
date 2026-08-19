import express from 'express'
import cors from 'cors'
import crypto from 'crypto'
import { renderProjeto, getFfmpegInfo } from './render.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '80mb' }))

const jobs = new Map()
let fila = []
let processando = false
const sseClients = new Map()
const MAX_JOBS = 100

function notificar(id) {
  const estado = jobs.get(id)
  for (const res of sseClients.get(id) || []) {
    res.write(`data: ${JSON.stringify(estado)}\n\n`)
  }
  if (estado && (estado.status === 'done' || estado.status === 'error')) {
    for (const res of sseClients.get(id) || []) {
      setTimeout(() => res.end(), 150)
    }
    sseClients.delete(id)
  }
}

function rodarFila() {
  if (processando || fila.length === 0) return
  const { id, body } = fila.shift()
  const j = jobs.get(id)
  if (!j) return
  processando = true
  j.status = 'rendering'
  j.etapa = 'Renderizando (download, ffmpeg, upload)...'
  j.progresso = 0
  notificar(id)
  renderProjeto(body, {
    onProgress: (info) => {
      j.progresso = info.segundos || 0
      j.duracao = info.duracao || j.duracao || 0
      notificar(id)
    },
  })
    .then((r) => {
      j.status = 'done'
      j.etapa = 'Concluído'
      j.resultado = r
      notificar(id)
    })
    .catch((e) => {
      j.status = 'error'
      j.etapa = 'Erro'
      j.erro = e.message
      notificar(id)
    })
    .finally(() => {
      processando = false
      rodarFila()
    })
}

function limparJobs() {
  if (jobs.size > MAX_JOBS) {
    for (const id of [...jobs.keys()].slice(0, jobs.size - MAX_JOBS)) jobs.delete(id)
  }
}

app.get('/health', async (req, res) => {
  res.json({ ok: true, nome: 'klv-render', fila: fila.length, processando, ffmpeg: await getFfmpegInfo() })
})

app.get('/filas', (req, res) => {
  res.json({
    ativo: processando,
    aguardando: fila.length,
    total: jobs.size,
    jobs: [...jobs.entries()].map(([id, j]) => ({ id, status: j.status, progresso: j.progresso, duracao: j.duracao, erro: j.erro })),
  })
})

app.post('/jobs', (req, res) => {
  if (!req.body || !req.body.projeto) {
    res.status(400).json({ error: 'projeto obrigatório' })
    return
  }
  const id = crypto.randomUUID()
  jobs.set(id, { status: 'queued', etapa: 'Na fila', progresso: 0, duracao: 0 })
  fila.push({ id, body: req.body })
  limparJobs()
  rodarFila()
  res.json({ jobId: id, status: 'queued' })
})

app.get('/status/:id', (req, res) => {
  const j = jobs.get(req.params.id)
  if (!j) {
    res.status(404).json({ error: 'job não encontrado' })
    return
  }
  res.json(j)
})

app.get('/events/:id', (req, res) => {
  const j = jobs.get(req.params.id)
  if (!j) {
    res.status(404).end()
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write(`data: ${JSON.stringify(j)}\n\n`)
  if (!sseClients.has(req.params.id)) sseClients.set(req.params.id, new Set())
  sseClients.get(req.params.id).add(res)
  req.on('close', () => {
    const set = sseClients.get(req.params.id)
    if (set) {
      set.delete(res)
      if (set.size === 0) sseClients.delete(req.params.id)
    }
  })
  if (j.status === 'done' || j.status === 'error') {
    setTimeout(() => res.end(), 150)
  }
})

app.post('/render', async (req, res) => {
  try {
    const r = await renderProjeto(req.body)
    res.json(r)
  } catch (err) {
    console.error('render erro:', err.message)
    res.status(500).json({ error: err.message })
  }
})

const PORT = process.env.PORT || 8787
app.listen(PORT, () => {
  console.log(`klv-render rodando em http://localhost:${PORT}`)
})
