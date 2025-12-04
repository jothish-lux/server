const startQrBtn = document.getElementById('startQr')
const qrArea = document.getElementById('qrArea')
const qrImg = document.getElementById('qrImg')
const qrStatus = document.getElementById('qrStatus')

const startPairBtn = document.getElementById('startPair')
const phoneInput = document.getElementById('phoneInput')
const pairArea = document.getElementById('pairArea')
const pairStatus = document.getElementById('pairStatus')
const pairCodeEl = document.getElementById('pairCode')

const sessionStatus = document.getElementById('sessionStatus')
const sessionCodeEl = document.getElementById('sessionCode')
const copyBtn = document.getElementById('copyBtn')

let currentSessionId = null
let pollInterval = null
let currentShortCode = null

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return res.json()
}

function startPollingResult(sessionId) {
  if (!sessionId) return
  if (pollInterval) clearInterval(pollInterval)

  currentSessionId = sessionId
  sessionStatus.textContent = 'Waiting for session...'
  sessionCodeEl.textContent = ''
  copyBtn.classList.add('hidden')
  currentShortCode = null

  pollInterval = setInterval(async () => {
    try {
      const data = await fetchJson(`/api/session/result/${currentSessionId}`)
      // IMPORTANT: backend returns { code: "LUX~xxxx" }
      if (data.ready && data.code) {
        clearInterval(pollInterval)
        pollInterval = null

        currentShortCode = data.code
        sessionStatus.textContent = 'Session ready. Use this LUX code:'
        sessionCodeEl.textContent = data.code
        copyBtn.classList.remove('hidden')
      }
    } catch (err) {
      console.error('Error polling session result:', err)
    }
  }, 3000)
}

startQrBtn.addEventListener('click', async () => {
  sessionStatus.textContent = 'Waiting for session...'
  sessionCodeEl.textContent = ''
  copyBtn.classList.add('hidden')
  currentShortCode = null

  try {
    const data = await fetchJson('/api/session/qr')
    currentSessionId = data.sessionId

    qrArea.classList.remove('hidden')
    qrImg.src = data.qr
    qrStatus.textContent = 'Scan this QR in WhatsApp (Linked Devices).'

    startPollingResult(currentSessionId)
  } catch (err) {
    console.error(err)
    qrArea.classList.remove('hidden')
    qrStatus.textContent = 'Failed to generate QR.'
  }
})

startPairBtn.addEventListener('click', async () => {
  const phoneRaw = (phoneInput.value || '').trim()
  const phone = phoneRaw.replace(/[^\d]/g, '')

  if (!/^\d{8,15}$/.test(phone)) {
    pairArea.classList.remove('hidden')
    pairStatus.textContent = 'Enter a valid phone number (8–15 digits).'
    pairCodeEl.textContent = ''
    return
  }

  pairArea.classList.remove('hidden')
  pairStatus.textContent = 'Requesting pair code...'
  pairCodeEl.textContent = ''

  try {
    const data = await fetchJson(`/api/session/pair?phone=${encodeURIComponent(phone)}`)
    // data = { sessionId, phone, code, status }
    currentSessionId = data.sessionId
    pairStatus.textContent = 'Enter this code in WhatsApp (Link with phone).'
    pairCodeEl.textContent = data.code || '(no code returned)'

    startPollingResult(currentSessionId)
  } catch (err) {
    console.error(err)
    pairStatus.textContent = 'Failed to get pair code.'
    pairCodeEl.textContent = ''
  }
})

copyBtn.addEventListener('click', async () => {
  const text = currentShortCode || sessionCodeEl.textContent.trim()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copyBtn.textContent = 'Copied!'
    setTimeout(() => (copyBtn.textContent = 'Copy Short Code'), 1500)
  } catch (err) {
    console.error('Clipboard error:', err)
  }
})
