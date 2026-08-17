import { execFile } from 'child_process'
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
    const { stderr } = await execFileP(ffmpegPath, ['-i', arquivo, '-f', 'null', '-'])
    const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(stderr)
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  } catch {}
  return 0
}

function montarZ(zoomNome, durFrames) {
  const zmax = zoomNome === 'rapido' ? 0.18 : zoomNome === 'lento' ? 0.06 : 0.12
  return `min(1+${zmax}*on/${Math.max(1, durFrames - 1)},1.5)`
}

export async function renderProjeto(body) {
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
    const fotos = projeto.fotos || []
    if (fotos.length === 0) throw new Error('Nenhuma foto para renderizar')
    const arqFotos = []
    for (let i = 0; i < fotos.length; i++) {
      arqFotos.push(await baixar(fotos[i], path.join(tmp, `foto${i}.jpg`)))
    }

    let arqNarr = null
    let arqMus = null
    if (projeto.narracaoAudio) arqNarr = path.join(tmp, 'narr.mp3')
    if (projeto.musicaAudio) arqMus = path.join(tmp, 'musica.mp3')
    if (arqNarr) await base64ParaArquivo(projeto.narracaoAudio, arqNarr)
    if (arqMus) await base64ParaArquivo(projeto.musicaAudio, arqMus)

    const narrDur = arqNarr ? await duracaoAudio(arqNarr) : 0
    const musDur = arqMus ? await duracaoAudio(arqMus) : 0

    // 5) Duração total
    const tituloDur = projeto.tituloSlide !== false ? TITULO_DUR : 0
    const n = fotos.length
    const base = tituloDur + n * segundosFoto
    const total = Math.max(base, narrDur > 0 ? narrDur + 1 : 0, musDur)

    // 6) Fontes
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const fonteNormal = path.join(dir, 'fonts', 'DejaVuSans.ttf').replace(/\\/g, '/')
    const fonteBold = path.join(dir, 'fonts', 'DejaVuSans-Bold.ttf').replace(/\\/g, '/')

    // 7) Áudio
    const inputs = []
    for (const f of arqFotos) inputs.push('-i', f)
    if (arqNarr) inputs.push('-i', arqNarr)
    if (arqMus) inputs.push('-i', arqMus)

    const fc = []
    const mapaV = []
    let idxNarr = -1
    let idxMus = -1
    if (arqNarr) idxNarr = n
    if (arqMus) idxMus = n + (arqNarr ? 1 : 0)

    // --- Slide de título ---
    if (tituloDur > 0) {
      const c0 = hex(m.grad?.[0] || '#0f172a')
      const c1 = hex(m.grad?.[1] || '#334155')
      fc.push(`gradients=s=${W}x${H}:c0=${c0}:c1=${c1}:d=${tituloDur}:r=${FPS}[gt0]`)

      const titleFilters = []
      const titulo = projeto.titulo
      if (titulo) {
        const linhas = quebrarLinhas(titulo, Math.floor((W - 120) / (tituloSize * 0.62)))
        const lh = tituloSize * 1.35
        const startY = H / 2 - (linhas.length * lh) / 2
        titleFilters.push(
          `drawtext=fontfile=${escF(fonteBold)}:text=${escF(linhas.join('\n'))}:fontsize=${tituloSize}:fontcolor=white:line_spacing=${Math.round(lh)}:x=(w-text_w)/2:y=${Math.round(startY)}`
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
            `drawtext=fontfile=${escF(fonteNormal)}:text=${escF(String(projeto.subtitulo))}:fontsize=${subSize}:fontcolor=${corParaFfmpeg(m.subCor || '#cbd5e1')}:x=(w-text_w)/2:y=${Math.round(subY)}`
          )
        }
      }
      fc.push('[gt0]' + (titleFilters.length ? titleFilters.join(',') + ',' : '') + `fade=t=out:st=${Math.max(0, tituloDur - 0.5)}:d=0.5,format=yuv420p[titlev]`)
      mapaV.push('[titlev]')
    }

    // --- Fotos com zoom ---
    const durFrames = Math.round(segundosFoto * FPS)
    const fadeIn = 0.35
    const fadeOut = 0.35
    for (let i = 0; i < n; i++) {
      const escala = modo === 'cobrir' ? 'increase' : 'decrease'
      let chain = `[${i}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=${escala},setsar=1`
      if (modo === 'caber') chain += `,pad=${W * 2}:${H * 2}:(ow-iw)/2:(oh-ih)/2:black`
      chain += `,crop=${W}:${H},zoompan=z='${montarZ(zoom, durFrames)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${durFrames}:s=${W}x${H}:fps=${FPS},trim=duration=${segundosFoto},setpts=PTS-STARTPTS,fade=t=in:st=0:d=${fadeIn},fade=t=out:st=${Math.max(0, segundosFoto - fadeOut)}:d=${fadeOut},format=yuv420p[v${i}]`
      fc.push(chain)
      mapaV.push(`[v${i}]`)
    }

    // --- Concat ---
    fc.push(`${mapaV.join('')}concat=n=${mapaV.length}:v=1:a=0[allv]`)

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
      return [
        `drawbox=x=45:y=${boxY}:w=${W - 90}:h=${boxH}:color=${corParaFfmpeg(m.captionBg || 'rgba(0,0,0,0.7)')}:t=fill:${en}`,
        `drawtext=fontfile=${escF(fonteBold)}:text=${escF(linhas.join('\n'))}:fontsize=${textoSize}:fontcolor=${corParaFfmpeg(m.captionCor || '#ffffff')}:line_spacing=${lh}:x=(w-text_w)/2:y=${Math.round(boxY + pad + textoSize * 0.36)}:${alpha}:${en}`,
      ]
    }

    if (projeto.mostrarTexto !== false) {
      const slides = Array.isArray(projeto.slides) ? projeto.slides : []
      if (slides.length > 0) {
        for (let i = 0; i < n; i++) {
          const start = tituloDur + i * segundosFoto
          const end = start + segundosFoto
          decoChain.push(...montarCaption(slides[i] || '', start, end))
        }
      } else if (projeto.legenda) {
        decoChain.push(...montarCaption(projeto.legenda, tituloDur, total))
      }
    }
    if (progressBar) {
      const pbH = 8
      decoChain.push(`drawbox=x=0:y=${H - pbH}:w=${W}:h=${pbH}:color=white@0.25:t=fill`)
      decoChain.push(`drawbox=x=0:y=${H - pbH}:w='in_w*t/${total}':h=${pbH}:color=${corParaFfmpeg(m.accent)}:t=fill`)
    }
    fc.push('[allv]' + (decoChain.length ? decoChain.join(',') + ',' : '') + 'format=yuv420p[finalv]')

    // --- Áudio ---
    const mapArgs = ['-map', '[finalv]']
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
      '-preset', 'medium',
      '-crf', '20',
      '-r', String(FPS),
      '-t', String(total),
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y',
      saida,
    ]

    const { stderr } = await execFileP(ffmpegPath, args, { maxBuffer: 50 * 1024 * 1024 })
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