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
