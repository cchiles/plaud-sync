import { describe, it, expect, spyOn } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as child_process from 'child_process'
import { EventEmitter } from 'events'
import {
  Transcriber,
  assessTranscriptionSafety,
  checkPrerequisites,
  parseMacOSVmStatSnapshot,
} from '../src/transcriber.js'

describe('Transcriber', () => {
  it('runs mlx_whisper then diarize and merges output', async () => {
    const mlxOutput = {
      text: 'Hello there. Hi, how are you?',
      segments: [
        { id: 0, start: 0.0, end: 2.0, text: ' Hello there.' },
        { id: 1, start: 2.0, end: 4.0, text: ' Hi, how are you?' },
      ],
    }

    const diarizeOutput = [
      { start: 0.0, end: 2.5, speaker: 'SPEAKER_00' },
      { start: 2.5, end: 5.0, speaker: 'SPEAKER_01' },
    ]

    let callCount = 0
    const spy = spyOn(child_process, 'spawn').mockImplementation(((_cmd: string, args: string[]) => {
      const emitter = new EventEmitter() as any
      emitter.stdout = new EventEmitter()
      emitter.stderr = new EventEmitter()

      callCount++
      if (callCount === 1) {
        // mlx_whisper call — write JSON to output dir
        const outDirIdx = args.indexOf('--output-dir')
        if (outDirIdx !== -1) {
          const outDir = args[outDirIdx + 1]
          const audioArg = args.find((value) => value.endsWith('.mp3'))!
          const baseName = path.basename(audioArg, '.mp3')
          fs.mkdirSync(outDir, { recursive: true })
          fs.writeFileSync(path.join(outDir, `${baseName}.json`), JSON.stringify(mlxOutput))
        }
        setTimeout(() => emitter.emit('close', 0), 0)
      } else {
        // diarize call — emit JSON to stdout
        setTimeout(() => {
          emitter.stdout.emit('data', Buffer.from(JSON.stringify(diarizeOutput)))
          emitter.emit('close', 0)
        }, 0)
      }

      return emitter
    }) as any)

    const audioPath = path.join(os.tmpdir(), `plaud-test-${Date.now()}.mp3`)
    const outputPath = path.join(os.tmpdir(), `plaud-test-${Date.now()}.txt`)
    fs.writeFileSync(audioPath, Buffer.alloc(1024))

    try {
      const transcriber = new Transcriber()
      await transcriber.transcribe(audioPath, outputPath, 'hf_test_token')

      expect(spy).toHaveBeenCalledTimes(2)

      // First call should be mlx_whisper
      const firstArgs = spy.mock.calls[0][1] as string[]
      expect(firstArgs).toContain('mlx_whisper')
      expect(firstArgs).toContain('mlx-community/whisper-small-mlx')

      // Second call should be diarize
      const secondArgs = spy.mock.calls[1][1] as string[]
      expect(secondArgs.some((a: string) => a.includes('diarize.py'))).toBe(true)

      const result = fs.readFileSync(outputPath, 'utf-8')
      expect(result).toContain('[SPEAKER_00]')
      expect(result).toContain('Hello there.')
      expect(result).toContain('[SPEAKER_01]')
      expect(result).toContain('Hi, how are you?')
    } finally {
      spy.mockRestore()
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath)
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
    }
  })

  it('skips diarization when noDiarize is true', async () => {
    const mlxOutput = {
      text: 'Hello there.',
      segments: [
        { id: 0, start: 0.0, end: 2.0, text: ' Hello there.' },
      ],
    }

    const spy = spyOn(child_process, 'spawn').mockImplementation(((_cmd: string, args: string[]) => {
      const emitter = new EventEmitter() as any
      emitter.stdout = new EventEmitter()
      emitter.stderr = new EventEmitter()

      const outDirIdx = args.indexOf('--output-dir')
      if (outDirIdx !== -1) {
        const outDir = args[outDirIdx + 1]
        const audioArg = args.find((value) => value.endsWith('.mp3'))!
        const baseName = path.basename(audioArg, '.mp3')
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(path.join(outDir, `${baseName}.json`), JSON.stringify(mlxOutput))
      }
      setTimeout(() => emitter.emit('close', 0), 0)

      return emitter
    }) as any)

    const audioPath = path.join(os.tmpdir(), `plaud-test-${Date.now()}.mp3`)
    const outputPath = path.join(os.tmpdir(), `plaud-test-${Date.now()}.txt`)
    fs.writeFileSync(audioPath, Buffer.alloc(1024))

    try {
      const transcriber = new Transcriber()
      await transcriber.transcribe(audioPath, outputPath, undefined, false, true)

      expect(spy).toHaveBeenCalledTimes(1)

      const result = fs.readFileSync(outputPath, 'utf-8')
      expect(result).toContain('Hello there.')
      expect(result).not.toContain('[SPEAKER_')
    } finally {
      spy.mockRestore()
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath)
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
    }
  })

  it('throws when mlx_whisper fails', async () => {
    const emitter = new EventEmitter() as any
    emitter.stdout = new EventEmitter()
    emitter.stderr = new EventEmitter()
    const spy = spyOn(child_process, 'spawn').mockImplementation((() => {
      setTimeout(() => emitter.emit('close', 1), 0)
      return emitter
    }) as any)

    const audioPath = path.join(os.tmpdir(), `plaud-test-${Date.now()}.mp3`)
    fs.writeFileSync(audioPath, Buffer.alloc(1024))

    try {
      const transcriber = new Transcriber()
      await expect(
        transcriber.transcribe(audioPath, '/transcripts/test.txt'),
      ).rejects.toThrow('uvx --python exited with code 1')
    } finally {
      spy.mockRestore()
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath)
    }
  })

  it('throws a helpful error when mlx_whisper produces no json output', async () => {
    const emitter = new EventEmitter() as any
    emitter.stdout = new EventEmitter()
    emitter.stderr = new EventEmitter()
    const spy = spyOn(child_process, 'spawn').mockImplementation((() => {
      setTimeout(() => emitter.emit('close', 0), 0)
      return emitter
    }) as any)

    const audioPath = path.join(os.tmpdir(), `plaud-test-${Date.now()}.mp3`)
    const outputPath = path.join(os.tmpdir(), `plaud-test-${Date.now()}.txt`)
    fs.writeFileSync(audioPath, Buffer.alloc(1024))

    try {
      const transcriber = new Transcriber()
      await expect(
        transcriber.transcribe(audioPath, outputPath, undefined, false, true),
      ).rejects.toThrow('transcription finished without producing JSON output')
    } finally {
      spy.mockRestore()
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath)
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
    }
  })

  it('tolerates NaN values in whisper json output', async () => {
    const spy = spyOn(child_process, 'spawn').mockImplementation(((_cmd: string, args: string[]) => {
      const emitter = new EventEmitter() as any
      emitter.stdout = new EventEmitter()
      emitter.stderr = new EventEmitter()

      const outDirIdx = args.indexOf('--output-dir')
      if (outDirIdx !== -1) {
        const outDir = args[outDirIdx + 1]
        const audioArg = args.find((value) => value.endsWith('.mp3'))!
        const baseName = path.basename(audioArg, '.mp3')
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(
          path.join(outDir, `${baseName}.json`),
          JSON.stringify({
            text: 'Hello there.',
            segments: [
              { id: 0, start: 0, end: 2, text: ' Hello there.' },
            ],
          }).replace('"start":0', '"start":NaN'),
        )
      }
      setTimeout(() => emitter.emit('close', 0), 0)

      return emitter
    }) as any)

    const audioPath = path.join(os.tmpdir(), `plaud-test-${Date.now()}.mp3`)
    const outputPath = path.join(os.tmpdir(), `plaud-test-${Date.now()}.txt`)
    fs.writeFileSync(audioPath, Buffer.alloc(1024))

    try {
      const transcriber = new Transcriber()
      await transcriber.transcribe(audioPath, outputPath, undefined, false, true)

      const result = fs.readFileSync(outputPath, 'utf-8')
      expect(result).toBe('\n')
    } finally {
      spy.mockRestore()
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath)
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
    }
  })

  it('stops a running transcription when free memory drops too low', async () => {
    const audioPath = path.join(os.tmpdir(), `plaud-test-audio-${Date.now()}.mp3`)
    const outputPath = path.join(os.tmpdir(), `plaud-test-output-${Date.now()}.txt`)
    fs.writeFileSync(audioPath, Buffer.alloc(64 * 1024 * 1024))

    const freememSpy = spyOn(os, 'freemem')
    freememSpy.mockImplementation(() => 1 * 1024 ** 3)
    const totalmemSpy = spyOn(os, 'totalmem')
    totalmemSpy.mockImplementation(() => 32 * 1024 ** 3)

    const previousPoll = process.env.PLAUD_SYNC_MEMORY_POLL_MS
    const previousSnapshotMode = process.env.PLAUD_SYNC_MEMORY_SNAPSHOT_MODE
    process.env.PLAUD_SYNC_MEMORY_POLL_MS = '10'
    process.env.PLAUD_SYNC_MEMORY_SNAPSHOT_MODE = 'raw'

    let killCalled = false
    const spy = spyOn(child_process, 'spawn').mockImplementation(((_cmd: string, _args: string[]) => {
      const emitter = new EventEmitter() as any
      emitter.stdout = new EventEmitter()
      emitter.stderr = new EventEmitter()
      emitter.kill = () => {
        killCalled = true
        setTimeout(() => emitter.emit('close', 143), 0)
        return true
      }
      return emitter
    }) as any)

    try {
      const transcriber = new Transcriber()
      await expect(
        transcriber.transcribe(audioPath, outputPath, undefined, false, true),
      ).rejects.toThrow('stopped to protect system memory')
      expect(killCalled).toBe(true)
    } finally {
      spy.mockRestore()
      freememSpy.mockRestore()
      totalmemSpy.mockRestore()
      if (previousPoll == null) delete process.env.PLAUD_SYNC_MEMORY_POLL_MS
      else process.env.PLAUD_SYNC_MEMORY_POLL_MS = previousPoll
      if (previousSnapshotMode == null) delete process.env.PLAUD_SYNC_MEMORY_SNAPSHOT_MODE
      else process.env.PLAUD_SYNC_MEMORY_SNAPSHOT_MODE = previousSnapshotMode
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath)
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
    }
  })
})

