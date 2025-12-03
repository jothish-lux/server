// server.js — LUX WhatsApp session generator with QR ON PAGE
// CommonJS + Baileys useMultiFileAuthState

const express = require('express')
const cors = require('cors')
const pino = require('pino')
const fs = require('fs')
const path = require('path')

const baileys = require('@whiskeysockets/baileys')
const makeWASocket = baileys.default
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = baileys

const app = express()
const logger = pino({ level: 'info' })

app.use(cors())
app.use(express.json())

// Where Baileys stores auth
const AUTH_DIR = path.join(__dirname, 'lux_auth')
// Session prefix
const SESSION_PREFIX = 'LUX~'

// In-memory map of active QR sessions
// id -> { id, status, qr, session, error, createdAt, sock }
const qrSessions = new Map()

// Helper: folder -> session string
function authFolderToSessionString() {
  if (!fs.existsSync(AUTH_DIR)) {
    throw new Error('Auth folder does not exist. Login may have failed.')
  }
  const files = fs.readdirSync(AUTH_DIR)
  const data = {}
  for (const file of files) {
    const full = path.join(AUTH_DIR, file)
    if (fs.statSync(full).isFile()) {
      const raw = fs.readFileSync(full, 'utf8')
      data[file] = JSON.parse(raw)
    }
  }
  const json = JSON.stringify(data)
  const b64 = Buffer.from(json, 'utf8').toString('base64')
  return SESSION_PREFIX + b64
}

// Small helper for IDs
function makeId() {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  ).toUpperCase()
}

/* ---------------- QR FLOW (QR ON PAGE) ---------------- */

async function startQrFlow(id) {
  // clean old auth
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    }
  } catch {}

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  // minimal config, like your working bot
  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' })
  })

  const entry = qrSessions.get(id)
  if (!entry) {
    try { sock.end() } catch {}
    return
  }
  entry.sock = sock
  entry.status = 'connecting'

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    const e = qrSessions.get(id)
    if (!e) return

    // ⚠️ FIX: always update when a new QR arrives (WhatsApp rotates QR)
    if (qr) {
      e.qr = qr
      e.status = 'qr'
    }

    if (connection === 'open') {
      try {
        const session = authFolderToSessionString()
        e.session = session
        e.status = 'done'
      } catch (err) {
        e.error = err.message || String(err)
        e.status = 'error'
      }
      try { sock.end() } catch {}
      delete e.sock
    }

    if (connection === 'close') {
      const code =
        (lastDisconnect &&
          (lastDisconnect.error?.output?.statusCode ??
            lastDisconnect.error?.statusCode ??
            lastDisconnect.error?.data?.tag?.attrs?.code)) ||
        undefined

      logger.warn({ code, lastDisconnect }, 'QR flow connection closed')

      if (!e.session) {
        e.status = 'error'
        if (code === DisconnectReason.loggedOut || code === 401) {
          e.error = 'Logged out / device removed by WhatsApp'
        } else if (!code || code === 515) {
          e.error = 'Connection closed (restart required / unknown)'
        } else {
          e.error = 'Connection closed with code ' + code
        }
      }
      try { sock.end() } catch {}
      delete e.sock
    }
  })

  // safety timeout
  setTimeout(() => {
    const e = qrSessions.get(id)
    if (!e) return
    if (e.status === 'done') return
    e.status = 'expired'
    e.error = 'Timed out waiting for scan/login'
    try { e.sock && e.sock.end() } catch {}
    delete e.sock
  }, 3 * 60 * 1000)
}

/* ---------------- PAIR CODE FLOW ---------------- */

