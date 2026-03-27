# Plaud Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CLI tool that syncs Plaud recordings and transcribes them locally with whisper.cpp.

**Architecture:** Single-package TypeScript CLI. Modules for config, auth, API client, transcription, and sync orchestration. Filesystem is the source of truth for idempotent sync — no state files.

**Tech Stack:** Node.js, TypeScript, commander, zod, vitest, tsx, whisper.cpp (Homebrew), ffmpeg (Homebrew)

**Spec:** `docs/superpowers/specs/2026-03-27-plaud-sync-design.md`

**Reference project:** `../plaud/` — proven Plaud API patterns to adapt

---

## File Map

| File | Responsibility |
|------|---------------|
| `package.json` | Dependencies, scripts |
| `tsconfig.json` | TypeScript config |
| `vitest.config.ts` | Test config |
| `.gitignore` | Ignored files |
| `src/types.ts` | Shared interfaces: credentials, token, recording, config schema |
| `src/config.ts` | Read/write `~/.plaud-sync/config.json` (credentials + token) |
| `src/auth.ts` | Plaud API authentication, JWT decode, token refresh |
| `src/client.ts` | Plaud API client: list recordings, get MP3 URL, download audio |
| `src/transcriber.ts` | whisper.cpp subprocess wrapper: ffmpeg convert + transcribe |
| `src/sync.ts` | Sync engine: fetch recordings, download, transcribe, skip existing |
| `src/cli.ts` | Commander CLI: login, sync, install, uninstall commands |
| `bin/plaud-sync.ts` | Executable entry point |
| `test/config.test.ts` | Config unit tests |
| `test/auth.test.ts` | Auth unit tests |
| `test/client.test.ts` | Client unit tests |
| `test/transcriber.test.ts` | Transcriber unit tests |
| `test/sync.test.ts` | Sync engine unit tests |

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Initialize git repo**

```bash
cd /Users/chrischiles/Documents/Agents/plaud-sync
git init
```

- [ ] **Step 2: Create package.json**

Create `package.json`:

```json
{
  "name": "plaud-sync",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "plaud-sync": "tsx bin/plaud-sync.ts"
  },
  "dependencies": {
    "commander": "^13.0.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^3.0.0",
    "tsx": "^4.7.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": ".",
    "skipLibCheck": true
  },
  "include": ["src/**/*", "bin/**/*", "test/**/*"]
}
```

- [ ] **Step 4: Create vitest.config.ts**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
  },
})
```

- [ ] **Step 5: Create .gitignore**

Create `.gitignore`:

```
node_modules/
dist/
*.js
*.d.ts
*.js.map
.DS_Store
```

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated

- [ ] **Step 7: Verify test runner works**

Create a placeholder test to verify vitest runs.

Create `test/setup.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'

describe('setup', () => {
  it('vitest runs', () => {
    expect(true).toBe(true)
  })
})
```

Run: `npm test`
Expected: 1 test passes

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore AGENTS.md test/setup.test.ts docs/
git commit -m "chore: scaffold project with TypeScript, vitest, commander, zod"
```

---

### Task 2: Types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create types file**

Create `src/types.ts`:

```typescript
import { z } from 'zod'

export const BASE_URLS: Record<string, string> = {
  us: 'https://api.plaud.ai',
  eu: 'https://api-euc1.plaud.ai',
}

export const CredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  region: z.enum(['us', 'eu']),
})

export type Credentials = z.infer<typeof CredentialsSchema>

export const TokenDataSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.string(),
  issuedAt: z.number(),
  expiresAt: z.number(),
})

export type TokenData = z.infer<typeof TokenDataSchema>

export const ConfigSchema = z.object({
  credentials: CredentialsSchema.optional(),
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

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared types and zod schemas"
```

---

### Task 3: Config

