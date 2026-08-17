const ROOT = 'KLV MARKETING'

export async function driveFetch(accessToken, url, opts = {}) {
  const headers = { Authorization: `Bearer ${accessToken}`, ...(opts.headers || {}) }
  return fetch(url, { ...opts, headers })
}

export async function ensureFolder(accessToken, pathParts, parentId) {
  let cur = parentId || 'root'
  for (const name of pathParts) {
    const q = `name='${String(name).replace(/'/g, "\\'")}' and '${cur}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    const r = await driveFetch(
      accessToken,
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`
    )
    const d = await r.json()
    const found = d.files && d.files[0]
    if (found) {
      cur = found.id
      continue
    }
    const c = await driveFetch(accessToken, 'https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [cur] }),
    })
    const cd = await c.json()
    if (!cd.id) throw new Error('Falha ao criar pasta no Drive')
    cur = cd.id
  }
  return cur
}

export async function makePublic(accessToken, fileId) {
  await driveFetch(accessToken, `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  }).catch(() => {})
}

export async function uploadBuffer(accessToken, { name, mimeType, parents, buffer }) {
  const boundary = 'klv' + Date.now().toString(36) + Math.random().toString(36).slice(2)
  const meta = JSON.stringify({ name, mimeType, parents })
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  )
  const post = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Buffer.concat([pre, buffer, post])
  const r = await driveFetch(
    accessToken,
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }
  )
  const d = await r.json()
  if (!d.id) throw new Error('Upload falhou: ' + JSON.stringify(d).slice(0, 200))
  return d
}

export async function salvarVideoNoDrive(accessToken, { buffer, nome, mime = 'video/mp4' }) {
  const pasta = await ensureFolder(accessToken, [ROOT, 'Videos'])
  const up = await uploadBuffer(accessToken, { name: nome, mimeType: mime, parents: [pasta], buffer })
  await makePublic(accessToken, up.id)
  return { id: up.id, link: `https://drive.google.com/file/d/${up.id}/view` }
}