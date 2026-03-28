import { describe, it, expect, beforeEach, mock } from 'bun:test'

const mockExecFile = mock()

mock.module('child_process', () => ({
  execFile: mockExecFile,
  execFileSync: mock(() => undefined),
}))

const { Transcriber, findWhisperModel } = await import('../src/transcriber.js')

describe('Transcriber', () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  it('calls whisper-cli with correct args', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, callback: (err: null, stdout: string, stderr: string) => void) => {
      callback(null, '', '')
      return {} as ReturnType<typeof import('child_process').execFile>
    })

    const transcriber = new Transcriber('/models/ggml-large-v3-turbo.bin')
    await transcriber.transcribe('/audio/test.mp3', '/transcripts/test')

    expect(mockExecFile.mock.calls[0][0]).toBe('whisper-cli')
    expect(mockExecFile.mock.calls[0][1]).toEqual([
      '-m', '/models/ggml-large-v3-turbo.bin',
      '-f', '/audio/test.mp3',
      '-otxt',
      '-of', '/transcripts/test',
    ])
  })

  it('throws when whisper-cli fails', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error, stdout: string, stderr: string) => void) => {
      callback(new Error('whisper-cli failed'), '', '')
      return {} as ReturnType<typeof import('child_process').execFile>
    })

    const transcriber = new Transcriber('/models/ggml-large-v3-turbo.bin')
    await expect(
      transcriber.transcribe('/audio/test.mp3', '/transcripts/test'),
    ).rejects.toThrow('whisper-cli failed')
  })
})

describe('findWhisperModel', () => {
  it('returns null for nonexistent path', () => {
    const result = findWhisperModel('/nonexistent/path/model.bin')
    expect(result).toBeNull()
  })
})
