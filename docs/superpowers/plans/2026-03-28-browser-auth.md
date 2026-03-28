# Browser-Based Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace email/password login with browser-based auth that captures the JWT from Plaud's web app via a local HTTP server, eliminating plaintext credential storage.

**Architecture:** The CLI starts a temporary local HTTP server, opens the Plaud web app for the user to log in, and receives the token via a console-pasted `fetch()` call. Token and region are stored in config; credentials are never stored.

**Tech Stack:** Bun (built-in HTTP server, process spawning), Zod (validation)

---

### Task 1: Update types — remove credentials, add region to token

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Write the test**

Create `src/types.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test'
import { TokenDataSchema, ConfigSchema } from './types.js'

describe('TokenDataSchema', () => {
  test('accepts valid token data with region', () => {
    const result = TokenDataSchema.safeParse({
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcyNjAwMDAwMH0.sig',
      tokenType: 'Bearer',
      issuedAt: 1700000000000,
      expiresAt: 1726000000000,
      region: 'us',
    })
    expect(result.success).toBe(true)
  })

  test('defaults region to us when not provided', () => {
    const result = TokenDataSchema.parse({
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcyNjAwMDAwMH0.sig',
      tokenType: 'Bearer',
      issuedAt: 1700000000000,
      expiresAt: 1726000000000,
    })
    expect(result.region).toBe('us')
  })

  test('rejects invalid region', () => {
    const result = TokenDataSchema.safeParse({
      accessToken: 'token',
      tokenType: 'Bearer',
      issuedAt: 1700000000000,
      expiresAt: 1726000000000,
      region: 'invalid',
    })
    expect(result.success).toBe(false)
  })
})

describe('ConfigSchema', () => {
  test('accepts config with only token (no credentials field)', () => {
    const result = ConfigSchema.safeParse({
      token: {
        accessToken: 'tok',
        tokenType: 'Bearer',
        issuedAt: 1700000000000,
        expiresAt: 1726000000000,
        region: 'eu',
      },
    })
    expect(result.success).toBe(true)
  })

  test('accepts empty config', () => {
    const result = ConfigSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/types.test.ts`
Expected: FAIL — `region` is not in `TokenDataSchema`, and `ConfigSchema` still has `credentials`

- [ ] **Step 3: Update `src/types.ts`**

Replace the entire file with:

```typescript
import { z } from 'zod'

export const BASE_URLS: Record<string, string> = {
  us: 'https://api.plaud.ai',
  eu: 'https://api-euc1.plaud.ai',
}

export const TokenDataSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.string(),
  issuedAt: z.number(),
  expiresAt: z.number(),
  region: z.enum(['us', 'eu']).default('us'),
})

export type TokenData = z.infer<typeof TokenDataSchema>

export const ConfigSchema = z.object({
  token: TokenDataSchema.optional(),
})

export type Config = z.infer<typeof ConfigSchema>

export interface PlaudRecording {
  id: string
  filename: string
  fullname: string
  filesize: number
  duration: number
  start_time: number
  end_time: number
  is_trash: boolean
  is_trans: boolean
  is_summary: boolean
  keywords: string[]
  serial_number: string
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/types.test.ts
git commit -m "refactor: remove credentials from types, add region to TokenData"
```

---

### Task 2: Simplify config — remove credential storage

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Write the test**

