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

  test('migrates config from legacy path when canonical file is missing', () => {
    const canonicalDir = path.join(tmpDir, 'Library', 'Application Support', 'plaud-sync')
    const legacyDir = path.join(tmpDir, '.config', 'plaud-sync')
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(
      path.join(legacyDir, 'config.json'),
      JSON.stringify({
        token: {
          accessToken: 'legacy-token',
          tokenType: 'Bearer',
          issuedAt: 1700000000000,
          expiresAt: 1726000000000,
          region: 'us',
        },
      }),
    )

    const config = new PlaudSyncConfig(canonicalDir, legacyDir)
    expect(config.getToken()?.accessToken).toBe('legacy-token')
    expect(fs.existsSync(path.join(canonicalDir, 'config.json'))).toBe(true)
  })
})