**Files:**
- Create: `src/config.ts`
- Create: `test/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { PlaudSyncConfig } from '../src/config.js'

describe('PlaudSyncConfig', () => {
  let tmpDir: string
  let config: PlaudSyncConfig

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-sync-test-'))
    config = new PlaudSyncConfig(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns undefined credentials when no config exists', () => {
    expect(config.getCredentials()).toBeUndefined()
  })

  it('returns undefined token when no config exists', () => {
    expect(config.getToken()).toBeUndefined()
  })

  it('saves and loads credentials', () => {
    const creds = { email: 'test@example.com', password: 'secret', region: 'us' as const }
    config.saveCredentials(creds)
    expect(config.getCredentials()).toEqual(creds)
  })

  it('saves and loads token', () => {
    const token = {
      accessToken: 'abc123',
      tokenType: 'Bearer',
      issuedAt: 1000,
      expiresAt: 2000,
    }
    config.saveToken(token)
    expect(config.getToken()).toEqual(token)
  })

  it('merges credentials and token without overwriting', () => {
    const creds = { email: 'test@example.com', password: 'secret', region: 'eu' as const }
    const token = {
      accessToken: 'abc123',
      tokenType: 'Bearer',
      issuedAt: 1000,
      expiresAt: 2000,
    }
    config.saveCredentials(creds)
    config.saveToken(token)
    expect(config.getCredentials()).toEqual(creds)
    expect(config.getToken()).toEqual(token)
  })

  it('creates config directory with mode 0o700', () => {
    const creds = { email: 'test@example.com', password: 'secret', region: 'us' as const }
    config.saveCredentials(creds)
    const stats = fs.statSync(tmpDir)
    expect(stats.mode & 0o777).toBe(0o700)
  })

  it('creates config file with mode 0o600', () => {
    const creds = { email: 'test@example.com', password: 'secret', region: 'us' as const }
    config.saveCredentials(creds)
    const filePath = path.join(tmpDir, 'config.json')
    const stats = fs.statSync(filePath)
    expect(stats.mode & 0o777).toBe(0o600)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `../src/config.js`

- [ ] **Step 3: Write the implementation**

Create `src/config.ts`:

```typescript
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ConfigSchema } from './types.js'
import type { Credentials, TokenData, Config } from './types.js'

const DEFAULT_DIR = path.join(os.homedir(), '.plaud-sync')
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

  saveCredentials(credentials: Credentials): void {
    this.save({ credentials })
  }

  saveToken(token: TokenData): void {
    this.save({ token })
  }

  getCredentials(): Credentials | undefined {
    return this.load().credentials
  }

  getToken(): TokenData | undefined {
    return this.load().token
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All config tests pass

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: add config module for credential and token storage"
```

---

### Task 4: Auth

**Files:**
- Create: `src/auth.ts`
- Create: `test/auth.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/auth.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PlaudAuth } from '../src/auth.js'
import type { PlaudSyncConfig } from '../src/config.js'
import type { TokenData, Credentials } from '../src/types.js'

function makeConfig(overrides: {
  credentials?: Credentials
  token?: TokenData
} = {}): PlaudSyncConfig {
  return {
    getCredentials: vi.fn(() => overrides.credentials),
    getToken: vi.fn(() => overrides.token),
    saveToken: vi.fn(),
    saveCredentials: vi.fn(),
  } as unknown as PlaudSyncConfig
}

describe('PlaudAuth', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns cached token when not expiring soon', async () => {
    const token: TokenData = {
      accessToken: 'cached-token',
      tokenType: 'Bearer',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000, // 90 days out
    }
    const config = makeConfig({ token })
    const auth = new PlaudAuth(config)

    const result = await auth.getToken()
    expect(result).toBe('cached-token')
  })

  it('re-authenticates when token is expiring within 30 days', async () => {
    const token: TokenData = {
      accessToken: 'old-token',
      tokenType: 'Bearer',
      issuedAt: Date.now() - 280 * 24 * 60 * 60 * 1000,
      expiresAt: Date.now() + 20 * 24 * 60 * 60 * 1000, // 20 days out
    }
    const creds: Credentials = { email: 'test@example.com', password: 'pass', region: 'us' }
    const config = makeConfig({ credentials: creds, token })

    // JWT with iat=1000, exp=9999999999
    const fakeJwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      Buffer.from(JSON.stringify({ iat: 1000, exp: 9999999999 })).toString('base64url'),
      'signature',
    ].join('.')

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        status: 0,
        access_token: fakeJwt,
        token_type: 'Bearer',
      })),
    )

    const auth = new PlaudAuth(config)
    const result = await auth.getToken()
    expect(result).toBe(fakeJwt)
    expect(config.saveToken).toHaveBeenCalled()
  })

  it('throws when no credentials are configured', async () => {
    const config = makeConfig()
    const auth = new PlaudAuth(config)

    await expect(auth.getToken()).rejects.toThrow('No credentials configured')
  })

  it('throws on login failure', async () => {
    const creds: Credentials = { email: 'test@example.com', password: 'wrong', region: 'us' }
    const config = makeConfig({ credentials: creds })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        status: -1,
        msg: 'Invalid password',
      })),
    )

    const auth = new PlaudAuth(config)
    await expect(auth.getToken()).rejects.toThrow('Invalid password')
  })

  it('sends credentials to correct US endpoint', async () => {
    const creds: Credentials = { email: 'user@test.com', password: 'pass123', region: 'us' }
    const config = makeConfig({ credentials: creds })

    const fakeJwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      Buffer.from(JSON.stringify({ iat: 1000, exp: 9999999999 })).toString('base64url'),
      'signature',
    ].join('.')

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        status: 0,
        access_token: fakeJwt,
        token_type: 'Bearer',
      })),
    )

    const auth = new PlaudAuth(config)
    await auth.getToken()

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.plaud.ai/auth/access-token',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('sends credentials to correct EU endpoint', async () => {
    const creds: Credentials = { email: 'user@test.com', password: 'pass123', region: 'eu' }
    const config = makeConfig({ credentials: creds })

    const fakeJwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      Buffer.from(JSON.stringify({ iat: 1000, exp: 9999999999 })).toString('base64url'),
      'signature',
    ].join('.')

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        status: 0,
        access_token: fakeJwt,
        token_type: 'Bearer',
      })),
    )

    const auth = new PlaudAuth(config)
    await auth.getToken()

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api-euc1.plaud.ai/auth/access-token',
      expect.anything(),
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `../src/auth.js`

