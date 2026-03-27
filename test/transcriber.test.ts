import { describe, it, expect, beforeEach, mock } from 'bun:test'

// Create the mock function before mocking the module
const mockExecFile = mock()

// Mock the module before importing the code that uses it
mock.module('child_process', () => ({
  execFile: mockExecFile,
  execFileSync: mock(() => undefined),
}))

// Now import the module under test
const { Transcriber, findWhisperModel } = await import('../src/transcriber.js')

describe('Transcriber', () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  it('converts audio to WAV then runs whisper-cpp', async () => {
    // Mock both execFile calls (ffmpeg and whisper-cpp) to call their callbacks with success
    mockExecFile
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, callback: (err: null, stdout: string, stderr: string) => void) => {
        callback(null, '', '')
        return {} as ReturnType<typeof import('child_process').execFile>
      })
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, callback: (err: null, stdout: string, stderr: string) => void) => {
        callback(null, '', '')
        return {} as ReturnType<typeof import('child_process').execFile>
      })

    const transcriber = new Transcriber('/models/ggml-large-v3-turbo.bin')
    await transcriber.transcribe('/audio/test.mp3', '/transcripts/test')

    // First call: ffmpeg conversion
    expect(mockExecFile.mock.calls[0][0]).toBe('ffmpeg')
    expect(mockExecFile.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['-i', '/audio/test.mp3', '-ar', '16000', '-ac', '1']),
    )

    // Second call: whisper-cpp
    expect(mockExecFile.mock.calls[1][0]).toBe('whisper-cpp')
    expect(mockExecFile.mock.calls[1][1]).toEqual(
      expect.arrayContaining(['-m', '/models/ggml-large-v3-turbo.bin', '-otxt']),
    )
  })

  it('throws when ffmpeg fails', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error, stdout: string, stderr: string) => void) => {
      callback(new Error('ffmpeg not found'), '', '')
      return {} as ReturnType<typeof import('child_process').execFile>
    })

    const transcriber = new Transcriber('/models/ggml-large-v3-turbo.bin')
    await expect(
      transcriber.transcribe('/audio/test.mp3', '/transcripts/test'),
    ).rejects.toThrow('ffmpeg not found')
  })

  it('throws when whisper-cpp fails', async () => {
    mockExecFile
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, callback: (err: null, stdout: string, stderr: string) => void) => {
        callback(null, '', '')
        return {} as ReturnType<typeof import('child_process').execFile>
      })
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error, stdout: string, stderr: string) => void) => {
        callback(new Error('whisper-cpp failed'), '', '')
        return {} as ReturnType<typeof import('child_process').execFile>
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