async function generateCodeSession(phoneNumber) {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    }
  } catch {}

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' })
  })

  sock.ev.on('creds.update', saveCreds)

  let resolveDone
  let rejectDone
  let finished = false

  const safeResolve = (v) => {
    if (finished) return
    finished = true
    resolveDone(v)
  }

  const safeReject = (e) => {
    if (finished) return
    finished = true
    rejectDone(e)
  }

  const done = new Promise((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update

    if (connection === 'open') {
      try {
        const session = authFolderToSessionString()
        safeResolve({ session })
      } catch (err) {
        safeReject(err)
      }
      setTimeout(() => { try { sock.end() } catch {} }, 500)
    }

    if (connection === 'close') {
      const code =
        (lastDisconnect &&
          (lastDisconnect.error?.output?.statusCode ??
            lastDisconnect.error?.statusCode ??
            lastDisconnect.error?.data?.tag?.attrs?.code)) ||
        undefined

      if (!finished) {
        if (code === DisconnectReason.loggedOut || code === 401) {
          safeReject(new Error('Logged out / device removed by WhatsApp'))
        } else if (!code || code === 515) {
          safeReject(new Error('Connection closed (restart required / unknown)'))
        } else {
          safeReject(new Error('Connection closed with code ' + code))
        }
      }
      try { sock.end() } catch {}
    }
  })

  // pairing code
  try {
    const pairCode = await sock.requestPairingCode(phoneNumber)
    console.log('\n[CODE MODE] Pairing code for', phoneNumber, ':\n')
    console.log('   ' + pairCode + '\n')
    console.log('On your phone: WhatsApp -> Linked devices -> "Link with phone number" -> enter this code.\n')
  } catch (e) {
    safeReject(e)
  }

  // timeout
  setTimeout(() => {
    safeReject(new Error('Timed out waiting for login / scan'))
    try { sock.end() } catch {}
  }, 3 * 60 * 1000)

  return done
}