- [ ] **Step 3: Write the implementation**

Create `src/auth.ts`:

```typescript
import type { PlaudSyncConfig } from './config.js'
import { BASE_URLS } from './types.js'
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
    return this.login()
  }

  private async login(): Promise<string> {
    const creds = this.config.getCredentials()
    if (!creds) {
      throw new Error('No credentials configured. Run `plaud-sync login` first.')
    }

    const baseUrl = BASE_URLS[creds.region] ?? BASE_URLS['us']
    const body = new URLSearchParams({
      username: creds.email,
      password: creds.password,
    })

    const res = await fetch(`${baseUrl}/auth/access-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    const data = (await res.json()) as {
      status: number
      msg?: string
      access_token: string
      token_type: string
    }

    if (data.status !== 0 || !data.access_token) {
      throw new Error(data.msg ?? `Login failed (status ${data.status})`)
    }

    const decoded = this.decodeJwtExpiry(data.access_token)
    const tokenData: TokenData = {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      issuedAt: decoded.iat * 1000,
      expiresAt: decoded.exp * 1000,
    }

    this.config.saveToken(tokenData)
    return data.access_token
  }

  private isExpiringSoon(token: TokenData): boolean {
    return Date.now() + TOKEN_REFRESH_BUFFER_MS > token.expiresAt
  }

  private decodeJwtExpiry(jwt: string): { iat: number; exp: number } {
    const parts = jwt.split('.')
    if (parts.length !== 3) throw new Error('Invalid JWT')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    return { iat: payload.iat ?? 0, exp: payload.exp ?? 0 }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All auth tests pass

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts test/auth.test.ts
git commit -m "feat: add auth module with JWT token management"
```

---

### Task 5: API Client

**Files:**
- Create: `src/client.ts`
- Create: `test/client.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PlaudClient } from '../src/client.js'
import type { PlaudAuth } from '../src/auth.js'

function makeAuth(): PlaudAuth {
  return {
    getToken: vi.fn().mockResolvedValue('test-token'),
  } as unknown as PlaudAuth
}

describe('PlaudClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('listRecordings', () => {
    it('returns non-trashed recordings', async () => {
      const auth = makeAuth()
      const client = new PlaudClient(auth, 'us')

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          data_file_list: [
            { id: '1', filename: 'meeting', is_trash: false },
            { id: '2', filename: 'deleted', is_trash: true },
            { id: '3', filename: 'notes', is_trash: false },
          ],
        })),
      )

      const recordings = await client.listRecordings()
      expect(recordings).toHaveLength(2)
      expect(recordings[0].id).toBe('1')
      expect(recordings[1].id).toBe('3')
    })

    it('sends auth header', async () => {
      const auth = makeAuth()
      const client = new PlaudClient(auth, 'us')

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ data_file_list: [] })),
      )

      await client.listRecordings()

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.plaud.ai/file/simple/web',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      )
    })

    it('handles region mismatch by switching region and retrying', async () => {
      const auth = makeAuth()
      const client = new PlaudClient(auth, 'us')

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            status: -302,
            data: { domains: { api: 'api-euc1.plaud.ai' } },
          })),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            data_file_list: [{ id: '1', filename: 'test', is_trash: false }],
          })),
        )

      const recordings = await client.listRecordings()
      expect(recordings).toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(fetchSpy.mock.calls[1][0]).toContain('api-euc1.plaud.ai')
    })
  })

  describe('getMp3Url', () => {
    it('returns URL when available', async () => {
      const auth = makeAuth()
      const client = new PlaudClient(auth, 'us')

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ url: 'https://cdn.example.com/file.mp3' })),
      )

      const url = await client.getMp3Url('rec-123')
      expect(url).toBe('https://cdn.example.com/file.mp3')
    })

    it('returns null on failure', async () => {
      const auth = makeAuth()
      const client = new PlaudClient(auth, 'us')

      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))

      const url = await client.getMp3Url('rec-123')
      expect(url).toBeNull()
    })
  })

  describe('downloadAudio', () => {
    it('returns audio as ArrayBuffer', async () => {
      const auth = makeAuth()
      const client = new PlaudClient(auth, 'us')

      const audioData = new ArrayBuffer(16)
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(audioData, { status: 200 }),
      )

      const result = await client.downloadAudio('rec-123')
      expect(result.byteLength).toBe(16)
    })

    it('throws on HTTP error', async () => {
      const auth = makeAuth()
      const client = new PlaudClient(auth, 'us')

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 404, statusText: 'Not Found' }),
      )

      await expect(client.downloadAudio('rec-123')).rejects.toThrow('Download failed: 404')
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `../src/client.js`

