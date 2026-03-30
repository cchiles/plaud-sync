import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { PlaudAuth } from '../src/auth.js'
import type { PlaudSyncConfig } from '../src/config.js'
import type { TokenData } from '../src/types.js'

function makeConfig(overrides: {
  token?: TokenData
} = {}): PlaudSyncConfig {
  return {
    getToken: mock(() => overrides.token),
    saveToken: mock(() => undefined),
  } as unknown as PlaudSyncConfig
}

describe('PlaudAuth', () => {
  beforeEach(() => {
    mock.restore()
  })

  it('returns cached token when not expiring soon', async () => {
    const token: TokenData = {
      accessToken: 'cached-token',
      tokenType: 'Bearer',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000, // 90 days out
      region: 'us',
    }
    const config = makeConfig({ token })
    const auth = new PlaudAuth(config)

    const result = await auth.getToken()
    expect(result).toBe('cached-token')
  })

  it('throws when token is expiring within 30 days', async () => {
    const token: TokenData = {
      accessToken: 'old-token',
      tokenType: 'Bearer',
      issuedAt: Date.now() - 280 * 24 * 60 * 60 * 1000,
      expiresAt: Date.now() + 20 * 24 * 60 * 60 * 1000, // 20 days out
      region: 'us',
    }
    const config = makeConfig({ token })
    const auth = new PlaudAuth(config)

    await expect(auth.getToken()).rejects.toThrow('plaud-sync login')
  })

  it('throws when no token exists', async () => {
    const config = makeConfig()
    const auth = new PlaudAuth(config)

    await expect(auth.getToken()).rejects.toThrow('plaud-sync login')
  })
})
