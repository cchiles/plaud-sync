import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { syncRecordings, generateFilename } from '../src/sync.js'
import type { PlaudClient } from '../src/client.js'
import type { Transcriber } from '../src/transcriber.js'
import type { PlaudRecording } from '../src/types.js'

function makeRecording(overrides: Partial<PlaudRecording> = {}): PlaudRecording {
  return {
    id: 'rec-1',
    filename: 'Team Meeting',
    fullname: 'Team Meeting.opus',
    filesize: 1024,
    duration: 60000,
    start_time: new Date('2026-03-25T10:00:00Z').getTime(),
    end_time: new Date('2026-03-25T11:00:00Z').getTime(),
    is_trash: false,
    is_trans: false,
    is_summary: false,
    keywords: [],
    serial_number: 'SN001',
    ...overrides,
  }
}

function makeStreamingResponse(body: string | Uint8Array) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  const arrayBuffer = mock(() => Promise.reject(new Error('arrayBuffer should not be used')))
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })

  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: stream,
    arrayBuffer,
  } as unknown as Response
}

describe('generateFilename', () => {
  it('formats as YYYY-MM-DD_slug', () => {
    const rec = makeRecording({ filename: 'Team Meeting', start_time: new Date('2026-03-25T10:00:00Z').getTime() })
    expect(generateFilename(rec)).toBe('2026-03-25_Team_Meeting')
  })

  it('strips non-alphanumeric characters', () => {
    const rec = makeRecording({ filename: 'Meeting #3 (important!)' })
    expect(generateFilename(rec)).toBe('2026-03-25_Meeting_3_important_')
  })

  it('truncates slug to 50 characters', () => {
    const rec = makeRecording({ filename: 'A'.repeat(100) })
    const name = generateFilename(rec)
    const slug = name.split('_').slice(1).join('_')
    expect(slug.length).toBeLessThanOrEqual(50)
  })
})

