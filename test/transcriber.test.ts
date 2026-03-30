import { describe, it, expect, mock } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { Transcriber, checkPrerequisites } from '../src/transcriber.js'

describe('Transcriber', () => {
  it('calls whisperx with diarize flag and formats output', async () => {
    const segments = {
      segments: [
        { start: 0, end: 2, text: 'Hello there.', speaker: 'SPEAKER_00' },
        { start: 2, end: 4, text: 'Hi, how are you?', speaker: 'SPEAKER_01' },
      ],
    }

    const fakeExec = mock((cmd: string) => {
      const match = cmd.match(/'--output_dir' '([^']+)'/)
      if (match) {
        const outDir = match[1]
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(path.join(outDir, 'test.json'), JSON.stringify(segments))
      }
    })

    const outputPath = path.join(os.tmpdir(), `plaud-test-${Date.now()}.txt`)

    try {
      const transcriber = new Transcriber(fakeExec as any)
      await transcriber.transcribe('/audio/test.mp3', outputPath)

      expect(fakeExec).toHaveBeenCalledTimes(1)
      const cmd = fakeExec.mock.calls[0][0] as string
      expect(cmd).toContain('whisperx')
      expect(cmd).toContain('--diarize')
      expect(cmd).toContain('large-v3-turbo')

      const result = fs.readFileSync(outputPath, 'utf-8')
      expect(result).toContain('[SPEAKER_00]')
      expect(result).toContain('Hello there.')
      expect(result).toContain('[SPEAKER_01]')
      expect(result).toContain('Hi, how are you?')
    } finally {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
    }
  })

  it('throws when whisperx fails', async () => {
    const fakeExec = mock(() => {
      throw new Error('whisperx not found')
    })

    const transcriber = new Transcriber(fakeExec as any)
    await expect(
      transcriber.transcribe('/audio/test.mp3', '/transcripts/test.txt'),
    ).rejects.toThrow('whisperx not found')
  })
})

describe('checkPrerequisites', () => {
  it('returns error when HF_TOKEN is not set', () => {
    const original = process.env.HF_TOKEN
    delete process.env.HF_TOKEN

    const errors = checkPrerequisites()
    expect(errors.some((e: string) => e.includes('HF_TOKEN'))).toBe(true)

    if (original) process.env.HF_TOKEN = original
  })
})
