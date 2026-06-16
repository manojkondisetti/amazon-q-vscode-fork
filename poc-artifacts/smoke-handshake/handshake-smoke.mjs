#!/usr/bin/env node
/*
 * Credential-free LSP handshake smoke for an extracted aws/language-servers RC.
 *
 * Spawns the standalone server (aws-lsp-codewhisperer.js --stdio), sends an LSP
 * `initialize` request using proper Content-Length framing, and asserts the server
 * responds with a result containing `capabilities`. Exits 0 on success, non-zero on
 * timeout / crash / malformed response.
 *
 * This needs NO AWS creds, NO SSO, NO internal values — it only proves the RC binary
 * launches and speaks LSP on this OS. It's the fallback when the full auth-backed E2E
 * is blocked (see POC plan "Auth-free fallback"), and a fast first proof that the
 * Windows runner + RC artifact path work.
 *
 * Usage:
 *   node handshake-smoke.mjs <path-to-aws-lsp-codewhisperer.js>
 *   node handshake-smoke.mjs /tmp/rc-lsp/aws-lsp-codewhisperer.js
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'

const serverEntry = process.argv[2]
if (!serverEntry) {
  console.error('Usage: node handshake-smoke.mjs <path-to-aws-lsp-codewhisperer.js>')
  process.exit(2)
}
if (!existsSync(serverEntry)) {
  console.error(`Server entry not found: ${serverEntry}`)
  process.exit(2)
}

const TIMEOUT_MS = 30_000

// Launch the server over stdio. --stdio is the documented standalone LSP transport.
const child = spawn(process.execPath, [serverEntry, '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stderrBuf = ''
child.stderr.on('data', (d) => {
  stderrBuf += d.toString()
})

// ── Minimal LSP framing: parse Content-Length-delimited JSON-RPC messages from stdout ──
let buffer = Buffer.alloc(0)
const pending = []
let resolveMessage = null

function pump() {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const m = /Content-Length:\s*(\d+)/i.exec(header)
    if (!m) {
      // Malformed header — drop up to the separator and continue.
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const len = parseInt(m[1], 10)
    const bodyStart = headerEnd + 4
    if (buffer.length < bodyStart + len) return // wait for more bytes
    const body = buffer.subarray(bodyStart, bodyStart + len).toString('utf8')
    buffer = buffer.subarray(bodyStart + len)
    let msg
    try {
      msg = JSON.parse(body)
    } catch {
      continue
    }
    if (resolveMessage) {
      const r = resolveMessage
      resolveMessage = null
      r(msg)
    } else {
      pending.push(msg)
    }
  }
}

child.stdout.on('data', (d) => {
  buffer = Buffer.concat([buffer, d])
  pump()
})

function nextMessage() {
  if (pending.length) return Promise.resolve(pending.shift())
  return new Promise((res) => {
    resolveMessage = res
  })
}

function send(obj) {
  const json = JSON.stringify(obj)
  const payload = Buffer.from(json, 'utf8')
  child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`)
  child.stdin.write(payload)
}

function fail(msg) {
  console.error(`HANDSHAKE FAILED: ${msg}`)
  if (stderrBuf.trim()) console.error('--- server stderr (tail) ---\n' + stderrBuf.slice(-2000))
  try {
    child.kill()
  } catch {}
  process.exit(1)
}

const timer = setTimeout(() => fail(`no initialize response within ${TIMEOUT_MS}ms`), TIMEOUT_MS)

child.on('error', (e) => fail(`failed to spawn server: ${e.message}`))
child.on('exit', (code) => {
  if (code !== 0 && code !== null) fail(`server exited early with code ${code}`)
})

// ── Drive the handshake ──
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    processId: process.pid,
    clientInfo: { name: 'poc-handshake-smoke', version: '0.0.0' },
    rootUri: null,
    capabilities: {},
  },
})

// Wait for the response with id === 1.
;(async () => {
  while (true) {
    const msg = await nextMessage()
    if (msg.id === 1) {
      clearTimeout(timer)
      if (msg.error) fail(`initialize returned error: ${JSON.stringify(msg.error)}`)
      if (!msg.result || !msg.result.capabilities) {
        fail(`initialize result missing capabilities: ${JSON.stringify(msg.result)}`)
      }
      const name = msg.result.serverInfo?.name ?? '(unknown)'
      const ver = msg.result.serverInfo?.version ?? '(unknown)'
      console.log(`HANDSHAKE OK — server "${name}" v${ver} responded with capabilities.`)
      send({ jsonrpc: '2.0', method: 'initialized', params: {} })
      send({ jsonrpc: '2.0', id: 2, method: 'shutdown' })
      send({ jsonrpc: '2.0', method: 'exit' })
      setTimeout(() => process.exit(0), 500)
      return
    }
    // Ignore notifications/other ids (e.g. window/logMessage) and keep reading.
  }
})()
