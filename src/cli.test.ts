import { describe, expect, test } from 'bun:test'
import { parseTokenFromCapture, decodeJwtExpiry, parseSyncCommand } from './cli.js'
import { parseInstallCommand, generatePlist } from './cli-support.js'

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

describe('parseSyncCommand', () => {
  test('parses new sync filters and flags', () => {
    const parsed = parseSyncCommand([
      '/tmp/output',
      '--limit', '3',
      '--since', '2026-04-01',
      '--max-runtime-minutes', '20',
      '--recording-order', 'oldest',
      '--dry-run',
      '--keep-audio',
    ])

    expect(parsed.folder).toBe('/tmp/output')
    expect(parsed.options.limit).toBe(3)
    expect(parsed.options.since).toBe(Date.parse('2026-04-01T00:00:00Z'))
    expect(parsed.options.maxRuntimeMinutes).toBe(20)
    expect(parsed.options.recordingOrder).toBe('oldest')
    expect(parsed.options.dryRun).toBe(true)
    expect(parsed.options.deleteAudioAfterTranscribe).toBe(false)
  })

  test('keeps deprecated concurrency for warning purposes', () => {
    const parsed = parseSyncCommand(['--concurrency', '2'])
    expect(parsed.deprecatedConcurrency).toBe(2)
  })

  test('rejects invalid recording order values', () => {
    expect(() => parseSyncCommand(['--recording-order', 'latest'])).toThrow(
      '`--recording-order` must be `newest` or `oldest`.',
    )
  })
})

describe('parseInstallCommand', () => {
  test('parses launch agent options', () => {
    const parsed = parseInstallCommand([
      '/tmp/output',
      '--interval', '120',
      '--max-runtime-minutes', '30',
      '--recording-order', 'oldest',
      '--run-at-load', 'false',
      '--no-diarize',
    ])

    expect(parsed.folder).toBe('/tmp/output')
    expect(parsed.intervalMinutes).toBe(120)
    expect(parsed.maxRuntimeMinutes).toBe(30)
    expect(parsed.recordingOrder).toBe('oldest')
    expect(parsed.runAtLoad).toBe(false)
    expect(parsed.noDiarize).toBe(true)
  })
})

describe('generatePlist', () => {
  test('includes sync flags in program arguments', () => {
    const plist = generatePlist({
      intervalMinutes: 60,
      syncArgs: ['sync', '/tmp/output', '--recording-order', 'oldest', '--max-runtime-minutes', '20'],
      runAtLoad: true,
    })

    expect(plist).toContain('<string>sync</string>')
    expect(plist).toContain('<string>--recording-order</string>')
    expect(plist).toContain('<string>oldest</string>')
    expect(plist).toContain('<true/>')
  })
})
