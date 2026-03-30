import * as readline from 'readline'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { execFileSync } from 'child_process'
import { PlaudSyncConfig } from './config.js'
import { PlaudAuth } from './auth.js'
import { PlaudClient } from './client.js'
import { Transcriber, checkPrerequisites } from './transcriber.js'
import { syncRecordings } from './sync.js'
import type { TokenData } from './types.js'

const DEFAULT_OUTPUT = path.join(os.homedir(), 'PlaudSync')
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

export function decodeJwtExpiry(jwt: string): { iat: number; exp: number } {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT')
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  return { iat: payload.iat ?? 0, exp: payload.exp ?? 0 }
}

export function parseTokenFromCapture(
  body: { token: string | null; domain: string | null },
  fallbackRegion: 'us' | 'eu' = 'us',
): TokenData {
  const raw = body.token ?? ''
  const jwt = raw.replace(/^bearer\s+/i, '')

  const decoded = decodeJwtExpiry(jwt)

  if (decoded.exp * 1000 < Date.now()) {
    throw new Error('Token is already expired. Please log in again and retry.')
  }

  let region: 'us' | 'eu' = fallbackRegion
  if (body.domain && body.domain.includes('euc1')) {
    region = 'eu'
  }

  return {
    accessToken: jwt,
    tokenType: 'Bearer',
    issuedAt: decoded.iat * 1000,
    expiresAt: decoded.exp * 1000,
    region,
  }
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': 'https://web.plaud.ai',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function waitForToken(
  fallbackRegion: 'us' | 'eu',
): { promise: Promise<TokenData>; server: ReturnType<typeof Bun.serve> } {
  let resolveToken: (token: TokenData) => void
  let rejectToken: (err: Error) => void

  const promise = new Promise<TokenData>((resolve, reject) => {
    resolveToken = resolve
    rejectToken = reject
  })

  const timeout = setTimeout(() => {
    server.stop()
    rejectToken(new Error('Login timed out after 5 minutes. Please try again.'))
  }, LOGIN_TIMEOUT_MS)

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS })
      }

      if (req.method === 'POST' && new URL(req.url).pathname === '/capture') {
        try {
          const body = await req.json()
          const tokenData = parseTokenFromCapture(body, fallbackRegion)
          clearTimeout(timeout)
          resolveToken(tokenData)
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          process.stderr.write(`  Invalid token received: ${message}\n`)
          process.stderr.write('  Please try again.\n')
          return new Response(JSON.stringify({ error: message }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          })
        }
      }

      return new Response('Not found', { status: 404, headers: CORS_HEADERS })
    },
  })

  return { promise, server }
}

