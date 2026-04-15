import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test'
import { PlaudClient } from '../src/client.js'
import type { PlaudAuth } from '../src/auth.js'

function makeAuth(): PlaudAuth {
  return {
    getToken: mock(() => Promise.resolve('test-token')),
  } as unknown as PlaudAuth
}

describe('PlaudClient', () => {
  beforeEach(() => {
    mock.restore()
  })

  describe('listRecordings', () => {
    it('returns non-trashed recordings', async () => {
      const auth = makeAuth()
      const client = new PlaudClient(auth, 'us')

      spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(
        new Response(JSON.stringify({
          data_file_list: [
            { id: '1', filename: 'meeting', is_trash: false },
            { id: '2', filename: 'deleted', is_trash: true },
            { id: '3', filename: 'notes', is_trash: false },
          ],
        })),
      )) as unknown as typeof fetch)

      const recordings = await client.listRecordings()
      expect(recordings).toHaveLength(2)
      expect(recordings[0].id).toBe('1')
      expect(recordings[1].id).toBe('3')
    })

    it('sends auth header', async () => {
      const auth = makeAuth()
      const client = new PlaudClient(auth, 'us')

      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(
        new Response(JSON.stringify({ data_file_list: [] })),
      )) as unknown as typeof fetch)

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

      const fetchSpy = spyOn(globalThis, 'fetch')
        .mockImplementationOnce((() => Promise.resolve(
          new Response(JSON.stringify({
            status: -302,
            data: { domains: { api: 'api-euc1.plaud.ai' } },
          })),
        )) as unknown as typeof fetch)
        .mockImplementationOnce((() => Promise.resolve(
          new Response(JSON.stringify({
            data_file_list: [{ id: '1', filename: 'test', is_trash: false }],
          })),
        )) as unknown as typeof fetch)

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

      spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(
        new Response(JSON.stringify({ url: 'https://cdn.example.com/file.mp3' })),
      )) as unknown as typeof fetch)

      const url = await client.getMp3Url('rec-123')
      expect(url).toBe('https://cdn.example.com/file.mp3')
    })

    it('returns null on failure', async () => {
      const auth = makeAuth()
      const client = new PlaudClient(auth, 'us')

      spyOn(globalThis, 'fetch').mockImplementation((() => Promise.reject(new Error('Network error'))) as unknown as typeof fetch)

      const url = await client.getMp3Url('rec-123')
      expect(url).toBeNull()
    })
  })

  describe('downloadAudio', () => {
    it('returns audio as ArrayBuffer', async () => {
      const auth = makeAuth()
      const client = new PlaudClient(auth, 'us')

      const audioData = new ArrayBuffer(16)
      spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(
        new Response(audioData, { status: 200 }),
      )) as unknown as typeof fetch)

      const result = await client.downloadAudio('rec-123')
      expect(result.byteLength).toBe(16)
    })

    it('throws on HTTP error', async () => {
      const auth = makeAuth()
      const client = new PlaudClient(auth, 'us')

      spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(
        new Response(null, { status: 404, statusText: 'Not Found' }),
      )) as unknown as typeof fetch)

      await expect(client.downloadAudio('rec-123')).rejects.toThrow('Download failed: 404')
    })
  })
})
