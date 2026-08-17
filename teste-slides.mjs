import { renderProjeto } from './render.js'

const r = await renderProjeto({
  skipUpload: true,
  userJwt: 'fake',
  tokenUrl: 'http://x',
  projeto: {
    formato: '9:16',
    modo: 'cobrir',
    segundosFoto: 4,
    tituloSlide: true,
    titulo: 'Proteja seu negocio',
    subtitulo: 'Segurança que funciona',
    legenda: 'Instalação rápida com garantia e suporte.',
    slides: ['Câmeras de alta resolução 24h', 'DVR com acesso pelo celular', 'Alarme integrado e monitoramento'],
    fotos: ['https://picsum.photos/800/1200', 'https://picsum.photos/800/1200?random=2', 'https://picsum.photos/800/1200?random=3'],
    mostrarTexto: true,
    modelo: {
      grad: ['#111827', '#374151'],
      accent: '#f59e0b',
      tituloSize: 58,
      subSize: 34,
      subCor: '#fbbf24',
      textoSize: 46,
      textoPeso: 900,
      captionBg: 'rgba(17,24,39,0.82)',
      captionCor: '#ffffff',
      zoom: 'rapido',
      letterbox: false,
      progressBar: true,
      barraTitulo: true,
    },
  },
})

console.log(JSON.stringify(r, null, 2))