async function loginCommand(): Promise<void> {
  const regionInput = await prompt('Region (us/eu) [us]: ')
  const region = (regionInput === 'eu' ? 'eu' : 'us') as 'us' | 'eu'

  const { promise, server } = waitForToken(region)
  const port = server.port

  Bun.spawn(['open', 'https://web.plaud.ai'])

  process.stdout.write('\nBrowser opened. Log in to your Plaud account, then:\n')
  process.stdout.write('  1. On the web.plaud.ai tab, open DevTools (Cmd+Option+J)\n')
  process.stdout.write('  2. Paste this command and press Enter:\n\n')
  process.stdout.write(
    `     fetch('http://localhost:${port}/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:localStorage.getItem('tokenstr'),domain:localStorage.getItem('plaud_user_api_domain')})})\n\n`,
  )
  process.stdout.write('Waiting for token...\n')

  try {
    const tokenData = await promise
    const config = new PlaudSyncConfig()
    config.saveToken(tokenData)
    const expiresDate = new Date(tokenData.expiresAt).toLocaleDateString()
    process.stdout.write(`Login successful. Token saved (expires ${expiresDate}).\n`)

    if (!config.getHfToken()) {
      process.stdout.write('\nSpeaker diarization requires a Hugging Face token (free, read access).\n')
      process.stdout.write('Setup: accept agreements at both URLs, then create a token:\n')
      process.stdout.write('  https://huggingface.co/pyannote/speaker-diarization-3.1\n')
      process.stdout.write('  https://huggingface.co/pyannote/segmentation-3.0\n')
      process.stdout.write('  https://huggingface.co/settings/tokens\n\n')
      const hfInput = await prompt('HF token (or Enter to skip): ')
      if (hfInput) {
        config.saveHfToken(hfInput)
        process.stdout.write('HF token saved.\n')
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Login failed: ${message}\n`)
    process.exit(1)
  } finally {
    server.stop()
  }
}

async function syncCommand(folder: string, concurrency: number): Promise<void> {
  const config = new PlaudSyncConfig()
  const token = config.getToken()

  if (!token) {
    process.stderr.write('No token found. Run `plaud-sync login` first.\n')
    process.exit(1)
  }

  const hfToken = config.getHfToken()
  if (!hfToken) {
    process.stderr.write('No HF token found. Run `plaud-sync login` or set HF_TOKEN.\n')
    process.exit(1)
  }

  const errors = checkPrerequisites()
  if (errors.length > 0) {
    process.stderr.write('Prerequisites missing:\n')
    for (const err of errors) {
      process.stderr.write(`  - ${err}\n`)
    }
    process.exit(1)
  }

  const auth = new PlaudAuth(config)
  const client = new PlaudClient(auth, token.region)
  const transcriber = new Transcriber()

  await syncRecordings(client, transcriber, folder, hfToken, concurrency)
}

const PLIST_LABEL = 'com.plaud-sync.agent'
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`)
const INSTALL_DIR = '/usr/local/bin'
const BINARY_PATH = path.join(INSTALL_DIR, 'plaud-sync')
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'plaud-sync')

function generatePlist(intervalMinutes: number, outputFolder: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BINARY_PATH}</string>
    <string>sync</string>
    <string>${outputFolder}</string>
  </array>
  <key>StartInterval</key>
  <integer>${intervalMinutes * 60}</integer>
  <key>StandardOutPath</key>
  <string>${path.join(LOG_DIR, 'stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(LOG_DIR, 'stderr.log')}</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`
}

function installCommand(args: string[]): void {
  let folder = DEFAULT_OUTPUT
  let intervalMinutes = 30

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--interval' && args[i + 1]) {
      intervalMinutes = parseInt(args[i + 1], 10)
      i++
    } else {
      folder = args[i]
    }
  }

  if (isNaN(intervalMinutes) || intervalMinutes < 1) {
    process.stderr.write('Interval must be a positive number of minutes.\n')
    process.exit(1)
  }

  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true })

  const plist = generatePlist(intervalMinutes, folder)
  fs.writeFileSync(PLIST_PATH, plist)

  try {
    execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' })
  } catch {
    // Ignore if not loaded
  }
  execFileSync('launchctl', ['load', PLIST_PATH])

  process.stdout.write(`Installed. Syncing every ${intervalMinutes} minutes to ${folder}\n`)
  process.stdout.write(`Logs: ${LOG_DIR}\n`)
}

function uninstallCommand(): void {
  if (!fs.existsSync(PLIST_PATH)) {
    process.stdout.write('LaunchAgent not installed.\n')
    return
  }

  try {
    execFileSync('launchctl', ['unload', PLIST_PATH])
  } catch {
    // Ignore if not loaded
  }

  fs.unlinkSync(PLIST_PATH)
  process.stdout.write('LaunchAgent uninstalled.\n')
}

const USAGE = `plaud-sync v0.1.0

Usage: plaud-sync <command> [options]

Commands:
  login                          Authenticate via Plaud web app
  sync [folder] [--concurrency N] Sync recordings (default: ~/PlaudSync, 2 parallel)
  install [folder] [--interval]  Install launchd agent (default: 30 min)
  uninstall                      Remove launchd agent`

export async function run(args: string[]): Promise<void> {
  const command = args[0]

  switch (command) {
    case 'login':
      return loginCommand()
    case 'sync': {
      let folder = DEFAULT_OUTPUT
      let concurrency = 2
      const syncArgs = args.slice(1)
      for (let i = 0; i < syncArgs.length; i++) {
        if (syncArgs[i] === '--concurrency' && syncArgs[i + 1]) {
          concurrency = parseInt(syncArgs[i + 1], 10)
          i++
        } else {
          folder = syncArgs[i]
        }
      }
      return syncCommand(folder, concurrency)
    }
    case 'install':
      return installCommand(args.slice(1))
    case 'uninstall':
      return uninstallCommand()
    default:
      process.stdout.write(USAGE + '\n')
  }
}
