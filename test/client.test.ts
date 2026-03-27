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