Create `src/config.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { PlaudSyncConfig } from './config.js'
import type { TokenData } from './types.js'

describe('PlaudSyncConfig', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-config-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('saves and retrieves token', () => {
    const config = new PlaudSyncConfig(tmpDir)
    const token: TokenData = {
      accessToken: 'eyJ...',
      tokenType: 'Bearer',
      issuedAt: 1700000000000,
      expiresAt: 1726000000000,
      region: 'us',
    }
    config.saveToken(token)
    expect(config.getToken()).toEqual(token)
  })

  test('returns undefined when no token saved', () => {
    const config = new PlaudSyncConfig(tmpDir)
    expect(config.getToken()).toBeUndefined()
  })

  test('does not have saveCredentials method', () => {
    const config = new PlaudSyncConfig(tmpDir)
    expect((config as any).saveCredentials).toBeUndefined()
  })

  test('does not have getCredentials method', () => {
    const config = new PlaudSyncConfig(tmpDir)
    expect((config as any).getCredentials).toBeUndefined()
  })

  test('migrates old config with credentials field gracefully', () => {
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({
        credentials: { email: 'old@test.com', password: 'secret', region: 'us' },
        token: {
          accessToken: 'tok',
          tokenType: 'Bearer',
          issuedAt: 1700000000000,
          expiresAt: 1726000000000,
          region: 'us',
        },
      }),
    )
    const config = new PlaudSyncConfig(tmpDir)
    const token = config.getToken()
    expect(token?.accessToken).toBe('tok')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/config.test.ts`
Expected: FAIL — `saveCredentials` and `getCredentials` still exist on the class

- [ ] **Step 3: Update `src/config.ts`**

Replace the entire file with:

```typescript
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ConfigSchema } from './types.js'
import type { TokenData, Config } from './types.js'

const DEFAULT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'plaud-sync')
const CONFIG_FILE = 'config.json'

export class PlaudSyncConfig {
  private dir: string

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_DIR
  }

  private filePath(): string {
    return path.join(this.dir, CONFIG_FILE)
  }

  private load(): Config {
    try {
      const raw = fs.readFileSync(this.filePath(), 'utf-8')
      return ConfigSchema.parse(JSON.parse(raw))
    } catch {
      return {}
    }
  }

  private save(partial: Partial<Config>): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const existing = this.load()
    const merged = { ...existing, ...partial }
    fs.writeFileSync(this.filePath(), JSON.stringify(merged, null, 2), { mode: 0o600 })
  }

  saveToken(token: TokenData): void {
    this.save({ token })
  }

  getToken(): TokenData | undefined {
    return this.load().token
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "refactor: remove credential storage from config"
```

---

### Task 3: Simplify auth — remove password-based login

**Files:**
- Modify: `src/auth.ts`

- [ ] **Step 1: Write the test**

Create `src/auth.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { PlaudSyncConfig } from './config.js'
import { PlaudAuth } from './auth.js'
import type { TokenData } from './types.js'

describe('PlaudAuth', () => {
  let tmpDir: string
  let config: PlaudSyncConfig

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-auth-test-'))
    config = new PlaudSyncConfig(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('returns cached token when valid', async () => {
    const token: TokenData = {
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3MDAwMDAwMDAsImV4cCI6OTk5OTk5OTk5OX0.sig',
      tokenType: 'Bearer',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 200 * 24 * 60 * 60 * 1000, // 200 days from now
      region: 'us',
    }
    config.saveToken(token)
    const auth = new PlaudAuth(config)
    const result = await auth.getToken()
    expect(result).toBe(token.accessToken)
  })

  test('throws when no token is saved', async () => {
    const auth = new PlaudAuth(config)
    expect(auth.getToken()).rejects.toThrow("plaud-sync login")
  })

  test('throws when token is expiring soon', async () => {
    const token: TokenData = {
      accessToken: 'expired-token',
      tokenType: 'Bearer',
      issuedAt: Date.now() - 300 * 24 * 60 * 60 * 1000,
      expiresAt: Date.now() + 5 * 24 * 60 * 60 * 1000, // 5 days — within 30-day buffer
      region: 'us',
    }
    config.saveToken(token)
    const auth = new PlaudAuth(config)
    expect(auth.getToken()).rejects.toThrow("plaud-sync login")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/auth.test.ts`
Expected: FAIL — `PlaudAuth` still tries to call `login()` which calls `config.getCredentials()`

- [ ] **Step 3: Update `src/auth.ts`**

Replace the entire file with:

