import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import pino from 'pino'
import * as baileys from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import { nanoid } from 'nanoid'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// pull named exports we actually have
const { DisconnectReason, useMultiFileAuthState, Browsers } = baileys

// robustly locate socket creator
const makeWASocket =
  (typeof baileys.default === 'function' && baileys.default) ||
  (typeof baileys.makeWASocket === 'function' && baileys.makeWASocket) ||
  null

if (!makeWASocket) {
  console.error('❌ Could not find makeWASocket in @whiskeysockets/baileys.')
  console.error('Available keys:', Object.keys(baileys))
  throw new Error('makeWASocket function not found in Baileys module')
}

console.log('✅ makeWASocket type:', typeof makeWASocket)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const log = pino({ level: 'info' })

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

const PORT = process.env.PORT || 3000

// sessions/<SESSION_ID>/ will store Baileys multi-file auth
const SESSIONS_DIR = path.join(__dirname, 'sessions')
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })

// in-memory store of SESSION_ID strings (base64 of creds.json)
const sessionResults = new Map() // sessionId -> base64 string

// encode creds.json as a lux-style session string
function encodeLuxSession(credsJson) {
  // normal base64
  const b64 = Buffer.from(credsJson, 'utf8').toString('base64')
  // make it URL-safe and remove padding, like many MD bots do
  const safe = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  // prefix with lux~
  return `lux~${safe}`
}

function buildSessionString(sessionId, sessionPath) {
  try {
    const credsPath = path.join(sessionPath, 'creds.json')
    if (!fs.existsSync(credsPath)) {
      log.warn({ sessionId }, 'creds.json not found yet')
      return
    }
    const credsJson = fs.readFileSync(credsPath, 'utf8')
    const sessionString = encodeLuxSession(credsJson)
    sessionResults.set(sessionId, sessionString)
    log.info({ sessionId }, 'SESSION_ID (lux~) built from creds.json')
  } catch (err) {
    log.error({ err, sessionId }, 'failed to build SESSION_ID')
  }
}

// create a Baileys socket bound to a specific sessionId (multi-file auth)
async function createSocket(sessionId) {
  const sessionPath = path.join(SESSIONS_DIR, sessionId)
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome')
  })

  // keep auth up to date & rebuild SESSION_ID string when creds change
  sock.ev.on('creds.update', async () => {
    await saveCreds()
    buildSessionString(sessionId, sessionPath)
    log.info({ sessionId }, 'creds updated & saved')
  })

  // also build SESSION_ID when connection first opens (for safety)
  sock.ev.on('connection.update', async (update) => {
    const { connection } = update
    if (connection === 'open') {
      await saveCreds()
      buildSessionString(sessionId, sessionPath)
    }
  })

  return sock
}

/**
 * QR LOGIN
 * GET /api/session/qr
 */
app.get('/api/session/qr', async (req, res) => {
  const sessionId = 'S-' + nanoid(10)
  log.info({ sessionId }, 'QR session requested')

  try {
    const sock = await createSocket(sessionId)

    let answered = false

    const timeout = setTimeout(() => {
      if (!answered) {
        answered = true
        log.warn({ sessionId }, 'QR timeout')
        res.status(504).json({ error: 'QR timeout' })
        try { sock.ws?.close() } catch {}
      }
    }, 60_000)

    sock.ev.on('connection.update', async (update) => {
      const { qr, connection, lastDisconnect } = update

      log.info(
        {
          sessionId,
          connection,
          hasQr: !!qr,
          statusCode: lastDisconnect?.error?.output?.statusCode
        },
        'connection.update (qr)'
      )

      if (!answered && qr) {
        const dataUrl = await QRCode.toDataURL(qr, { width: 300 })
        answered = true
        clearTimeout(timeout)
        log.info({ sessionId }, 'QR generated')
        return res.json({
          sessionId,
          qr: dataUrl,
          status: 'scan_pending'
        })
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut
        log.warn({ sessionId, statusCode }, 'QR connection closed')

        if (statusCode === DisconnectReason.restartRequired) {
          log.warn({ sessionId }, 'restartRequired for QR, restarting socket...')
          createSocket(sessionId).catch((err) => {
            log.error({ err, sessionId }, 'Error restarting QR socket')
          })
          return
        }

        if (!answered) {
          answered = true
          clearTimeout(timeout)
          return res.status(500).json({
            error: 'connection_closed',
            statusCode,
            shouldReconnect
          })
        }
      }
    })
  } catch (err) {
    log.error({ err, sessionId }, 'Error in /api/session/qr')
    return res.status(500).json({
      error: 'internal_error',
      details: String(err?.message || err)
    })
  }
})

