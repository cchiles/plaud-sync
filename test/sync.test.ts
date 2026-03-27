import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-sync-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('downloads and transcribes new recordings', async () => {
    const recordings = [makeRecording()]

    const client: PlaudClient = {
      listRecordings: vi.fn().mockResolvedValue(recordings),
      getMp3Url: vi.fn().mockResolvedValue('https://cdn.example.com/file.mp3'),
      downloadAudio: vi.fn(),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: vi.fn().mockResolvedValue(undefined),
    } as unknown as Transcriber

    // Mock fetch for MP3 download
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new ArrayBuffer(16), { status: 200 }),
    )

    await syncRecordings(client, transcriber, tmpDir)

    const audioDir = path.join(tmpDir, 'audio')
    const transcriptDir = path.join(tmpDir, 'transcripts')
    expect(fs.existsSync(audioDir)).toBe(true)
    expect(fs.existsSync(transcriptDir)).toBe(true)
    expect(client.getMp3Url).toHaveBeenCalledWith('rec-1')
    expect(transcriber.transcribe).toHaveBeenCalled()
  })

  it('skips recordings that already have audio files', async () => {
    const recordings = [makeRecording()]

    const client: PlaudClient = {
      listRecordings: vi.fn().mockResolvedValue(recordings),
      getMp3Url: vi.fn(),
      downloadAudio: vi.fn(),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: vi.fn(),
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
      listRecordings: vi.fn().mockResolvedValue(recordings),
      getMp3Url: vi.fn(),
      downloadAudio: vi.fn(),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: vi.fn().mockResolvedValue(undefined),
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
      listRecordings: vi.fn().mockResolvedValue(recordings),
      getMp3Url: vi.fn().mockResolvedValue(null),
      downloadAudio: vi.fn().mockResolvedValue(new ArrayBuffer(16)),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: vi.fn().mockResolvedValue(undefined),
    } as unknown as Transcriber

    await syncRecordings(client, transcriber, tmpDir)

    expect(client.downloadAudio).toHaveBeenCalledWith('rec-1')
    const audioDir = path.join(tmpDir, 'audio')
    const files = fs.readdirSync(audioDir)
    expect(files.some((f) => f.endsWith('.opus'))).toBe(true)
  })

  it('continues to next recording when one fails', async () => {
    const recordings = [
      makeRecording({ id: 'rec-1', filename: 'First' }),
      makeRecording({ id: 'rec-2', filename: 'Second', start_time: new Date('2026-03-26T10:00:00Z').getTime() }),
    ]

    const client: PlaudClient = {
      listRecordings: vi.fn().mockResolvedValue(recordings),
      getMp3Url: vi.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce('https://cdn.example.com/second.mp3'),
      downloadAudio: vi.fn(),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: vi.fn().mockResolvedValue(undefined),
    } as unknown as Transcriber

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new ArrayBuffer(16), { status: 200 }),
    )

    await syncRecordings(client, transcriber, tmpDir)

    // Second recording should still be processed
    expect(transcriber.transcribe).toHaveBeenCalledTimes(1)
  })

  it('sorts recordings by start_time ascending', async () => {
    const recordings = [
      makeRecording({ id: 'rec-2', filename: 'Later', start_time: 2000 }),
      makeRecording({ id: 'rec-1', filename: 'Earlier', start_time: 1000 }),
    ]

    const processOrder: string[] = []

    const client: PlaudClient = {
      listRecordings: vi.fn().mockResolvedValue(recordings),
      getMp3Url: vi.fn().mockImplementation((id: string) => {
        processOrder.push(id)
        return Promise.resolve('https://cdn.example.com/file.mp3')
      }),
      downloadAudio: vi.fn(),
    } as unknown as PlaudClient

    const transcriber: Transcriber = {
      transcribe: vi.fn().mockResolvedValue(undefined),
    } as unknown as Transcriber

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new ArrayBuffer(16), { status: 200 }),
    )

    await syncRecordings(client, transcriber, tmpDir)

    expect(processOrder).toEqual(['rec-1', 'rec-2'])
  })
})