/* ---------------- HTML UI (QR ON PAGE) ---------------- */

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>LUX Session Generator</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #020617;
      color: #e5e7eb;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
    }
    .card {
      background: #020617;
      border-radius: 18px;
      padding: 24px 28px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.70);
      max-width: 620px;
      width: 100%;
      border: 1px solid #1f2937;
      display: grid;
      grid-template-columns: 1.4fr 1fr;
      gap: 18px;
    }
    h1 { margin-top: 0; margin-bottom: 4px; font-size: 22px; }
    p { margin: 4px 0 12px; color: #9ca3af; font-size: 13px; }
    label {
      display: block;
      margin-top: 14px;
      margin-bottom: 4px;
      font-size: 13px;
      color: #cbd5f5;
    }
    input[type="text"] {
      width: 100%;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid #334155;
      background: #020617;
      color: #e5e7eb;
      outline: none;
      font-size: 14px;
    }
    input[type="text"]:focus {
      border-color: #22c55e;
      box-shadow: 0 0 0 1px #22c55e33;
    }
    button {
      margin-top: 10px;
      padding: 8px 12px;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    .btn-primary {
      background: #22c55e;
      color: #022c22;
    }
    .btn-secondary {
      background: #020617;
      color: #e5e7eb;
      border: 1px solid #334155;
      margin-left: 4px;
    }
    .btn-primary:disabled,
    .btn-secondary:disabled { opacity: 0.6; cursor: default; }
    .section-title {
      margin-top: 14px;
      font-size: 13px;
      font-weight: 600;
      color: #e5e7eb;
    }
    .status { margin-top: 8px; font-size: 12px; white-space: pre-wrap; }
    .status.ok { color: #4ade80; }
    .status.err { color: #f97373; }
    .session-box {
      margin-top: 10px;
      background: #020617;
      border-radius: 8px;
      border: 1px solid #1f2937;
      padding: 8px;
      font-family: monospace;
      font-size: 12px;
      max-height: 180px;
      overflow: auto;
      word-break: break-all;
    }
    small { color: #64748b; display: block; margin-top: 4px; font-size: 11px; }
    .qr-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      border-radius: 14px;
      border: 1px dashed #334155;
      padding: 12px;
      background: radial-gradient(circle at top, #1f2937 0, #020617 70%);
    }
    #qrImg {
      background: #020617;
      border-radius: 12px;
    }
    .qr-label {
      margin-top: 8px;
      font-size: 11px;
      color: #9ca3af;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="card">
    <div>
      <h1>LUX Session Generator</h1>
      <p>Generate a WhatsApp session string for your LUX bot.<br />
         <small>Use only with your own number. Do not share sessions publicly.</small>
      </p>

      <div class="section-title">QR Session</div>
      <p style="font-size:12px;">
        Click “Start QR Session”. A QR will appear on the right. Scan it from WhatsApp → Linked Devices.<br />
        After login, your session string will appear below.
      </p>
      <button class="btn-primary" id="btnQr">Start QR Session</button>

      <div class="section-title" style="margin-top:16px;">Pair Code Session</div>
      <label for="phoneInput">Phone number (with country code, no +)</label>
      <input id="phoneInput" type="text" placeholder="e.g. 4915679746701" />
      <small>Pair code support depends on WhatsApp. If it fails with “Connection Closed”, use QR mode instead.</small>
      <button class="btn-secondary" id="btnCode">Generate Session by Pair Code</button>

      <div id="status" class="status"></div>
      <div id="sessionBox" class="session-box" style="display:none;"></div>
    </div>

    <div class="qr-container">
      <img id="qrImg" width="220" height="220" alt="QR will appear here" />
      <div class="qr-label" id="qrLabel">QR will appear here after starting.</div>
    </div>
  </div>

  <script>
    const btnQr = document.getElementById('btnQr');
    const btnCode = document.getElementById('btnCode');
    const statusEl = document.getElementById('status');
    const sessionBox = document.getElementById('sessionBox');
    const phoneInput = document.getElementById('phoneInput');
    const qrImg = document.getElementById('qrImg');
    const qrLabel = document.getElementById('qrLabel');

    let currentQrId = null;
    let qrPollTimer = null;
    let lastQrText = null;

    function setStatus(text, type) {
      statusEl.textContent = text || '';
      statusEl.className = 'status ' + (type || '');
    }

    function setSession(session) {
      if (!session) {
        sessionBox.style.display = 'none';
        sessionBox.textContent = '';
      } else {
        sessionBox.style.display = 'block';
        sessionBox.textContent = 'SESSION=' + session;
      }
    }

    function clearQr() {
      qrImg.src = '';
      qrLabel.textContent = 'QR will appear here after starting.';
      lastQrText = null;
    }

    async function renderQr(text) {
      try {
        lastQrText = text;
        qrImg.src =
          'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' +
          encodeURIComponent(text);
        qrLabel.textContent = 'Scan this QR from WhatsApp → Linked Devices.';
      } catch (e) {
        console.error(e);
        qrLabel.textContent = 'Failed to render QR in browser.';
      }
    }

    async function pollQrStatus() {
      if (!currentQrId) return;
      try {
        const res = await fetch('/qr-status?id=' + encodeURIComponent(currentQrId));
        const data = await res.json();
        if (!data.ok) {
          setStatus('Error: ' + (data.error || 'Unknown error'), 'err');
          clearInterval(qrPollTimer);
          qrPollTimer = null;
          return;
        }

        if (data.qr && data.qr !== lastQrText) {
          await renderQr(data.qr);
        }

        if (data.session) {
          setStatus('Session generated successfully! Copy it into your bot .env as SESSION=...', 'ok');
          setSession(data.session);
          clearInterval(qrPollTimer);
          qrPollTimer = null;
        } else if (data.status === 'error' || data.status === 'expired') {
          setStatus('Error: ' + (data.error || 'QR expired / failed.'), 'err');
          clearInterval(qrPollTimer);
          qrPollTimer = null;
        }
      } catch (e) {
        setStatus('Polling failed: ' + e.message, 'err');
        clearInterval(qrPollTimer);
        qrPollTimer = null;
      }
    }

    btnQr.addEventListener('click', async () => {
      setStatus('Starting QR session...', '');
      setSession('');
      clearQr();
      btnQr.disabled = true;
      btnCode.disabled = true;
      try {
        const res = await fetch('/qr-start', { method: 'POST' });
        const data = await res.json();
        if (!data.ok) {
          setStatus('Error: ' + (data.error || 'Unknown error starting QR.'), 'err');
        } else {
          currentQrId = data.id;
          setStatus('QR session started. Waiting for QR and login...', '');
          qrPollTimer = setInterval(pollQrStatus, 2000);
        }
      } catch (e) {
        setStatus('Request failed: ' + e.message, 'err');
      } finally {
        btnQr.disabled = false;
        btnCode.disabled = false;
      }
    });

    btnCode.addEventListener('click', async () => {
      const phone = phoneInput.value.trim();
      if (!phone) {
        setStatus('Enter a phone number first.', 'err');
        return;
      }
      setStatus('Requesting pair code... Check the server terminal for the code. After linking, session will appear here.', '');
      setSession('');
      btnQr.disabled = true;
      btnCode.disabled = true;
      try {
        const res = await fetch('/code-session?phone=' + encodeURIComponent(phone));
        const data = await res.json();
        if (!data.ok) {
          setStatus('Error: ' + (data.error || 'Unknown error'), 'err');
        } else {
          setStatus('Session generated successfully! Copy it into your bot .env as SESSION=...', 'ok');
          setSession(data.session);
        }
      } catch (e) {
        setStatus('Request failed: ' + e.message, 'err');
      } finally {
        btnQr.disabled = false;
        btnCode.disabled = false;
      }
    });

    clearQr();
  </script>
</body>
</html>
  `)
})

/* ---------------- API ROUTES ---------------- */

// Start QR flow (returns id immediately)
app.post('/qr-start', async (req, res) => {
  const id = makeId()
  qrSessions.set(id, {
    id,
    status: 'starting',
    qr: null,
    session: null,
    error: null,
    createdAt: Date.now(),
    sock: null
  })
  startQrFlow(id).catch((err) => {
    const e = qrSessions.get(id)
    if (!e) return
    e.status = 'error'
    e.error = err.message || String(err)
  })

  return res.json({ ok: true, id })
})

// Poll QR status
app.get('/qr-status', (req, res) => {
  const id = (req.query.id || '').toString().trim()
  if (!id) {
    return res.status(400).json({ ok: false, error: 'Missing id' })
  }
  const entry = qrSessions.get(id)
  if (!entry) {
    return res.status(404).json({ ok: false, error: 'Unknown or expired QR session id' })
  }
  return res.json({
    ok: true,
    status: entry.status,
    qr: entry.qr || null,
    session: entry.session || null,
    error: entry.error || null
  })
})

// Pair code session
app.get('/code-session', (req, res) => {
  const phoneNumber = (req.query.phone || '').toString().trim()
  if (!phoneNumber) {
    return res.status(400).json({
      ok: false,
      error: 'Missing phone query param. Example: /code-session?phone=4915679746701'
    })
  }

  logger.info({ phoneNumber }, 'Received /code-session request')

  generateCodeSession(phoneNumber)
    .then(({ session }) => {
      logger.info('Session generated successfully (code mode)')
      return res.json({ ok: true, session })
    })
    .catch((err) => {
      logger.error({ err }, 'Failed to generate session via code')
      return res.status(500).json({
        ok: false,
        error: err.message || String(err)
      })
    })
})

/* ---------------- START SERVER ---------------- */

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  logger.info(`Session server running on http://localhost:${PORT}`)
  console.log('\nEndpoints:')
  console.log(`  UI:        http://localhost:${PORT}/`)
  console.log(`  QR start:  POST http://localhost:${PORT}/qr-start`)
  console.log(`  QR status: GET  http://localhost:${PORT}/qr-status?id=...`)
  console.log(`  Code:      GET  http://localhost:${PORT}/code-session?phone=4915679746701\n`)
})