- [ ] **Step 3: Write the implementation**

Create `src/client.ts`:

```typescript
import type { PlaudAuth } from './auth.js'
import { BASE_URLS } from './types.js'
import type { PlaudRecording } from './types.js'

export class PlaudClient {
  private auth: PlaudAuth
  private region: string

  constructor(auth: PlaudAuth, region: string = 'us') {
    this.auth = auth
    this.region = region
  }

  private get baseUrl(): string {
    return BASE_URLS[this.region] ?? BASE_URLS['us']
  }

  private async request(path: string, options?: RequestInit): Promise<any> {
    const token = await this.auth.getToken()
    const url = `${this.baseUrl}${path}`
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    })

    if (!res.ok) {
      throw new Error(`Plaud API error: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()

    if (data?.status === -302 && data?.data?.domains?.api) {
      const domain: string = data.data.domains.api
      this.region = domain.includes('euc1') ? 'eu' : 'us'
      return this.request(path, options)
    }

    return data
  }

  async listRecordings(): Promise<PlaudRecording[]> {
    const data = await this.request('/file/simple/web')
    const list: PlaudRecording[] = data.data_file_list ?? data.data ?? []
    return list.filter((r) => !r.is_trash)
  }

  async getMp3Url(id: string): Promise<string | null> {
    try {
      const data = await this.request(`/file/temp-url/${id}?is_opus=false`)
      return data?.url ?? data?.data?.url ?? data?.data ?? data?.temp_url ?? null
    } catch {
      return null
    }
  }

  async downloadAudio(id: string): Promise<ArrayBuffer> {
    const token = await this.auth.getToken()
    const res = await fetch(`${this.baseUrl}/file/download/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`Download failed: ${res.status}`)
    return res.arrayBuffer()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All client tests pass

- [ ] **Step 5: Commit**

```bash
git add src/client.ts test/client.test.ts
git commit -m "feat: add Plaud API client with list, download, and MP3 URL"
```

---

### Task 6: Transcriber

**Files:**
- Create: `src/transcriber.ts`
- Create: `test/transcriber.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/transcriber.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as childProcess from 'child_process'
import { Transcriber, findWhisperModel } from '../src/transcriber.js'

vi.mock('child_process')

describe('Transcriber', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('converts audio to WAV then runs whisper-cpp', async () => {
    const execFileSpy = vi.mocked(childProcess.execFile)

    // Mock both execFile calls (ffmpeg and whisper-cpp) to call their callbacks with success
    execFileSpy
      .mockImplementationOnce((_cmd, _args, _opts, callback: any) => {
        callback(null, '', '')
        return {} as any
      })
      .mockImplementationOnce((_cmd, _args, _opts, callback: any) => {
        callback(null, '', '')
        return {} as any
      })

    const transcriber = new Transcriber('/models/ggml-large-v3-turbo.bin')
    await transcriber.transcribe('/audio/test.mp3', '/transcripts/test')

    // First call: ffmpeg conversion
    expect(execFileSpy.mock.calls[0][0]).toBe('ffmpeg')
    expect(execFileSpy.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['-i', '/audio/test.mp3', '-ar', '16000', '-ac', '1']),
    )

    // Second call: whisper-cpp
    expect(execFileSpy.mock.calls[1][0]).toBe('whisper-cpp')
    expect(execFileSpy.mock.calls[1][1]).toEqual(
      expect.arrayContaining(['-m', '/models/ggml-large-v3-turbo.bin', '-otxt']),
    )
  })

  it('throws when ffmpeg fails', async () => {
    const execFileSpy = vi.mocked(childProcess.execFile)

    execFileSpy.mockImplementationOnce((_cmd, _args, _opts, callback: any) => {
      callback(new Error('ffmpeg not found'), '', '')
      return {} as any
    })

    const transcriber = new Transcriber('/models/ggml-large-v3-turbo.bin')
    await expect(
      transcriber.transcribe('/audio/test.mp3', '/transcripts/test'),
    ).rejects.toThrow('ffmpeg not found')
  })

  it('throws when whisper-cpp fails', async () => {
    const execFileSpy = vi.mocked(childProcess.execFile)

    execFileSpy
      .mockImplementationOnce((_cmd, _args, _opts, callback: any) => {
        callback(null, '', '')
        return {} as any
      })
      .mockImplementationOnce((_cmd, _args, _opts, callback: any) => {
        callback(new Error('whisper-cpp failed'), '', '')
        return {} as any
      })

    const transcriber = new Transcriber('/models/ggml-large-v3-turbo.bin')
    await expect(
      transcriber.transcribe('/audio/test.mp3', '/transcripts/test'),
    ).rejects.toThrow('whisper-cpp failed')
  })
})