describe('syncRecordings', () => {
  let tmpDir: string
  let originalBypassValue: string | undefined
  let originalSnapshotMode: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-sync-test-'))
    originalBypassValue = process.env.PLAUD_SYNC_BYPASS_MEMORY_CHECK
    originalSnapshotMode = process.env.PLAUD_SYNC_MEMORY_SNAPSHOT_MODE
    process.env.PLAUD_SYNC_BYPASS_MEMORY_CHECK = '1'
    process.env.PLAUD_SYNC_MEMORY_SNAPSHOT_MODE = 'raw'
  })

  afterEach(() => {
    mock.restore()
    if (originalBypassValue == null) delete process.env.PLAUD_SYNC_BYPASS_MEMORY_CHECK
    else process.env.PLAUD_SYNC_BYPASS_MEMORY_CHECK = originalBypassValue
    if (originalSnapshotMode == null) delete process.env.PLAUD_SYNC_MEMORY_SNAPSHOT_MODE
    else process.env.PLAUD_SYNC_MEMORY_SNAPSHOT_MODE = originalSnapshotMode
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('downloads and transcribes new recordings', async () => {
    const recordings = [makeRecording()]

    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock(() => Promise.resolve('https://cdn.example.com/file.mp3')),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: mock(() => Promise.resolve(undefined)),
    } as unknown as Transcriber

    // Mock fetch for MP3 download
    const response = makeStreamingResponse('audio-data')
    spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(response)) as unknown as typeof fetch)

    const summary = await syncRecordings(client, transcriber, tmpDir)

    const audioDir = path.join(tmpDir, 'audio')
    const transcriptDir = path.join(tmpDir, 'transcripts')
    expect(fs.existsSync(audioDir)).toBe(true)
    expect(fs.existsSync(transcriptDir)).toBe(true)
    expect(client.getMp3Url).toHaveBeenCalledWith('rec-1')
    expect(transcriber.transcribe).toHaveBeenCalled()
    expect((response as any).arrayBuffer).not.toHaveBeenCalled()
    expect(fs.readdirSync(audioDir)).toEqual([])
    expect(summary.downloaded).toBe(1)
    expect(summary.transcribed).toBe(1)
  })

  it('skips recordings that already have audio files', async () => {
    const recordings = [makeRecording()]

    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock(() => undefined),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: mock(() => undefined),
    } as unknown as Transcriber

    // Pre-create the audio file
    const audioDir = path.join(tmpDir, 'audio')
    fs.mkdirSync(audioDir, { recursive: true })
    fs.writeFileSync(path.join(audioDir, '2026-03-25_Team_Meeting.mp3'), 'existing')

    // Pre-create the transcript file
    const transcriptDir = path.join(tmpDir, 'transcripts')
    fs.mkdirSync(transcriptDir, { recursive: true })
    fs.writeFileSync(path.join(transcriptDir, '2026-03-25_Team_Meeting.txt'), 'existing')

    await syncRecordings(client, transcriber, tmpDir)

    expect(client.getMp3Url).not.toHaveBeenCalled()
    expect(transcriber.transcribe).not.toHaveBeenCalled()
  })

  it('transcribes when audio exists but transcript does not', async () => {
    const recordings = [makeRecording()]

    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock(() => undefined),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: mock(() => Promise.resolve(undefined)),
    } as unknown as Transcriber

    // Pre-create only the audio file
    const audioDir = path.join(tmpDir, 'audio')
    fs.mkdirSync(audioDir, { recursive: true })
    fs.writeFileSync(path.join(audioDir, '2026-03-25_Team_Meeting.mp3'), 'audio-data')

    await syncRecordings(client, transcriber, tmpDir)

    expect(client.getMp3Url).not.toHaveBeenCalled()
    expect(transcriber.transcribe).toHaveBeenCalled()
  })

  it('falls back to opus download when MP3 URL is null', async () => {
    const recordings = [makeRecording()]

    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock(() => Promise.resolve(null)),
      downloadAudio: mock(() => Promise.resolve(makeStreamingResponse('opus-data'))),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: mock(() => Promise.resolve(undefined)),
    } as unknown as Transcriber

    await syncRecordings(client, transcriber, tmpDir)

    expect(client.downloadAudio).toHaveBeenCalledWith('rec-1')
    const audioDir = path.join(tmpDir, 'audio')
    expect(fs.readdirSync(audioDir)).toEqual([])
  })

  it('keeps audio after successful transcription when requested', async () => {
    const recordings = [makeRecording()]

    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock(() => Promise.resolve('https://cdn.example.com/file.mp3')),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: mock(() => Promise.resolve(undefined)),
    } as unknown as Transcriber

    spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(
      makeStreamingResponse('audio-data'),
    )) as unknown as typeof fetch)

    await syncRecordings(client, transcriber, tmpDir, { deleteAudioAfterTranscribe: false })

    const audioDir = path.join(tmpDir, 'audio')
    const files = fs.readdirSync(audioDir)
    expect(files.some((f) => f.endsWith('.mp3'))).toBe(true)
  })

  it('continues to next recording when one fails', async () => {
    const recordings = [
      makeRecording({ id: 'rec-1', filename: 'First' }),
      makeRecording({ id: 'rec-2', filename: 'Second', start_time: new Date('2026-03-26T10:00:00Z').getTime() }),
    ]

    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock()
        .mockImplementationOnce(() => Promise.reject(new Error('Network error')))
        .mockImplementationOnce(() => Promise.resolve('https://cdn.example.com/second.mp3')),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: mock(() => Promise.resolve(undefined)),
    } as unknown as Transcriber

    spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(
      makeStreamingResponse('audio-data'),
    )) as unknown as typeof fetch)

    await syncRecordings(client, transcriber, tmpDir)

    // Second recording should still be processed
    expect(transcriber.transcribe).toHaveBeenCalledTimes(1)
  })

  it('sorts recordings by start_time descending (newest first)', async () => {
    const recordings = [
      makeRecording({ id: 'rec-1', filename: 'Earlier', start_time: 1000 }),
      makeRecording({ id: 'rec-2', filename: 'Later', start_time: 2000 }),
    ]

    const processOrder: string[] = []

    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock((id: string) => {
        processOrder.push(id)
        return Promise.resolve('https://cdn.example.com/file.mp3')
      }),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: mock(() => Promise.resolve(undefined)),
    } as unknown as Transcriber

    spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(
      makeStreamingResponse('audio-data'),
    )) as unknown as typeof fetch)

    await syncRecordings(client, transcriber, tmpDir)

    expect(processOrder).toEqual(['rec-2', 'rec-1'])
  })

  it('downloads and transcribes each recording before moving to the next', async () => {
    const recordings = [
      makeRecording({ id: 'rec-1', filename: 'First', start_time: 1000 }),
      makeRecording({ id: 'rec-2', filename: 'Second', start_time: 2000 }),
    ]

    const steps: string[] = []

    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock((id: string) => {
        steps.push(`download:${id}`)
        return Promise.resolve(`https://cdn.example.com/${id}.mp3`)
      }),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: mock((audioPath: string) => {
        steps.push(`transcribe:${path.basename(audioPath, path.extname(audioPath))}`)
        return Promise.resolve(undefined)
      }),
    } as unknown as Transcriber

    spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(
      makeStreamingResponse('audio-data'),
    )) as unknown as typeof fetch)

    await syncRecordings(client, transcriber, tmpDir)

    expect(steps).toEqual([
      'download:rec-2',
      'transcribe:1970-01-01_Second',
      'download:rec-1',
      'transcribe:1970-01-01_First',
    ])
  })

  it('shows actionable counts without batch throughput output', async () => {
    const recordings = [
      makeRecording({ id: 'rec-1', filename: 'First', start_time: 1000 }),
      makeRecording({ id: 'rec-2', filename: 'Second', start_time: 2000 }),
    ]

    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock((id: string) => Promise.resolve(`https://cdn.example.com/${id}.mp3`)),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: mock(() => Promise.resolve(undefined)),
    } as unknown as Transcriber

    spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(
      makeStreamingResponse('audio-data'),
    )) as unknown as typeof fetch)

    const transcriptDir = path.join(tmpDir, 'transcripts')
    fs.mkdirSync(transcriptDir, { recursive: true })
    fs.writeFileSync(path.join(transcriptDir, '1970-01-01_First.txt'), 'existing')

    const writes: string[] = []
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    }) as typeof process.stdout.write)

    await syncRecordings(client, transcriber, tmpDir, { interactive: false })

    stdoutSpy.mockRestore()
    const output = writes.join('')
    expect(output).toContain('Selected: 1 recording(s)')
    expect(output).not.toContain('skipped=')
    expect(output).not.toContain('it/s]')
  })

  it('keeps the interactive footer on one line for long recording names', async () => {
    const recordings = [
      makeRecording({
        id: 'rec-1',
        filename: '04-01 Project Kickoff Meeting: Voicebox Vision, MVP Scope, Compliance, and Pilot Strategy',
        start_time: 2000,
      }),
    ]

    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock((id: string) => Promise.resolve(`https://cdn.example.com/${id}.mp3`)),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: mock(async (_audioPath, _outputPath, _hfToken, _verbose, _noDiarize, hooks) => {
        hooks?.onPhaseChange?.('transcribing')
        await new Promise((resolve) => setTimeout(resolve, 1100))
      }),
    } as unknown as Transcriber

    spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(
      makeStreamingResponse('audio-data'),
    )) as unknown as typeof fetch)

    const writes: string[] = []
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    }) as typeof process.stdout.write)
    const columnsSpy = spyOn(process.stdout, 'columns', 'get').mockReturnValue(80)

    await syncRecordings(client, transcriber, tmpDir, { interactive: true })

    columnsSpy.mockRestore()
    stdoutSpy.mockRestore()

    const footerWrites = writes.filter((chunk) => chunk.includes('\r\x1b[2K'))
    expect(footerWrites.length).toBeGreaterThan(0)
    for (const footer of footerWrites) {
      const cleaned = footer.replace(/\r\x1b\[2K/g, '')
      const visibleLine = cleaned.split('\n')[0] ?? ''
      expect(visibleLine.length).toBeLessThanOrEqual(80)
    }
  })

  it('filters recordings by since date and limit', async () => {
    const recordings = [
      makeRecording({ id: 'rec-1', filename: 'Older', start_time: Date.parse('2026-03-01T10:00:00Z') }),
      makeRecording({ id: 'rec-2', filename: 'Mid', start_time: Date.parse('2026-04-02T10:00:00Z') }),
      makeRecording({ id: 'rec-3', filename: 'Newest', start_time: Date.parse('2026-04-03T10:00:00Z') }),
    ]

    const processOrder: string[] = []
    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock((id: string) => {
        processOrder.push(id)
        return Promise.resolve('https://cdn.example.com/file.mp3')
      }),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient
    const transcriber: Transcriber = {
      transcribe: mock(() => Promise.resolve(undefined)),
    } as unknown as Transcriber

    spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(
      makeStreamingResponse('audio-data'),
    )) as unknown as typeof fetch)

    const summary = await syncRecordings(client, transcriber, tmpDir, {
      since: Date.parse('2026-04-01T00:00:00Z'),
      limit: 1,
    })

    expect(processOrder).toEqual(['rec-3'])
    expect(summary.scanned).toBe(3)
    expect(summary.selected).toBe(1)
  })

  it('supports dry-run without downloading or transcribing', async () => {
    const recordings = [makeRecording()]
    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock(() => Promise.resolve('https://cdn.example.com/file.mp3')),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient
    const transcriber: Transcriber = {
      transcribe: mock(() => Promise.resolve(undefined)),
    } as unknown as Transcriber

    const summary = await syncRecordings(client, transcriber, tmpDir, { dryRun: true })

    expect(client.getMp3Url).not.toHaveBeenCalled()
    expect(transcriber.transcribe).not.toHaveBeenCalled()
    expect(summary.selected).toBe(1)
  })

  it('blocks risky transcriptions before starting the model', async () => {
    delete process.env.PLAUD_SYNC_BYPASS_MEMORY_CHECK
    const recordings = [
      makeRecording({
        filesize: 900 * 1024 * 1024,
        duration: 2 * 60 * 60 * 1000,
      }),
    ]
    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock(() => Promise.resolve('https://cdn.example.com/file.mp3')),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient
    const transcriber: Transcriber = {
      transcribe: mock(() => Promise.resolve(undefined)),
    } as unknown as Transcriber

    const response = makeStreamingResponse(new Uint8Array(32))
    spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(response)) as unknown as typeof fetch)
    const freeMemSpy = spyOn(os, 'freemem').mockImplementation(() => 1 * 1024 ** 3)
    const totalMemSpy = spyOn(os, 'totalmem').mockImplementation(() => 8 * 1024 ** 3)

    try {
      const summary = await syncRecordings(client, transcriber, tmpDir, { hfToken: 'hf-token' })

      expect(transcriber.transcribe).not.toHaveBeenCalled()
      expect(summary.failed).toBe(1)
      expect(summary.transcribed).toBe(0)
      expect(summary.stoppedEarly).toBe(true)
    } finally {
      freeMemSpy.mockRestore()
      totalMemSpy.mockRestore()
    }
  })

  it('falls back to transcription-only when diarization is unsafe but plain transcription fits', async () => {
    delete process.env.PLAUD_SYNC_BYPASS_MEMORY_CHECK
    const recordings = [
      makeRecording({
        filesize: 200 * 1024 * 1024,
        duration: 60 * 60 * 1000,
      }),
    ]
    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock(() => Promise.resolve('https://cdn.example.com/file.mp3')),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient
    const transcriber: Transcriber = {
      transcribe: mock(() => Promise.resolve(undefined)),
    } as unknown as Transcriber

    const response = makeStreamingResponse(new Uint8Array(32))
    spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(response)) as unknown as typeof fetch)
    const freeMemSpy = spyOn(os, 'freemem').mockImplementation(() => 3.1 * 1024 ** 3)
    const totalMemSpy = spyOn(os, 'totalmem').mockImplementation(() => 16 * 1024 ** 3)

    try {
      const summary = await syncRecordings(client, transcriber, tmpDir, { hfToken: 'hf-token' })

      expect(summary.failed).toBe(0)
      expect(summary.transcribed).toBe(1)
      expect(summary.stoppedEarly).toBe(false)
      expect(transcriber.transcribe).toHaveBeenCalledTimes(1)
      expect(transcriber.transcribe).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'hf-token',
        false,
        true,
        expect.any(Object),
      )
    } finally {
      freeMemSpy.mockRestore()
      totalMemSpy.mockRestore()
    }
  })

  it('stops the run after the first preflight memory block', async () => {
    delete process.env.PLAUD_SYNC_BYPASS_MEMORY_CHECK
    const recordings = [
      makeRecording({ id: 'rec-1', filename: 'First', filesize: 900 * 1024 * 1024, duration: 2 * 60 * 60 * 1000 }),
      makeRecording({ id: 'rec-2', filename: 'Second', filesize: 900 * 1024 * 1024, duration: 2 * 60 * 60 * 1000 }),
    ]
    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock((id: string) => Promise.resolve(`https://cdn.example.com/${id}.mp3`)),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient
    const transcriber: Transcriber = {
      transcribe: mock(() => Promise.resolve(undefined)),
    } as unknown as Transcriber

    spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(makeStreamingResponse('audio-data'))) as unknown as typeof fetch)
    const freeMemSpy = spyOn(os, 'freemem').mockImplementation(() => 1 * 1024 ** 3)
    const totalMemSpy = spyOn(os, 'totalmem').mockImplementation(() => 8 * 1024 ** 3)

    try {
      const summary = await syncRecordings(client, transcriber, tmpDir, { hfToken: 'hf-token' })

      expect(summary.failed).toBe(1)
      expect(summary.stoppedEarly).toBe(true)
      expect(client.getMp3Url).toHaveBeenCalledTimes(1)
      expect(transcriber.transcribe).not.toHaveBeenCalled()
    } finally {
      freeMemSpy.mockRestore()
      totalMemSpy.mockRestore()
    }
  })

  it('stops the run after a runtime memory watchdog failure', async () => {
    const recordings = [
      makeRecording({ id: 'rec-1', filename: 'First' }),
      makeRecording({ id: 'rec-2', filename: 'Second', start_time: new Date('2026-03-26T10:00:00Z').getTime() }),
    ]
    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock((id: string) => Promise.resolve(`https://cdn.example.com/${id}.mp3`)),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient
    const transcriber: Transcriber = {
      transcribe: mock()
        .mockImplementationOnce(() => Promise.reject(new Error('transcription stopped to protect system memory: free memory fell to 0.6 GiB')))
        .mockImplementationOnce(() => Promise.resolve(undefined)),
    } as unknown as Transcriber

    spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(makeStreamingResponse('audio-data'))) as unknown as typeof fetch)

    const summary = await syncRecordings(client, transcriber, tmpDir)

    expect(summary.failed).toBe(1)
    expect(summary.transcribed).toBe(0)
    expect(summary.stoppedEarly).toBe(true)
    expect(transcriber.transcribe).toHaveBeenCalledTimes(1)
  })

  it('retries without diarization when diarization hits the memory watchdog', async () => {
    const recordings = [makeRecording()]
    const client: PlaudClient = {
      listRecordings: mock(() => Promise.resolve(recordings)),
      getMp3Url: mock(() => Promise.resolve('https://cdn.example.com/file.mp3')),
      downloadAudio: mock(() => undefined),
    } as unknown as PlaudClient
    const transcriber: Transcriber = {
      transcribe: mock()
        .mockImplementationOnce(() => Promise.reject(new Error('diarization stopped to protect system memory: available memory fell to 1.1 GiB')))
        .mockImplementationOnce(() => Promise.resolve(undefined)),
    } as unknown as Transcriber

    spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve(makeStreamingResponse('audio-data'))) as unknown as typeof fetch)

    const summary = await syncRecordings(client, transcriber, tmpDir, { hfToken: 'hf-token' })

    expect(summary.failed).toBe(0)
    expect(summary.transcribed).toBe(1)
    expect(summary.stoppedEarly).toBe(false)
    expect(transcriber.transcribe).toHaveBeenCalledTimes(2)
    expect((transcriber.transcribe as any).mock.calls[0][4]).toBe(false)
    expect((transcriber.transcribe as any).mock.calls[1][4]).toBe(true)
  })
})
