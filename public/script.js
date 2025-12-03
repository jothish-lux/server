const apiBase = '/api'

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return res.json()
}

function startPollingSession(sessionId, textareaId, statusId) {
  const textarea = document.getElementById(textareaId)
  const statusEl = document.getElementById(statusId)

  if (!sessionId) return

  statusEl.textContent = 'STATUS: Waiting for WhatsApp to connect...'

  const interval = setInterval(async () => {
    try {
      const data = await fetchJson(`${apiBase}/session/result/${encodeURIComponent(sessionId)}`)

      if (data.ready && data.session) {
        textarea.value = data.session
        statusEl.textContent = 'STATUS: SESSION_ID ready 🎉'
        clearInterval(interval)
      }
    } catch (err) {
      console.error(err)
      statusEl.textContent = 'STATUS: Error while polling session'
      clearInterval(interval)
    }
  }, 3000) // poll every 3 seconds
}

document.getElementById('btn-qr').addEventListener('click', async () => {
  const img = document.getElementById('qr-img')
  const idSpan = document.getElementById('qr-session-id')
  const statusEl = document.getElementById('qr-status')
  const textarea = document.getElementById('qr-session-string')

  img.src = ''
  idSpan.textContent = 'Loading...'
  statusEl.textContent = 'STATUS: Requesting QR...'
  textarea.value = ''

  try {
    const data = await fetchJson(`${apiBase}/session/qr`)
    if (data.qr) {
      img.src = data.qr
    }
    idSpan.textContent = data.sessionId || '(no session id)'
    statusEl.textContent = 'STATUS: Scan the QR with WhatsApp'
    if (data.sessionId) {
      startPollingSession(data.sessionId, 'qr-session-string', 'qr-status')
    }
  } catch (err) {
    console.error(err)
    idSpan.textContent = 'Error'
    statusEl.textContent = 'STATUS: ' + err.message
  }
})

document.getElementById('btn-pair').addEventListener('click', async () => {
  const phoneInput = document.getElementById('pair-phone')
  const idSpan = document.getElementById('pair-session-id')
  const codeSpan = document.getElementById('pair-code')
  const statusEl = document.getElementById('pair-status')
  const textarea = document.getElementById('pair-session-string')

  const phone = phoneInput.value.trim()
  if (!phone) {
    idSpan.textContent = 'Error'
    codeSpan.textContent = 'Phone is empty'
    statusEl.textContent = 'STATUS: Enter a phone number first'
    return
  }

  idSpan.textContent = 'Loading...'
  codeSpan.textContent = 'Loading...'
  statusEl.textContent = 'STATUS: Requesting pair code...'
  textarea.value = ''

  try {
    const data = await fetchJson(
      `${apiBase}/session/pair?phone=${encodeURIComponent(phone)}`
    )
    idSpan.textContent = data.sessionId || '(no session id)'
    codeSpan.textContent = data.code || '(no code)'
    statusEl.textContent = 'STATUS: Enter this code on your phone'
    if (data.sessionId) {
      startPollingSession(data.sessionId, 'pair-session-string', 'pair-status')
    }
  } catch (err) {
    console.error(err)
    idSpan.textContent = 'Error'
    codeSpan.textContent = err.message
    statusEl.textContent = 'STATUS: Error while requesting pair code'
  }
})
