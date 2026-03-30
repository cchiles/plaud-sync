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

  test('rejects missing region', () => {
    const result = TokenDataSchema.safeParse({
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcyNjAwMDAwMH0.sig',
      tokenType: 'Bearer',
      issuedAt: 1700000000000,
      expiresAt: 1726000000000,
    })
    expect(result.success).toBe(false)
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
  test('accepts config with token', () => {
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