describe('findWhisperModel', () => {
  it('returns the path if it exists', () => {
    // This is an integration-style test — we just check the function signature
    // Actual model existence depends on the machine
    const result = findWhisperModel('/nonexistent/path/model.bin')
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `../src/transcriber.js`

- [ ] **Step 3: Write the implementation**

Create `src/transcriber.ts`:

```typescript
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'

const execFileAsync = promisify(execFile)

const HOMEBREW_MODEL_DIRS = [
  '/opt/homebrew/share/whisper-cpp/models',
  '/usr/local/share/whisper-cpp/models',
]

export class Transcriber {
  private modelPath: string

  constructor(modelPath: string) {
    this.modelPath = modelPath
  }

  async transcribe(audioPath: string, outputBasename: string): Promise<void> {
    const wavPath = `${outputBasename}.tmp.wav`

    try {
      await execFileAsync('ffmpeg', [
        '-i', audioPath,
        '-ar', '16000',
        '-ac', '1',
        '-f', 'wav',
        '-y',
        wavPath,
      ], { timeout: 120_000 })

      await execFileAsync('whisper-cpp', [
        '-m', this.modelPath,
        '-f', wavPath,
        '-otxt',
        '-of', outputBasename,
      ], { timeout: 600_000 })
    } finally {
      if (fs.existsSync(wavPath)) {
        fs.unlinkSync(wavPath)
      }
    }
  }
}

export function findWhisperModel(explicitPath?: string): string | null {
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath
  }

  for (const dir of HOMEBREW_MODEL_DIRS) {
    const candidate = path.join(dir, 'ggml-large-v3-turbo.bin')
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

export function checkPrerequisites(modelPath: string | null): string[] {
  const errors: string[] = []

  try {
    require('child_process').execFileSync('which', ['whisper-cpp'])
  } catch {
    errors.push('whisper-cpp not found. Install with: brew install whisper-cpp')
  }

  try {
    require('child_process').execFileSync('which', ['ffmpeg'])
  } catch {
    errors.push('ffmpeg not found. Install with: brew install ffmpeg')
  }

  if (!modelPath) {
    errors.push(
      'Whisper model not found. Download with: whisper-cpp-download-ggml-model large-v3-turbo',
    )
  }

  return errors
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All transcriber tests pass

- [ ] **Step 5: Commit**

```bash
git add src/transcriber.ts test/transcriber.test.ts
git commit -m "feat: add whisper.cpp transcriber with ffmpeg conversion"
```

---

### Task 7: Sync Engine

**Files:**
- Create: `src/sync.ts`
- Create: `test/sync.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/sync.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { syncRecordings, generateFilename } from '../src/sync.js'
import type { PlaudClient } from '../src/client.js'
import type { Transcriber } from '../src/transcriber.js'
import type { PlaudRecording } from '../src/types.js'

function makeRecording(overrides: Partial<PlaudRecording> = {}): PlaudRecording {
  return {
    id: 'rec-1',
    filename: 'Team Meeting',
    fullname: 'Team Meeting.opus',
    filesize: 1024,
    duration: 60000,
    start_time: new Date('2026-03-25T10:00:00Z').getTime(),
    end_time: new Date('2026-03-25T11:00:00Z').getTime(),
    is_trash: false,
    is_trans: false,
    is_summary: false,
    keywords: [],
    serial_number: 'SN001',
    ...overrides,
  }
}

describe('generateFilename', () => {
  it('formats as YYYY-MM-DD_slug', () => {
    const rec = makeRecording({ filename: 'Team Meeting', start_time: new Date('2026-03-25T10:00:00Z').getTime() })
    expect(generateFilename(rec)).toBe('2026-03-25_Team_Meeting')
  })

  it('strips non-alphanumeric characters', () => {
    const rec = makeRecording({ filename: 'Meeting #3 (important!)' })
    expect(generateFilename(rec)).toBe('2026-03-25_Meeting_3_important_')
  })

  it('truncates slug to 50 characters', () => {
    const rec = makeRecording({ filename: 'A'.repeat(100) })
    const name = generateFilename(rec)
    const slug = name.split('_').slice(1).join('_')
    expect(slug.length).toBeLessThanOrEqual(50)
  })
})

describe('syncRecordings', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-sync-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('downloads and transcribes new recordings', async () => {
    const recordings = [makeRecording()]

    const client: PlaudClient = {
      listRecordings: vi.fn().mockResolvedValue(recordings),
      getMp3Url: vi.fn().mockResolvedValue('https://cdn.example.com/file.mp3'),
      downloadAudio: vi.fn(),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: vi.fn().mockResolvedValue(undefined),
    } as unknown as Transcriber

    // Mock fetch for MP3 download
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new ArrayBuffer(16), { status: 200 }),
    )

    await syncRecordings(client, transcriber, tmpDir)

    const audioDir = path.join(tmpDir, 'audio')
    const transcriptDir = path.join(tmpDir, 'transcripts')
    expect(fs.existsSync(audioDir)).toBe(true)
    expect(fs.existsSync(transcriptDir)).toBe(true)
    expect(client.getMp3Url).toHaveBeenCalledWith('rec-1')
    expect(transcriber.transcribe).toHaveBeenCalled()
  })

  it('skips recordings that already have audio files', async () => {
    const recordings = [makeRecording()]

    const client: PlaudClient = {
      listRecordings: vi.fn().mockResolvedValue(recordings),
      getMp3Url: vi.fn(),
      downloadAudio: vi.fn(),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: vi.fn(),
    } as unknown as Transcriber

    // Pre-create the audio file
    const audioDir = path.join(tmpDir, 'audio')
    fs.mkdirSync(audioDir, { recursive: true })
    fs.writeFileSync(path.join(audioDir, '2026-03-25_Team_Meeting.mp3'), 'existing')

    // Pre-create the transcript file
    const transcriptDir = path.join(tmpDir, 'transcripts')
    fs.mkdirSync(transcriptDir, { recursive: true })
    fs.writeFileSync(path.join(transcriptDir, '2026-03-25_Team_Meeting.txt'), 'existing')

    await syncRecordings(client, transcriber, tmpDir)

    expect(client.getMp3Url).not.toHaveBeenCalled()
    expect(transcriber.transcribe).not.toHaveBeenCalled()
  })

  it('transcribes when audio exists but transcript does not', async () => {
    const recordings = [makeRecording()]

    const client: PlaudClient = {
      listRecordings: vi.fn().mockResolvedValue(recordings),
      getMp3Url: vi.fn(),
      downloadAudio: vi.fn(),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: vi.fn().mockResolvedValue(undefined),
    } as unknown as Transcriber

    // Pre-create only the audio file
    const audioDir = path.join(tmpDir, 'audio')
    fs.mkdirSync(audioDir, { recursive: true })
    fs.writeFileSync(path.join(audioDir, '2026-03-25_Team_Meeting.mp3'), 'audio-data')

    await syncRecordings(client, transcriber, tmpDir)

    expect(client.getMp3Url).not.toHaveBeenCalled()
    expect(transcriber.transcribe).toHaveBeenCalled()
  })

  it('falls back to opus download when MP3 URL is null', async () => {
    const recordings = [makeRecording()]

    const client: PlaudClient = {
      listRecordings: vi.fn().mockResolvedValue(recordings),
      getMp3Url: vi.fn().mockResolvedValue(null),
      downloadAudio: vi.fn().mockResolvedValue(new ArrayBuffer(16)),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: vi.fn().mockResolvedValue(undefined),
    } as unknown as Transcriber

    await syncRecordings(client, transcriber, tmpDir)

    expect(client.downloadAudio).toHaveBeenCalledWith('rec-1')
    const audioDir = path.join(tmpDir, 'audio')
    const files = fs.readdirSync(audioDir)
    expect(files.some((f) => f.endsWith('.opus'))).toBe(true)
  })

  it('continues to next recording when one fails', async () => {
    const recordings = [
      makeRecording({ id: 'rec-1', filename: 'First' }),
      makeRecording({ id: 'rec-2', filename: 'Second', start_time: new Date('2026-03-26T10:00:00Z').getTime() }),
    ]

    const client: PlaudClient = {
      listRecordings: vi.fn().mockResolvedValue(recordings),
      getMp3Url: vi.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce('https://cdn.example.com/second.mp3'),
      downloadAudio: vi.fn(),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: vi.fn().mockResolvedValue(undefined),
    } as unknown as Transcriber

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new ArrayBuffer(16), { status: 200 }),
    )

    await syncRecordings(client, transcriber, tmpDir)

    // Second recording should still be processed
    expect(transcriber.transcribe).toHaveBeenCalledTimes(1)
  })

  it('sorts recordings by start_time ascending', async () => {
    const recordings = [
      makeRecording({ id: 'rec-2', filename: 'Later', start_time: 2000 }),
      makeRecording({ id: 'rec-1', filename: 'Earlier', start_time: 1000 }),
    ]

    const processOrder: string[] = []

    const client: PlaudClient = {
      listRecordings: vi.fn().mockResolvedValue(recordings),
      getMp3Url: vi.fn().mockImplementation((id: string) => {
        processOrder.push(id)
        return Promise.resolve('https://cdn.example.com/file.mp3')
      }),
      downloadAudio: vi.fn(),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: vi.fn().mockResolvedValue(undefined),
    } as unknown as Transcriber

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new ArrayBuffer(16), { status: 200 }),
    )

    await syncRecordings(client, transcriber, tmpDir)

    expect(processOrder).toEqual(['rec-1', 'rec-2'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `../src/sync.js`

- [ ] **Step 3: Write the implementation**

Create `src/sync.ts`:

```typescript
import * as fs from 'fs'
import * as path from 'path'
import type { PlaudClient } from './client.js'
import type { Transcriber } from './transcriber.js'
import type { PlaudRecording } from './types.js'

export function generateFilename(rec: PlaudRecording): string {
  const date = new Date(rec.start_time).toISOString().slice(0, 10)
  const slug = rec.filename.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 50)
  return `${date}_${slug}`
}

function findExistingAudio(audioDir: string, baseName: string): string | null {
  for (const ext of ['mp3', 'opus']) {
    const filePath = path.join(audioDir, `${baseName}.${ext}`)
    if (fs.existsSync(filePath)) return filePath
  }
  return null
}

export async function syncRecordings(
  client: PlaudClient,
  transcriber: Transcriber,
  outputFolder: string,
): Promise<void> {
  const audioDir = path.join(outputFolder, 'audio')
  const transcriptDir = path.join(outputFolder, 'transcripts')
  fs.mkdirSync(audioDir, { recursive: true })
  fs.mkdirSync(transcriptDir, { recursive: true })

  const recordings = await client.listRecordings()
  const sorted = [...recordings].sort((a, b) => a.start_time - b.start_time)

  let synced = 0
  let skipped = 0
  let failed = 0

  for (const rec of sorted) {
    const baseName = generateFilename(rec)

    try {
      let audioPath = findExistingAudio(audioDir, baseName)

      if (!audioPath) {
        audioPath = await downloadRecording(client, rec.id, audioDir, baseName)
        synced++
      } else {
        skipped++
      }

      const transcriptPath = path.join(transcriptDir, `${baseName}.txt`)
      if (!fs.existsSync(transcriptPath)) {
        const transcriptBasename = path.join(transcriptDir, baseName)
        await transcriber.transcribe(audioPath, transcriptBasename)
      }
    } catch (err) {
      failed++
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Failed to sync ${rec.filename} (${rec.id}): ${message}\n`)
    }
  }

  process.stdout.write(
    `Sync complete: ${synced} new, ${skipped} skipped, ${failed} failed (${sorted.length} total)\n`,
  )
}