```typescript
import type { PlaudSyncConfig } from './config.js'
import type { TokenData } from './types.js'

const TOKEN_REFRESH_BUFFER_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export class PlaudAuth {
  private config: PlaudSyncConfig

  constructor(config: PlaudSyncConfig) {
    this.config = config
  }

  async getToken(): Promise<string> {
    const cached = this.config.getToken()
    if (cached && !this.isExpiringSoon(cached)) {
      return cached.accessToken
    }
    throw new Error(
      'No valid token. Run `plaud-sync login` to authenticate via the browser.',
    )
  }

  private isExpiringSoon(token: TokenData): boolean {
    return Date.now() + TOKEN_REFRESH_BUFFER_MS > token.expiresAt
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/auth.test.ts
git commit -m "refactor: remove password-based login from PlaudAuth"
```

---

### Task 4: Rewrite loginCommand with browser-based flow

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Write the test for token capture server**

Create `src/cli.test.ts`. We test the token capture flow by simulating the browser POST:

```typescript
import { describe, expect, test } from 'bun:test'
import { parseTokenFromCapture, decodeJwtExpiry } from './cli.js'

describe('decodeJwtExpiry', () => {
  test('decodes iat and exp from a JWT', () => {
    // JWT with payload: {"iat":1700000000,"exp":1726000000}
    const header = btoa(JSON.stringify({ alg: 'HS256' }))
    const payload = btoa(JSON.stringify({ iat: 1700000000, exp: 1726000000 }))
    const jwt = `${header}.${payload}.fakesig`
    const result = decodeJwtExpiry(jwt)
    expect(result.iat).toBe(1700000000)
    expect(result.exp).toBe(1726000000)
  })

  test('throws on invalid JWT', () => {
    expect(() => decodeJwtExpiry('not-a-jwt')).toThrow('Invalid JWT')
  })
})

describe('parseTokenFromCapture', () => {
  test('strips bearer prefix and extracts token', () => {
    const header = btoa(JSON.stringify({ alg: 'HS256' }))
    const payload = btoa(JSON.stringify({ iat: 1700000000, exp: 9999999999 }))
    const jwt = `${header}.${payload}.fakesig`

    const result = parseTokenFromCapture({
      token: `bearer ${jwt}`,
      domain: 'https://api.plaud.ai',
    })
    expect(result.accessToken).toBe(jwt)
    expect(result.region).toBe('us')
    expect(result.tokenType).toBe('Bearer')
  })

  test('handles token without bearer prefix', () => {
    const header = btoa(JSON.stringify({ alg: 'HS256' }))
    const payload = btoa(JSON.stringify({ iat: 1700000000, exp: 9999999999 }))
    const jwt = `${header}.${payload}.fakesig`

    const result = parseTokenFromCapture({ token: jwt, domain: null })
    expect(result.accessToken).toBe(jwt)
    expect(result.region).toBe('us')
  })

  test('detects EU region from domain', () => {
    const header = btoa(JSON.stringify({ alg: 'HS256' }))
    const payload = btoa(JSON.stringify({ iat: 1700000000, exp: 9999999999 }))
    const jwt = `${header}.${payload}.fakesig`

    const result = parseTokenFromCapture({
      token: jwt,
      domain: 'https://api-euc1.plaud.ai',
    })
    expect(result.region).toBe('eu')
  })

  test('falls back to provided region when domain is null', () => {
    const header = btoa(JSON.stringify({ alg: 'HS256' }))
    const payload = btoa(JSON.stringify({ iat: 1700000000, exp: 9999999999 }))
    const jwt = `${header}.${payload}.fakesig`

    const result = parseTokenFromCapture({ token: jwt, domain: null }, 'eu')
    expect(result.region).toBe('eu')
  })

  test('throws on expired token', () => {
    const header = btoa(JSON.stringify({ alg: 'HS256' }))
    const payload = btoa(JSON.stringify({ iat: 1700000000, exp: 1700000001 }))
    const jwt = `${header}.${payload}.fakesig`

    expect(() => parseTokenFromCapture({ token: jwt, domain: null })).toThrow('expired')
  })

  test('throws on malformed JWT', () => {
    expect(() => parseTokenFromCapture({ token: 'not-a-jwt', domain: null })).toThrow('Invalid JWT')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cli.test.ts`
