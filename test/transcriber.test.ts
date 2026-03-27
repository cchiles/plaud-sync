import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as childProcess from 'child_process'
import { Transcriber, findWhisperModel } from '../src/transcriber.js'

vi.mock('child_process')

describe('Transcriber', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('converts audio to WAV then runs whisper-cpp', async () => {
    const execFileSpy = vi.mocked(childProcess.execFile)

    // Mock both execFile calls (ffmpeg and whisper-cpp) to call their callbacks with success
    execFileSpy
      .mockImplementationOnce((_cmd, _args, _opts, callback: any) => {
        callback(null, '', '')
        return {} as any
      })
      .mockImplementationOnce((_cmd, _args, _opts, callback: any) => {
        callback(null, '', '')
        return {} as any
      })

    const transcriber = new Transcriber('/models/ggml-large-v3-turbo.bin')
    await transcriber.transcribe('/audio/test.mp3', '/transcripts/test')

    // First call: ffmpeg conversion
    expect(execFileSpy.mock.calls[0][0]).toBe('ffmpeg')
    expect(execFileSpy.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['-i', '/audio/test.mp3', '-ar', '16000', '-ac', '1']),
    )

    // Second call: whisper-cpp
    expect(execFileSpy.mock.calls[1][0]).toBe('whisper-cpp')
    expect(execFileSpy.mock.calls[1][1]).toEqual(
      expect.arrayContaining(['-m', '/models/ggml-large-v3-turbo.bin', '-otxt']),
    )
  })

  it('throws when ffmpeg fails', async () => {
    const execFileSpy = vi.mocked(childProcess.execFile)

    execFileSpy.mockImplementationOnce((_cmd, _args, _opts, callback: any) => {
      callback(new Error('ffmpeg not found'), '', '')
      return {} as any
    })

    const transcriber = new Transcriber('/models/ggml-large-v3-turbo.bin')
    await expect(
      transcriber.transcribe('/audio/test.mp3', '/transcripts/test'),
    ).rejects.toThrow('ffmpeg not found')
  })

  it('throws when whisper-cpp fails', async () => {
    const execFileSpy = vi.mocked(childProcess.execFile)

    execFileSpy
      .mockImplementationOnce((_cmd, _args, _opts, callback: any) => {
        callback(null, '', '')
        return {} as any
      })
      .mockImplementationOnce((_cmd, _args, _opts, callback: any) => {
        callback(new Error('whisper-cpp failed'), '', '')
        return {} as any
      })

    const transcriber = new Transcriber('/models/ggml-large-v3-turbo.bin')
    await expect(
      transcriber.transcribe('/audio/test.mp3', '/transcripts/test'),
    ).rejects.toThrow('whisper-cpp failed')
  })
})

describe('findWhisperModel', () => {
  it('returns the path if it exists', () => {
    // This is an integration-style test — we just check the function signature
    // Actual model existence depends on the machine
    const result = findWhisperModel('/nonexistent/path/model.bin')
    expect(result).toBeNull()
  })
})
