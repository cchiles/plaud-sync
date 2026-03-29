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