async function downloadRecording(
  client: PlaudClient,
  id: string,
  audioDir: string,
  baseName: string,
): Promise<string> {
  const mp3Url = await client.getMp3Url(id)

  if (mp3Url) {
    const res = await fetch(mp3Url)
    const buffer = await res.arrayBuffer()
    const filePath = path.join(audioDir, `${baseName}.mp3`)
    fs.writeFileSync(filePath, Buffer.from(buffer))
    return filePath
  }

  const buffer = await client.downloadAudio(id)
  const filePath = path.join(audioDir, `${baseName}.opus`)
  fs.writeFileSync(filePath, Buffer.from(buffer))
  return filePath
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All sync tests pass

- [ ] **Step 5: Commit**

```bash
git add src/sync.ts test/sync.test.ts
git commit -m "feat: add idempotent sync engine with download and transcription"
```

---

### Task 8: CLI Commands

**Files:**
- Create: `src/cli.ts`
- Create: `bin/plaud-sync.ts`

- [ ] **Step 1: Create the CLI module**

Create `src/cli.ts`:

```typescript
import { Command } from 'commander'
import * as readline from 'readline'
import * as os from 'os'
import * as path from 'path'
import { PlaudSyncConfig } from './config.js'
import { PlaudAuth } from './auth.js'
import { PlaudClient } from './client.js'
import { Transcriber, findWhisperModel, checkPrerequisites } from './transcriber.js'
import { syncRecordings } from './sync.js'
import type { Credentials } from './types.js'

const DEFAULT_OUTPUT = path.join(os.homedir(), 'PlaudSync')

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function loginCommand(): Promise<void> {
  const email = await prompt('Email: ')
  const password = await prompt('Password: ')
  const regionInput = await prompt('Region (us/eu) [us]: ')
  const region = (regionInput === 'eu' ? 'eu' : 'us') as Credentials['region']

  const config = new PlaudSyncConfig()
  config.saveCredentials({ email, password, region })

  const auth = new PlaudAuth(config)
  try {
    await auth.getToken()
    process.stdout.write('Login successful. Token saved.\n')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Login failed: ${message}\n`)
    process.exit(1)
  }
}