/**
 * PAIR-CODE LOGIN
 * GET /api/session/pair?phone=XXXXXXXXXXX
 */
app.get('/api/session/pair', async (req, res) => {
  const rawPhone = (req.query.phone || '').toString().trim()
  const phone = rawPhone.replace(/[^\d]/g, '')

  if (!/^\d{8,15}$/.test(phone)) {
    return res.status(400).json({
      error: 'invalid_phone',
      message: 'phone must be digits only, E.164 without + (ex: 918888888888)'
    })
  }

  const sessionId = 'P-' + nanoid(10)
  log.info({ sessionId, phone }, 'Pair-code session requested')

  try {
    const sock = await createSocket(sessionId)

    let answered = false
    let requested = false

    const timeout = setTimeout(() => {
      if (!answered) {
        answered = true
        log.warn({ sessionId }, 'Pair-code timeout')
        res.status(504).json({ error: 'pair_timeout' })
        try { sock.ws?.close() } catch {}
      }
    }, 60_000)

    sock.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update

      log.info(
        {
          sessionId,
          connection,
          hasQr: !!qr,
          statusCode: lastDisconnect?.error?.output?.statusCode
        },
        'connection.update (pair)'
      )

      if (!requested && (connection === 'connecting' || !!qr)) {
        requested = true
        try {
          let code = await sock.requestPairingCode(phone)
          if (code && typeof code === 'string') {
            code = code.match(/.{1,4}/g)?.join('-') || code
          }

          if (!answered) {
            answered = true
            clearTimeout(timeout)
            log.info({ sessionId, phone, code }, 'Pairing code generated')
            return res.json({
              sessionId,
              phone,
              code,
              status: 'pair_code_generated'
            })
          }
        } catch (err) {
          if (!answered) {
            answered = true
            clearTimeout(timeout)
            log.error({ err, sessionId }, 'Error generating pair code')
            return res.status(500).json({
              error: 'pair_code_error',
              details: String(err?.message || err)
            })
          }
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut

        log.warn({ sessionId, statusCode }, 'Pair connection closed')

        if (statusCode === DisconnectReason.restartRequired) {
          log.warn({ sessionId }, 'restartRequired for pair, restarting socket...')
          createSocket(sessionId).catch((err) => {
            log.error({ err, sessionId }, 'Error restarting pair socket')
          })
          return
        }

        if (!answered) {
          answered = true
          clearTimeout(timeout)
          return res.status(500).json({
            error: 'connection_closed',
            statusCode,
            shouldReconnect
          })
        }
      }
    })
  } catch (err) {
    log.error({ err, sessionId }, 'Error in /api/session/pair root try')
    return res.status(500).json({
      error: 'pair_code_error',
      details: String(err?.message || err)
    })
  }
})

/**
 * RESULT POLLING
 * GET /api/session/result/:id
 */
app.get('/api/session/result/:id', (req, res) => {
  const sessionId = req.params.id
  const session = sessionResults.get(sessionId) || null

  return res.json({
    sessionId,
    ready: !!session,
    session
  })
})

app.listen(PORT, () => {
  log.info(`Session server running on port ${PORT}`)
})
