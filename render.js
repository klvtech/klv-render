import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import ffmpegPath from 'ffmpeg-static'
import { salvarVideoNoDrive } from './lib/drive.js'

const execFileP = promisify(execFile)
const FPS = 30
const FADE = 0.5
const TITULO_DUR = 2.5

function executarFfmpeg(args, onInfo) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args)
    let stderr = ''
    proc.stderr.on('data', (buf) => {
      stderr += buf.toString()
      const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(stderr)
      if (m && onInfo) {
        const h = +m[1]
        const mi = +m[2]
        const s = +m[3]
        onInfo({ segundos: h * 3600 + mi * 60 + s })
      }
    })
    proc.on('error', (e) => reject(e))
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr)
      else {
        const cauda = stderr
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-6)
          .join(' | ')
        reject(new Error(`ffmpeg falhou com código ${code}${cauda ? ' (' + cauda.slice(0, 400) + ')' : ''}`))
      }
    })
  })
}

async function detectFfmpegBin() {
  const candidatos = [process.env.FFMPEG_PATH, ffmpegPath, 'ffmpeg'].filter(Boolean)
  let fallback = ffmpegPath
  for (const bin of candidatos) {
    try {
      const { stdout } = await execFileP(bin, ['-filters'])
      const filters = String(stdout)
      if (/gradients/.test(filters) && /drawtext/.test(filters)) return bin
      if (/drawtext/.test(filters)) fallback = bin
    } catch {}
  }
  return fallback
}

const ffmpegBin = await detectFfmpegBin()
const usaGradientes = await (async () => {
  try {
    const { stdout } = await execFileP(ffmpegBin, ['-filters'])
    return /gradients/.test(String(stdout))
  } catch {
    return false
  }
})()

export async function getFfmpegInfo() {
  try {
    const { stdout: v } = await execFileP(ffmpegBin, ['-version'])
    const { stdout: f } = await execFileP(ffmpegBin, ['-filters'])
    return {
      ok: true,
      bin: ffmpegBin,
      versao: String(v).split('\n')[0],
      drawtext: /drawtext/.test(f),
    }
  } catch (e) {
    return { ok: false, bin: ffmpegBin, erro: String((e && e.stderr) || e) }
  }
}

const FORMATOS = {
  '9:16': { w: 720, h: 1280 },
  '4:5': { w: 1080, h: 1350 },
  '1:1': { w: 1080, h: 1080 },
  '16:9': { w: 1280, h: 720 },
}

function hex(c) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(c || '').trim())
  return m ? '0x' + m[1].toLowerCase() : '0x000000'
}

function luminanciaHex(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim())
  if (!m) return 0.5
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