async function syncCommand(folder: string): Promise<void> {
  const config = new PlaudSyncConfig()
  const creds = config.getCredentials()

  if (!creds) {
    process.stderr.write('No credentials configured. Run `plaud-sync login` first.\n')
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
  const client = new PlaudClient(auth, creds.region)
  const transcriber = new Transcriber(modelPath!)

  await syncRecordings(client, transcriber, folder)
}

export function createProgram(): Command {
  const program = new Command()
  program.name('plaud-sync').description('Sync Plaud recordings and transcribe locally').version('0.1.0')

  program
    .command('login')
    .description('Configure Plaud credentials')
    .action(loginCommand)

  program
    .command('sync')
    .description('Sync recordings and transcribe locally')
    .argument('[folder]', 'Output folder', DEFAULT_OUTPUT)
    .action(syncCommand)

  return program
}
```

- [ ] **Step 2: Create the executable entry point**

Create `bin/plaud-sync.ts`:

```typescript
#!/usr/bin/env npx tsx
import { createProgram } from '../src/cli.js'

createProgram().parse()
```

- [ ] **Step 3: Make entry point executable**

Run: `chmod +x bin/plaud-sync.ts`

- [ ] **Step 4: Verify CLI loads without errors**

Run: `npx tsx bin/plaud-sync.ts --help`
Expected: Shows usage with `login`, `sync` commands listed

- [ ] **Step 5: Run all tests to ensure nothing broke**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts bin/plaud-sync.ts
git commit -m "feat: add CLI with login and sync commands"
```

---

### Task 9: LaunchAgent Install/Uninstall

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add install and uninstall commands to cli.ts**

Add the following imports to the top of `src/cli.ts` (alongside existing imports):

```typescript
import * as fs from 'fs'
import { execFileSync } from 'child_process'
```

Then add the following before the `export function createProgram()` function:

```typescript
const PLIST_LABEL = 'com.plaud-sync.agent'
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`)
const LOG_DIR = path.join(os.homedir(), '.plaud-sync', 'logs')

