import { renderProjeto } from './render.js'

const r = await renderProjeto({
  skipUpload: true,
  userJwt: 'fake',
  tokenUrl: 'http://localhost:8787/health',
  projeto: {
    formato: '9:16',
    modo: 'cobrir',
    segundosFoto: 3,
    tituloSlide: true,
    titulo: 'Proteja seu negocio',
    subtitulo: 'CFTV profissional em São Paulo',
    legenda: 'Instalação de CFTV em condomínio com câmeras de alta resolução, DVR com acesso remoto e garantia de 1 ano. Chame um especialista hoje mesmo.',
    fotos: ['https://picsum.photos/800/1200', 'https://picsum.photos/800/1200?random=2'],
    modelo: {
      grad: ['#0f172a', '#334155'],
      accent: '#3b82f6',
      tituloSize: 50,
      subSize: 32,
      subCor: '#cbd5e1',
      textoSize: 36,
      textoPeso: 600,
      captionBg: 'rgba(15,23,42,0.78)',
      captionCor: '#ffffff',
      zoom: 'suave',
      letterbox: false,
      progressBar: false,
      barraTitulo: true,
    },
  },
})

console.log(JSON.stringify(r, null, 2))