Expected: FAIL — `parseTokenFromCapture` and `decodeJwtExpiry` don't exist

- [ ] **Step 3: Rewrite `src/cli.ts`**

Replace the entire file with:

```typescript
import * as readline from 'readline'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { execFileSync } from 'child_process'
import { PlaudSyncConfig } from './config.js'
import { PlaudAuth } from './auth.js'
import { PlaudClient } from './client.js'
import { Transcriber, findWhisperModel, checkPrerequisites } from './transcriber.js'
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Login failed: ${message}\n`)
    process.exit(1)
  } finally {
    server.stop()
  }
}

async function syncCommand(folder: string): Promise<void> {
  const config = new PlaudSyncConfig()
  const token = config.getToken()

  if (!token) {
    process.stderr.write('No token found. Run `plaud-sync login` first.\n')
    process.exit(1)
  }

  const modelPath = findWhisperModel()
  const errors = checkPrerequisites(modelPath)
  if (errors.length > 0) {
    process.stderr.write('Prerequisites missing:\n')
    for (const err of errors) {
      process.stderr.write(`  - ${err}\n`)
    }
    process.exit(1)
  }

  const auth = new PlaudAuth(config)
  const client = new PlaudClient(auth, token.region)
  const transcriber = new Transcriber(modelPath!)

  await syncRecordings(client, transcriber, folder)
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
  sync [folder]                  Sync recordings (default: ~/PlaudSync)
  install [folder] [--interval]  Install launchd agent (default: 30 min)
  uninstall                      Remove launchd agent`

export async function run(args: string[]): Promise<void> {
  const command = args[0]

  switch (command) {
    case 'login':
      return loginCommand()
    case 'sync':
      return syncCommand(args[1] || DEFAULT_OUTPUT)
    case 'install':
      return installCommand(args.slice(1))
    case 'uninstall':
      return uninstallCommand()
    default:
      process.stdout.write(USAGE + '\n')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/cli.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat: replace password login with browser-based token capture"
```

---

### Task 5: Update client to read region from token

**Files:**
- Modify: `src/client.ts`

- [ ] **Step 1: Verify client already works**

The `PlaudClient` constructor already accepts a `region` string, and `syncCommand` in Task 4 now passes `token.region`. No code changes needed in `client.ts`.

Verify nothing is broken:

Run: `bun test`
Expected: All tests pass

- [ ] **Step 2: Remove `Credentials` import from cli.ts if present**

Check that `src/cli.ts` no longer imports `Credentials` from types. It should not after Task 4's rewrite — verify by reading the import section.

- [ ] **Step 3: Commit (if any cleanup was needed)**

```bash
git add -A
git commit -m "chore: clean up unused credential imports"
```

Skip this step if no changes were needed.

---

### Task 6: Manual integration test

**Files:** None (manual verification)

- [ ] **Step 1: Build check**

Run: `bunx tsc --noEmit`
Expected: No type errors

- [ ] **Step 2: Test login flow manually**

Run: `bun run plaud-sync login`
Expected:
1. Prompts for region
2. Opens browser to web.plaud.ai
3. Prints fetch one-liner with port
4. After pasting in console, prints "Login successful. Token saved (expires <date>)."

- [ ] **Step 3: Test sync flow**

Run: `bun run plaud-sync sync`
Expected: Syncs recordings using the stored token

- [ ] **Step 4: Verify no credentials on disk**

Run: `cat ~/Library/Application\ Support/plaud-sync/config.json`
Expected: JSON with only `token` field (no `credentials` field)

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address issues found in manual testing"
```