function generatePlist(intervalMinutes: number, outputFolder: string): string {
  const binPath = process.argv[1]
  const tsxPath = process.argv[0]

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${tsxPath}</string>
    <string>${binPath}</string>
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

function installCommand(folder: string, options: { interval: string }): void {
  const intervalMinutes = parseInt(options.interval, 10)
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
```

Then add the commands to `createProgram()`, after the `sync` command:

```typescript
  program
    .command('install')
    .description('Install launchd agent for automatic syncing')
    .argument('[folder]', 'Output folder', DEFAULT_OUTPUT)
    .option('--interval <minutes>', 'Sync interval in minutes', '30')
    .action(installCommand)

  program
    .command('uninstall')
    .description('Remove launchd agent')
    .action(uninstallCommand)
```

- [ ] **Step 2: Verify CLI shows new commands**

Run: `npx tsx bin/plaud-sync.ts --help`
Expected: Shows `login`, `sync`, `install`, `uninstall` commands

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add install/uninstall commands for launchd scheduling"
```

---

### Task 10: Delete Setup Test & Final Verification

**Files:**
- Delete: `test/setup.test.ts`

- [ ] **Step 1: Remove placeholder test**

```bash
rm test/setup.test.ts
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass (config, auth, client, transcriber, sync)

- [ ] **Step 3: Verify CLI end-to-end**

Run: `npx tsx bin/plaud-sync.ts --help`
Expected: Clean help output with all 4 commands

Run: `npx tsx bin/plaud-sync.ts sync --help`
Expected: Shows folder argument and description

- [ ] **Step 4: Commit**

```bash
git rm test/setup.test.ts
git commit -m "chore: remove placeholder test, verify final build"
```
