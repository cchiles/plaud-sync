import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
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

  it('returns undefined token when no config exists', () => {
    expect(config.getToken()).toBeUndefined()
  })

  it('saves and loads token', () => {
    const token = {
      accessToken: 'abc123',
      tokenType: 'Bearer',
      issuedAt: 1000,
      expiresAt: 2000,
      region: 'us' as const,
    }
    config.saveToken(token)
    expect(config.getToken()).toEqual(token)
  })

  it('creates config directory with mode 0o700', () => {
    const token = {
      accessToken: 'abc123',
      tokenType: 'Bearer',
      issuedAt: 1000,
      expiresAt: 2000,
      region: 'us' as const,
    }
    config.saveToken(token)
    const stats = fs.statSync(tmpDir)
    expect(stats.mode & 0o777).toBe(0o700)
  })

  it('creates config file with mode 0o600', () => {
    const token = {
      accessToken: 'abc123',
      tokenType: 'Bearer',
      issuedAt: 1000,
      expiresAt: 2000,
      region: 'us' as const,
    }
    config.saveToken(token)
    const filePath = path.join(tmpDir, 'config.json')
    const stats = fs.statSync(filePath)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('migrates from a legacy config directory into the canonical directory', () => {
    const canonicalDir = path.join(tmpDir, 'app-support')
    const legacyDir = path.join(tmpDir, 'legacy')
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(
      path.join(legacyDir, 'config.json'),
      JSON.stringify({
        token: {
          accessToken: 'legacy-token',
          tokenType: 'Bearer',
          issuedAt: 1000,
          expiresAt: 2000,
          region: 'us',
        },
      }),
    )

    config = new PlaudSyncConfig(canonicalDir, legacyDir)

    expect(config.getToken()?.accessToken).toBe('legacy-token')
    expect(fs.existsSync(path.join(canonicalDir, 'config.json'))).toBe(true)
  })
})
