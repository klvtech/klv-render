import express from 'express'
import { renderProjeto } from './render.js'

const app = express()
app.use(express.json({ limit: '80mb' }))

app.get('/health', (req, res) => {
  res.json({ ok: true, nome: 'klv-render' })
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