// rgba(r,g,b,a) ou hex -> "0xrrggbb@alpha"
function corParaFfmpeg(c) {
  if (!c) return '0x000000@1'
  const m = /rgba?\(([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,?\s*([\d.]*)\s*\)/.exec(String(c))
  if (m) {
    const r = Math.round(Number(m[1])).toString(16).padStart(2, '0')
    const g = Math.round(Number(m[2])).toString(16).padStart(2, '0')
    const b = Math.round(Number(m[3])).toString(16).padStart(2, '0')
    const a = m[4] ? Number(m[4]) : 1
    return `0x${r}${g}${b}@${a}`
  }
  return hex(c) + '@1'
}

// escapa valores dentro de filter_complex (: , ; [ ] ' \)
function escF(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/'/g, "\\'")
}

function quebrarLinhas(texto, maxChars) {
  const palavras = String(texto || '').split(' ')
  const linhas = []
  let linha = ''
  for (const p of palavras) {
    const teste = linha ? `${linha} ${p}` : p
    if (teste.length > maxChars && linha) {
      linhas.push(linha)
      linha = p
    } else {
      linha = teste
    }
  }
  if (linha) linhas.push(linha)
  return linhas
}

async function baixar(url, destino) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Falha ao baixar ${url.slice(0, 80)} (HTTP ${r.status})`)
  const buf = Buffer.from(await r.arrayBuffer())
  await fs.writeFile(destino, buf)
  return destino
}

function base64ParaArquivo(dataUrl, destino) {
  const b64 = String(dataUrl || '').split(',')[1] || dataUrl
  return fs.writeFile(destino, Buffer.from(b64, 'base64'))
}

async function duracaoAudio(arquivo) {
  try {
    const { stderr } = await execFileP(ffmpegBin, ['-i', arquivo, '-f', 'null', '-'])
    const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(stderr)
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  } catch {}
  return 0
}

function montarMotion(zoomNome, durFrames, i) {
  const zmax = zoomNome === 'rapido' ? 0.18 : zoomNome === 'lento' ? 0.06 : 0.12
  const centro = {
    x: 'iw/2-(iw/zoom/2)',
    y: 'ih/2-(ih/zoom/2)',
  }
  const D = Math.max(1, durFrames - 1)
  const ciclo = ['in', 'out', 'pan-r', 'pan-l', 'in', 'pan-u', 'pan-d']
  const modo = ciclo[i % ciclo.length]
  if (modo === 'out') {
    return { z: `max(1.5-${zmax}*on/${D},1)`, ...centro }
  }
  if (modo === 'pan-r') {
    return { z: '1.35', x: `(iw-iw/zoom)*(on/${D})`, y: centro.y }
  }
  if (modo === 'pan-l') {
    return { z: '1.35', x: `(iw-iw/zoom)*(1-on/${D})`, y: centro.y }
  }
  if (modo === 'pan-u') {
    return { z: '1.35', x: centro.x, y: `(ih-ih/zoom)*(1-on/${D})` }
  }
  if (modo === 'pan-d') {
    return { z: '1.35', x: centro.x, y: `(ih-ih/zoom)*(on/${D})` }
  }
  return { z: `min(1+${zmax}*on/${D},1.5)`, ...centro }
}

const TRANSICOES = {
  fade: 'fade',
  slide: 'slideleft',
  wipe: 'wipeleft',
  circle: 'circleopen',
  dissolve: 'dissolve',
}

const FILTROS = {
  cinema: 'curves=preset=medium_contrast,eq=contrast=1.08:saturation=0.88:brightness=0.015,vignette=PI/5',
  vibrante: 'eq=saturation=1.35:contrast=1.12:brightness=0.02',
  quente: 'colorbalance=rs=0.07:ms=0.03:bs=-0.06',
  frio: 'colorbalance=rs=-0.06:ms=-0.03:bs=0.08',
}

export async function renderProjeto(body, { onProgress } = {}) {
  const { projeto, userJwt, tokenUrl } = body || {}
  if (!projeto) throw new Error('projeto obrigatório')
  if (!userJwt || !tokenUrl) throw new Error('userJwt e tokenUrl obrigatórios')

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klv-render-'))
  const limpar = () => fs.rm(tmp, { recursive: true, force: true }).catch(() => {})

  try {
    // 1) Token do Drive
    let accessToken = null
    if (!body.skipUpload) {
      const tr = await fetch(tokenUrl, { headers: { Authorization: `Bearer ${userJwt}` } })
      const td = await tr.json()
      if (!td.accessToken) throw new Error(td.error || 'Não foi possível obter token do Google Drive')
      accessToken = td.accessToken
    }

    // 2) Resolução
    const fmt = FORMATOS[projeto.formato] || FORMATOS['9:16']
    const W = fmt.w
    const H = fmt.h

    // 3) Modelo / estilos
    const m = projeto.modelo || {}
    const zoom = m.zoom === 'rapido' || m.zoom === 'lento' ? m.zoom : 'suave'
    const letterbox = !!m.letterbox
    const progressBar = !!m.progressBar
    const barraTitulo = m.barraTitulo !== false
    const tituloSize = m.tituloSize || 50
    const subSize = m.subSize || 32
    const textoSize = m.textoSize || 36
    const textoPeso = m.textoPeso || 600
    const modo = projeto.modo === 'caber' ? 'caber' : 'cobrir'
    const segundosFoto = Math.max(1, Number(projeto.segundosFoto) || 3)

    // 4) Baixar mídias
    const mediaTracks = Array.isArray(projeto.mediaTracks) && projeto.mediaTracks.length ? projeto.mediaTracks : null
    const fotos = mediaTracks ? mediaTracks.map((t) => t.url) : projeto.fotos || []
    if (fotos.length === 0) throw new Error('Nenhuma foto para renderizar')
    const arqFotos = []
    for (let i = 0; i < fotos.length; i++) {
      arqFotos.push(await baixar(fotos[i], path.join(tmp, `foto${i}.jpg`)))
    }
    const durs = mediaTracks ? mediaTracks.map((t) => Math.max(1, (Number(t.endSecond) || 0) - (Number(t.startSecond) || 0))) : null

    let arqNarr = null
    let arqMus = null
    if (projeto.narracaoAudio) arqNarr = path.join(tmp, 'narr.mp3')
    if (projeto.musicaAudio) arqMus = path.join(tmp, 'musica.mp3')
    if (arqNarr) await base64ParaArquivo(projeto.narracaoAudio, arqNarr)
    if (arqMus) await base64ParaArquivo(projeto.musicaAudio, arqMus)

    const overlays = Array.isArray(projeto.overlays) ? projeto.overlays : []
    const arqOverlays = []
    for (let i = 0; i < overlays.length; i++) {
      const o = overlays[i]
      if (!o || !o.url) continue
      arqOverlays.push({ ...o, arquivo: await baixar(o.url, path.join(tmp, `ovl${i}.png`)) })
    }

    const narrDur = arqNarr ? await duracaoAudio(arqNarr) : 0
    const musDur = arqMus ? await duracaoAudio(arqMus) : 0

    // 5) Duração total
    const tituloDur = projeto.tituloSlide !== false ? TITULO_DUR : 0
    const n = fotos.length

    // 6) Fontes
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const fonteNormal = path.join(dir, 'fonts', 'DejaVuSans.ttf').replace(/\\/g, '/')
    const fonteBold = path.join(dir, 'fonts', 'DejaVuSans-Bold.ttf').replace(/\\/g, '/')

    // 7) Áudio
    const inputs = []
    for (const f of arqFotos) inputs.push('-i', f)
    for (const o of arqOverlays) inputs.push('-i', o.arquivo)
    if (arqNarr) inputs.push('-i', arqNarr)
    if (arqMus) inputs.push('-i', arqMus)

    const fc = []
    let idxNarr = -1
    let idxMus = -1
    const ovlBase = n + arqOverlays.length
    if (arqNarr) idxNarr = ovlBase
    if (arqMus) idxMus = ovlBase + (arqNarr ? 1 : 0)

    // --- Slide de título ---
    if (tituloDur > 0) {
      const c0 = hex(m.grad?.[0] || '#0f172a')
      const c1 = hex(m.grad?.[1] || '#334155')
      if (usaGradientes) {
        fc.push(`gradients=s=${W}x${H}:c0=${c0}:c1=${c1}:d=${tituloDur}:r=${FPS}[gt0]`)
      } else {
        fc.push(`color=c=${c0}:s=${W}x${H}:d=${tituloDur}:r=${FPS}[gt0]`)
      }

      const lumTitulo = (luminanciaHex(m.grad?.[0] || '#0f172a') + luminanciaHex(m.grad?.[1] || '#334155')) / 2
      const tituloEscuro = lumTitulo > 0.6
      const corTitulo = tituloEscuro ? '0x0f172a' : 'white'
      const corSubT = m.subCor ? corParaFfmpeg(m.subCor) : corParaFfmpeg(tituloEscuro ? '#475569' : '#cbd5e1')

      const titleFilters = []
      const titulo = projeto.titulo
      if (titulo) {
        const linhas = quebrarLinhas(titulo, Math.floor((W - 120) / (tituloSize * 0.62)))
        const lh = tituloSize * 1.35
        const startY = H / 2 - (linhas.length * lh) / 2
        titleFilters.push(
          `drawtext=fontfile=${escF(fonteBold)}:text=${escF(linhas.join('\n'))}:fontsize=${tituloSize}:fontcolor=${corTitulo}:line_spacing=${Math.round(lh)}:x=(w-text_w)/2:y='${Math.round(startY)} + (1-min(1,t/0.5))*40':alpha='min(1,t/0.5)'`
        )
        if (barraTitulo) {
          const bl = Math.min(220, W * 0.5)
          titleFilters.push(
            `drawbox=x=${Math.round(W / 2 - bl / 2)}:y=${Math.round(startY + linhas.length * lh + 24)}:w=${Math.round(bl)}:h=6:color=${corParaFfmpeg(m.accent)}:t=fill`
          )
        }
        if (projeto.subtitulo) {
          const subY = startY + linhas.length * lh + (barraTitulo ? 66 : 44)
          titleFilters.push(
            `drawtext=fontfile=${escF(fonteNormal)}:text=${escF(String(projeto.subtitulo))}:fontsize=${subSize}:fontcolor=${corSubT}:x=(w-text_w)/2:y='${Math.round(subY)} + (1-min(1,t/0.7))*30':alpha='min(1,(t-0.12)/0.55)'`
          )
        }
      }
      fc.push('[gt0]' + (titleFilters.length ? titleFilters.join(',') + ',' : '') + `settb=AVTB,format=yuv420p[titlev]`)
    }

    // --- Fotos com movimento (Ken Burns variado) ---
    for (let i = 0; i < n; i++) {
      const durFoto = durs ? durs[i] : segundosFoto
      const durFrames = Math.round(durFoto * FPS)
      const escala = modo === 'cobrir' ? 'increase' : 'decrease'
      const mot = montarMotion(zoom, durFrames, i)
      let chain = `[${i}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=${escala},setsar=1`
      if (modo === 'caber') chain += `,pad=${W * 2}:${H * 2}:(ow-iw)/2:(oh-ih)/2:black`
      chain += `,crop=${W}:${H},zoompan=z='${mot.z}':x='${mot.x}':y='${mot.y}':d=${durFrames}:s=${W}x${H}:fps=${FPS},trim=duration=${durFoto},setpts=PTS-STARTPTS,fps=${FPS},settb=AVTB,format=yuv420p[v${i}]`
      fc.push(chain)
    }

    // --- Transições (xfade) ---
    const D = FADE
    const trans = TRANSICOES[m.transicao] || 'fade'
    const segs = []
    if (tituloDur > 0) segs.push({ lbl: 'titlev', dur: tituloDur })
    for (let i = 0; i < n; i++) segs.push({ lbl: `v${i}`, dur: durs ? durs[i] : segundosFoto })

    let labelAtual = segs[0].lbl
    let O = segs[0].dur
    let xcount = 0
    for (let k = 1; k < segs.length; k++) {
      const s = segs[k]
      const offset = O - D
      const out = `xf${xcount}`
      fc.push(`[${labelAtual}][${s.lbl}]xfade=transition=${trans}:duration=${D}:offset=${offset}[${out}]`)
      labelAtual = out
      O = offset + s.dur
      xcount++
    }
    const totalVideo = O
    const total = Math.max(totalVideo, narrDur > 0 ? narrDur + 1 : 0, musDur)

    // --- Decorações sobre o vídeo todo ---
    const decoChain = []
    if (letterbox) {
      const barraH = Math.round(H * 0.13)
      decoChain.push(`drawbox=x=0:y=0:w=${W}:h=${barraH}:color=black:t=fill`)
      decoChain.push(`drawbox=x=0:y=${H - barraH}:w=${W}:h=${barraH}:color=black:t=fill`)
    }

    function montarCaption(texto, start, end, fadeDur = 0.35) {
      if (!texto) return []
      const pad = 24
      const lh = Math.round(textoSize * 1.3)
      const linhas = quebrarLinhas(texto, Math.floor((W - 90) / (textoSize * 0.62)))
      const boxH = linhas.length * lh + pad * 2
      let boxY
      if (letterbox) {
        const barraH = Math.round(H * 0.13)
        boxY = H - barraH + Math.round((barraH - boxH) / 2)
      } else {
        boxY = H - boxH - 46
      }
      const en = `enable='between(t,${start},${end})'`
      const alpha = `alpha='if(lt(t,${start + fadeDur}),0,min(1,(t-${start})/${fadeDur}))'`
      const baseY = Math.round(boxY + pad + textoSize * 0.36)
      const yExpr = `'${baseY} + (1-min(1,(t-${start})/${fadeDur}))*36'`
      const borda = m.bordaTexto
        ? `:borderw=${Number(m.bordaTamanho) || 3}:bordercolor=${corParaFfmpeg(m.bordaCor || '#000000')}`
        : ''
      const sombra = m.sombraTexto
        ? `:shadowcolor=${corParaFfmpeg(m.sombraCor || '#000000')}:shadowx=${Number(m.sombraDesloc) || 2}:shadowy=${Number(m.sombraDesloc) || 2}`
        : ''
      const captionBg = m.captionBg || 'rgba(0,0,0,0.7)'
      const captionBgHex = /^#?[0-9a-f]{6}$/i.test(String(captionBg).trim()) ? String(captionBg).trim() : null
      const lumBg = captionBgHex ? luminanciaHex(captionBgHex) : 0
      const captionCor = m.captionCor ? corParaFfmpeg(m.captionCor) : corParaFfmpeg(lumBg > 0.6 ? '#0f172a' : '#ffffff')
      return [
        `drawbox=x=45:y=${boxY}:w=${W - 90}:h=${boxH}:color=${corParaFfmpeg(captionBg)}:t=fill:${en}`,
        `drawtext=fontfile=${escF(fonteBold)}:text=${escF(linhas.join('\n'))}:fontsize=${textoSize}:fontcolor=${captionCor}:line_spacing=${lh}:x=(w-text_w)/2:y=${yExpr}${borda}${sombra}:${alpha}:${en}`,
      ]
    }

    if (projeto.mostrarTexto !== false) {
      const slides = Array.isArray(projeto.slides) ? projeto.slides : []
      if (slides.length > 0) {
        const passo = segundosFoto - D
        for (let i = 0; i < n; i++) {
          const start = tituloDur + i * passo
          const end = i < n - 1 ? tituloDur + (i + 1) * passo : total
          decoChain.push(...montarCaption(slides[i] || '', start, end))
        }
      } else if (projeto.legenda) {
        decoChain.push(...montarCaption(projeto.legenda, tituloDur, total))
      }
    }
    // Trilha de textos (timeline) — posição, animação e horário livres
    const textTracks = Array.isArray(projeto.textTracks) ? projeto.textTracks : []
    for (const tt of textTracks) {
      if (!tt || !tt.content) continue
      const start = Math.max(0, Number(tt.startSecond) || 0)
      const end = tt.endSecond != null ? Number(tt.endSecond) : total
      if (end <= start) continue
      const x = tt.x != null ? Math.max(0, Math.min(1, Number(tt.x))) : 0.5
      const y = tt.y != null ? Math.max(0, Math.min(1, Number(tt.y))) : 0.5
      const size = Math.max(24, Math.round(W * 0.06))
      const fade = 0.4
      const linhas = quebrarLinhas(tt.content, Math.floor((W * 0.9) / (size * 0.62)))
      const lh = Math.round(size * 1.25)
      const alpha = `alpha='if(lt(t,${start}),0,if(lt(t,${start + fade}),(t-${start})/${fade},if(gt(t,${end - fade}),max(0,(${end}-t)/${fade}),1)))'`
      const slide = tt.animation === 'slide-up' ? `+(1-min(1,(t-${start})/${fade}))*40` : ''
      const en = `enable='between(t,${start},${end})'`
      decoChain.push(
        `drawtext=fontfile=${escF(fonteBold)}:text=${escF(linhas.join('\n'))}:fontsize=${size}:fontcolor=white:borderw=3:bordercolor=black@0.9:shadowcolor=black@0.7:shadowx=3:shadowy=3:line_spacing=${lh}:x='(w-text_w)*${x}':y='(h-text_h)*${y}${slide}':${alpha}:${en}`
      )
    }

    if (progressBar) {
      const pbH = 8
      decoChain.push(`drawbox=x=0:y=${H - pbH}:w=${W}:h=${pbH}:color=white@0.25:t=fill`)
      decoChain.push(`drawbox=x=0:y=${H - pbH}:w='in_w*t/${total}':h=${pbH}:color=${corParaFfmpeg(m.accent)}:t=fill`)
    }
    const filtro = FILTROS[m.filtro] || ''
    const fechamento = `fade=t=out:st=${Math.max(0, total - 0.6)}:d=0.6`
    const meio = [filtro, fechamento, ...decoChain].filter(Boolean).join(',')
    fc.push(`[${labelAtual}]${meio ? meio + ',' : ''}format=yuv420p[finalv]`)

    // --- Overlays (stickers/logo) ---
    let labelFinal = 'finalv'
    for (let i = 0; i < arqOverlays.length; i++) {
      const o = arqOverlays[i]
      const ow = Math.max(40, Math.round((o.w || 0.3) * W))
      const oh = o.h ? Math.round(o.h * H) : -2
      const opac = o.opacidade ? `,colorchannelmixer=aa=${Number(o.opacidade)}` : ''
      fc.push(`[${n + i}:v]scale=${ow}:${oh},format=rgba${opac}[ov${i}]`)
      const fim = o.fim != null ? Number(o.fim) : total
      fc.push(`[${labelFinal}][ov${i}]overlay=x=${Math.round((o.x || 0.5) * W)}:y=${Math.round((o.y || 0.5) * H)}:enable='between(t,${Number(o.inicio) || 0},${fim})'[of${i}]`)
      labelFinal = `of${i}`
    }

    // --- Áudio ---
    const mapArgs = ['-map', `[${labelFinal}]`]
    let audioGraph = null
    if (arqNarr && arqMus) {
      fc.push(`[${idxNarr}:a]atrim=0:${total},asetpts=PTS-STARTPTS,apad,volume=1[na]`)
      fc.push(`[${idxMus}:a]atrim=0:${total},asetpts=PTS-STARTPTS,volume=${Number(projeto.volumeMusica) || 0.2}[ma]`)
      fc.push(`[na][ma]amix=inputs=2:duration=longest:normalize=0[aud]`)
      audioGraph = '[aud]'
    } else if (arqNarr) {
      fc.push(`[${idxNarr}:a]atrim=0:${total},asetpts=PTS-STARTPTS,apad[aud]`)
      audioGraph = '[aud]'
    } else if (arqMus) {
      fc.push(`[${idxMus}:a]atrim=0:${total},asetpts=PTS-STARTPTS,volume=${Number(projeto.volumeMusica) || 0.2}[aud]`)
      audioGraph = '[aud]'
    }
    if (audioGraph) {
      mapArgs.push('-map', audioGraph)
      mapArgs.push('-c:a', 'aac', '-b:a', '128k')
    }

    // --- Renderiza ---
    const saida = path.join(tmp, 'final.mp4')
    const filterArg = fc.join(';')
    const args = [
      ...inputs,
      '-filter_complex', filterArg,
      ...mapArgs,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-maxrate', '8M',
      '-bufsize', '16M',
      '-r', String(FPS),
      '-t', String(total),
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y',
      saida,
    ]

    onProgress?.({ segundos: 0, duracao: total })
    const { stderr } = await executarFfmpeg(args, (info) => onProgress?.({ ...info, duracao: total }))
    const ultima = (stderr || '').split('\n').filter((l) => l.includes('frame=')).pop() || ''

    // --- Envia pro Drive ---
    const buf = await fs.readFile(saida)
    const nome = `reels-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}.mp4`
    if (body.skipUpload) {
      const copia = path.join(process.cwd(), 'tmp', 'final.mp4')
      await fs.mkdir(path.dirname(copia), { recursive: true })
      await fs.writeFile(copia, buf)
      await limpar()
      return { ok: true, skipUpload: true, localPath: copia, tamanho: buf.length, duracao: total }
    }
    const up = await salvarVideoNoDrive(accessToken, { buffer: buf, nome })

    await limpar()
    return { ok: true, ...up, tamanho: buf.length, duracao: total, log: ultima.trim().slice(0, 200) }
  } catch (err) {
    await limpar()
    throw err
  }
}