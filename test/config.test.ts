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
