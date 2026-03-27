import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test'
import { PlaudAuth } from '../src/auth.js'
import type { PlaudSyncConfig } from '../src/config.js'
import type { TokenData, Credentials } from '../src/types.js'

function makeConfig(overrides: {
  credentials?: Credentials
  token?: TokenData
} = {}): PlaudSyncConfig {
  return {
    getCredentials: mock(() => overrides.credentials),
    getToken: mock(() => overrides.token),
    saveToken: mock(() => undefined),
    saveCredentials: mock(() => undefined),
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

    spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({
        status: 0,
        access_token: fakeJwt,
        token_type: 'Bearer',
      })),
    ))

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

    spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({
        status: -1,
        msg: 'Invalid password',
      })),
    ))

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

    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({
        status: 0,
        access_token: fakeJwt,
        token_type: 'Bearer',
      })),
    ))

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

    spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({
        status: 0,
        access_token: fakeJwt,
        token_type: 'Bearer',
      })),
    ))

    const auth = new PlaudAuth(config)
    await auth.getToken()

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api-euc1.plaud.ai/auth/access-token',
      expect.anything(),
    )
  })
})