describe('checkPrerequisites', () => {
  it('returns error when uv is not found', () => {
    const errors = checkPrerequisites()
    expect(Array.isArray(errors)).toBe(true)
  })
})

describe('assessTranscriptionSafety', () => {
  it('blocks diarized jobs when free memory is too low', () => {
    const issue = assessTranscriptionSafety(
      {
        audioBytes: 800 * 1024 * 1024,
        durationMs: 2 * 60 * 60 * 1000,
        diarizationEnabled: true,
      },
      {
        availableBytes: 3 * 1024 ** 3,
        totalBytes: 8 * 1024 ** 3,
        freeBytes: 3 * 1024 ** 3,
        reclaimableBytes: 0,
      },
    )

    expect(issue).not.toBeNull()
    expect(issue?.reason).toMatch(/only|expects at least/)
  })

  it('allows smaller non-diarized jobs with healthy headroom', () => {
    const issue = assessTranscriptionSafety(
      {
        audioBytes: 40 * 1024 * 1024,
        durationMs: 20 * 60 * 1000,
        diarizationEnabled: false,
      },
      {
        availableBytes: 20 * 1024 ** 3,
        totalBytes: 32 * 1024 ** 3,
        freeBytes: 20 * 1024 ** 3,
        reclaimableBytes: 0,
      },
    )

    expect(issue).toBeNull()
  })

  it('treats inactive and speculative pages as available on macOS', () => {
    const snapshot = parseMacOSVmStatSnapshot(
      `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               75961.
Pages active:                            412051.
Pages inactive:                          375613.
Pages speculative:                        36174.
Pages wired down:                        114187.
Pages purgeable:                          15633.
`,
      16 * 1024 ** 3,
    )

    expect(snapshot).not.toBeNull()
    expect(snapshot?.freeBytes).toBe(75961 * 16384)
    expect(snapshot?.reclaimableBytes).toBe((375613 + 36174 + 15633) * 16384)
    expect(snapshot?.availableBytes).toBe((75961 + 375613 + 36174 + 15633) * 16384)
  })
})
