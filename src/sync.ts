import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { PlaudClient } from './client.js'
import { assessTranscriptionSafety } from './transcriber.js'
import type { Transcriber } from './transcriber.js'
import type { PlaudRecording } from './types.js'
import { SyncDb } from './db.js'

export type RecordingOrder = 'newest' | 'oldest'

export interface SyncOptions {
  hfToken?: string
  audioOnly?: boolean
  transcribeOnly?: boolean
  verbose?: boolean
  noDiarize?: boolean
  retranscribe?: boolean
  deleteAudioAfterTranscribe?: boolean
  limit?: number
  since?: number
  maxRuntimeMinutes?: number
  recordingOrder?: RecordingOrder
  dryRun?: boolean
  interactive?: boolean
  heartbeatMs?: number
}

export interface SyncRunSummary {
  scanned: number
  selected: number
  downloaded: number
  transcribed: number
  skipped: number
  failed: number
  wallTimeMs: number
  stoppedEarly: boolean
}

type SyncPhase =
  | 'queued'
  | 'downloading'
  | 'downloaded'
  | 'transcribing'
  | 'diarizing'
  | 'writing transcript'
  | 'done'
  | 'failed'
  | 'skipped'

export function generateFilename(rec: PlaudRecording): string {
  const date = new Date(rec.start_time).toISOString().slice(0, 10)
  const slug = rec.filename.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 50)
  return `${date}_${slug}`
}

function findExistingAudio(audioDir: string, baseName: string): string | null {
  for (const ext of ['mp3', 'opus']) {
    const filePath = path.join(audioDir, `${baseName}.${ext}`)
    if (fs.existsSync(filePath)) return filePath
  }
  return null
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function formatDateOnly(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function renderProgressBar(completed: number, total: number, width = 40): string {
  const safeTotal = Math.max(total, 1)
  const ratio = Math.max(0, Math.min(1, completed / safeTotal))
  const filled = Math.round(ratio * width)
  return `${'█'.repeat(filled)}${' '.repeat(width - filled)}`
}

function truncateMiddle(value: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  if (value.length <= maxLength) return value
  if (maxLength <= 3) return '.'.repeat(maxLength)

  const remaining = maxLength - 3
  const left = Math.ceil(remaining / 2)
  const right = Math.floor(remaining / 2)
  return `${value.slice(0, left)}...${value.slice(value.length - right)}`
}

function formatFooterLine(args: {
  columns?: number
  completed: number
  failed: number
  phase: SyncPhase
  index: number
  total: number
  name: string
  elapsed: string
}): string {
  const phaseProgress = getPhaseProgress(args.phase)
  const percent = Math.round((phaseProgress.completed / Math.max(phaseProgress.total, 1)) * 100)
  const bar = `${String(percent).padStart(3, ' ')}%|${renderProgressBar(phaseProgress.completed, phaseProgress.total)}|`
  const statusSuffix = ` [${args.phase}] elapsed=${args.elapsed} completed=${args.completed} failed=${args.failed}`
  const columns = args.columns && args.columns > 0 ? args.columns : undefined

  if (!columns) {
    return `${bar} [${args.index}/${args.total}] ${args.name}${statusSuffix}`
  }

  const prefix = `${bar} `
  const itemPrefix = `[${args.index}/${args.total}] `
  const availableNameLength = Math.max(8, columns - prefix.length - itemPrefix.length - statusSuffix.length)
  const safeName = truncateMiddle(args.name, availableNameLength)
  const line = `${prefix}${itemPrefix}${safeName}${statusSuffix}`
  return line.length <= columns ? line : line.slice(0, columns)
}

function getPhaseProgress(phase: SyncPhase): { completed: number; total: number } {
  switch (phase) {
    case 'queued':
      return { completed: 0, total: 4 }
    case 'downloading':
      return { completed: 1, total: 4 }
    case 'downloaded':
      return { completed: 2, total: 4 }
    case 'transcribing':
      return { completed: 2, total: 4 }
    case 'diarizing':
      return { completed: 3, total: 4 }
    case 'writing transcript':
      return { completed: 3, total: 4 }
    case 'done':
    case 'failed':
    case 'skipped':
      return { completed: 4, total: 4 }
  }
}

function parseResultLabel(args: {
  downloaded: boolean
  transcribed: boolean
  hadExistingAudio: boolean
  fellBackToNoDiarize?: boolean
}): string {
  const suffix = args.fellBackToNoDiarize ? ' without diarization' : ''
  if (args.downloaded && args.transcribed) return `downloaded + transcribed${suffix}`
  if (args.transcribed && args.hadExistingAudio) return `transcribed from existing audio${suffix}`
  if (args.downloaded) return `downloaded${suffix}`
  return `done${suffix}`
}

function isMemorySafetyMessage(message: string): boolean {
  return message.includes('memory safety check') || message.includes('stopped to protect system memory')
}

function isDiarizationMemorySafetyMessage(message: string): boolean {
  return message.includes('diarization stopped to protect system memory')
}

class ProgressReporter {
  private readonly interactive: boolean
  private readonly verbose: boolean
  private readonly heartbeatMs: number
  private readonly runStartedAt = Date.now()
  private footerTimer?: ReturnType<typeof setInterval>
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private current:
    | {
        index: number
        total: number
        name: string
        phase: SyncPhase
        startedAt: number
      }
    | undefined

  private completed = 0
  private skipped = 0
  private failed = 0

  constructor(options: { interactive: boolean; verbose: boolean; heartbeatMs: number }) {
    this.interactive = options.interactive
    this.verbose = options.verbose
    this.heartbeatMs = options.heartbeatMs
  }

  startHeader(meta: {
    outputFolder: string
    totalFetched: number
    selected: number
    limit?: number
    since?: number
    diarizationEnabled: boolean
    keepAudio: boolean
    maxRuntimeMinutes?: number
    recordingOrder: RecordingOrder
    dryRun: boolean
  }): void {
    this.line('Starting sync')
    this.line(`  Output: ${meta.outputFolder}`)
    this.line(`  Fetched: ${meta.totalFetched} recording(s)`)
    this.line(`  Selected: ${meta.selected} recording(s)`)
    this.line(
      `  Filters: order=${meta.recordingOrder}, since=${meta.since ? formatDateOnly(meta.since) : 'none'}, limit=${meta.limit ?? 'none'}`,
    )
    this.line(
      `  Options: diarization=${meta.diarizationEnabled ? 'on' : 'off'}, keep-audio=${meta.keepAudio ? 'on' : 'off'}, dry-run=${meta.dryRun ? 'on' : 'off'}, runtime-cap=${meta.maxRuntimeMinutes ? `${meta.maxRuntimeMinutes}m` : 'none'}`,
    )

    this.startLiveUpdates()
  }

  queue(index: number, total: number, name: string): void {
    this.current = {
      index,
      total,
      name,
      phase: 'queued',
      startedAt: Date.now(),
    }
    if (this.verbose) this.line(`[${index}/${total}] ${name} queued`)
  }

  phase(phase: SyncPhase): void {
    if (!this.current) return
    this.current.phase = phase
    if (this.verbose) {
      this.line(`[${this.current.index}/${this.current.total}] ${this.current.name} ${phase}`)
    }
  }

  result(result: {
    label: string
    durationMs: number
    skipped?: boolean
    failed?: boolean
    timings?: { transcriptionMs: number; diarizationMs: number; writeMs: number }
    countedTranscription?: boolean
  }): void {
    if (!this.current) return

    if (result.failed) this.failed += 1
    else if (result.skipped) this.skipped += 1
    else this.completed += 1

    const detailParts = [`elapsed=${formatDuration(result.durationMs)}`]
    if (this.verbose && result.timings) {
      detailParts.push(`transcribe=${formatDuration(result.timings.transcriptionMs)}`)
      if (result.timings.diarizationMs > 0) {
        detailParts.push(`diarize=${formatDuration(result.timings.diarizationMs)}`)
      }
      detailParts.push(`write=${formatDuration(result.timings.writeMs)}`)
    }

    this.line(
      `[${this.current.index}/${this.current.total}] ${this.current.name} ${result.label} (${detailParts.join(', ')})`,
    )
    this.current = undefined
  }

  heartbeat(): void {
    if (!this.current) return
    const remaining = Math.max(0, this.current.total - (this.completed + this.failed))
    this.line(
      `Heartbeat: completed=${this.completed}, failed=${this.failed}, remaining=${remaining}, current="${this.current.name}" (${this.current.phase}), elapsed=${formatDuration(Date.now() - this.runStartedAt)}`,
    )
  }

  noteStoppedEarly(reason: string): void {
    this.line(reason)
  }

  finish(summary: SyncRunSummary): void {
    this.stopLiveUpdates()
    this.line(
      `Done: scanned=${summary.scanned}, selected=${summary.selected}, downloaded=${summary.downloaded}, transcribed=${summary.transcribed}, failed=${summary.failed}, wall=${formatDuration(summary.wallTimeMs)}${summary.stoppedEarly ? ', stopped-early=yes' : ''}`,
    )
  }

  private startLiveUpdates(): void {
    if (!this.interactive || this.verbose) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs)
      return
    }

    this.footerTimer = setInterval(() => this.renderFooter(), 1000)
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs)
  }

  private stopLiveUpdates(): void {
    if (this.footerTimer) clearInterval(this.footerTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.interactive && !this.verbose) {
      process.stdout.write('\r\x1b[2K')
    }
  }

  private renderFooter(): void {
    if (!this.interactive || this.verbose || !this.current) return
    const elapsed = formatDuration(Date.now() - this.current.startedAt)
    const footer = formatFooterLine({
      columns: process.stdout.columns,
      completed: this.completed,
      failed: this.failed,
      phase: this.current.phase,
      index: this.current.index,
      total: this.current.total,
      name: this.current.name,
      elapsed,
    })
    process.stdout.write(`\r\x1b[2K${footer}`)
  }

  private line(message: string): void {
    if (this.interactive && !this.verbose) {
      process.stdout.write('\r\x1b[2K')
    }
    process.stdout.write(`${message}\n`)
    if (this.interactive && !this.verbose && this.current) {
      this.renderFooter()
    }
  }
}

function selectRecordings(
  recordings: PlaudRecording[],
  options: Pick<SyncOptions, 'recordingOrder' | 'since' | 'limit'>,
): PlaudRecording[] {
  const order = options.recordingOrder ?? 'newest'
  const since = options.since
  let selected = [...recordings]

  if (since) {
    selected = selected.filter((recording) => recording.start_time >= since)
  }

  selected.sort((a, b) => {
    const direction = order === 'oldest' ? 1 : -1
    return direction * (a.start_time - b.start_time)
  })

  if (options.limit) {
    selected = selected.slice(0, options.limit)
  }

  return selected
}

function shouldSkipRecording(
  rec: PlaudRecording,
  outputFolder: string,
  options: Pick<SyncOptions, 'audioOnly' | 'transcribeOnly' | 'retranscribe' | 'dryRun'>,
  db: SyncDb,
): boolean {
  const audioDir = path.join(outputFolder, 'audio')
  const transcriptDir = path.join(outputFolder, 'transcripts')
  const defaultBaseName = generateFilename(rec)
  const dbEntry = db.findByRecordingId(rec.id)
  const baseName = dbEntry?.baseName ?? defaultBaseName
  const transcriptPath = path.join(transcriptDir, `${baseName}.txt`)

  let audioPath = findExistingAudio(audioDir, baseName)
  if (!audioPath && dbEntry && dbEntry.baseName !== baseName) {
    audioPath = findExistingAudio(audioDir, dbEntry.baseName)
  }

  const hasTranscript = fs.existsSync(transcriptPath)
  const isMarkedTranscribed = db.isTranscribed(rec.id)

  if (options.audioOnly) return Boolean(audioPath)
  if (options.transcribeOnly && !audioPath) return true
  if (!options.retranscribe && hasTranscript) return true
  if (!options.retranscribe && isMarkedTranscribed && !audioPath) return true

  return false
}

export async function syncRecordings(
  client: PlaudClient,
  transcriber: Transcriber,
  outputFolder: string,
  options: SyncOptions = {},
): Promise<SyncRunSummary> {
  const {
    hfToken,
    audioOnly = false,
    transcribeOnly = false,
    verbose = false,
    noDiarize = false,
    retranscribe = false,
    deleteAudioAfterTranscribe = true,
    limit,
    since,
    maxRuntimeMinutes,
    recordingOrder = 'newest',
    dryRun = false,
    interactive = Boolean(process.stdout.isTTY),
    heartbeatMs = 60_000,
  } = options
  const audioDir = path.join(outputFolder, 'audio')
  const transcriptDir = path.join(outputFolder, 'transcripts')
  fs.mkdirSync(audioDir, { recursive: true })
  fs.mkdirSync(transcriptDir, { recursive: true })

  const db = new SyncDb(outputFolder)
  const reporter = new ProgressReporter({ interactive, verbose, heartbeatMs })
  const runStartedAt = Date.now()
  const deadline = maxRuntimeMinutes ? runStartedAt + maxRuntimeMinutes * 60_000 : null
  const diarizationEnabled = !noDiarize && Boolean(hfToken)

  let downloaded = 0
  let transcribed = 0
  let skipped = 0
  let failed = 0
  let stoppedEarly = false

  try {
    const recordings = await client.listRecordings()
    const selected = selectRecordings(recordings, { recordingOrder, since, limit })
    const actionable = selected.filter((rec) => !shouldSkipRecording(rec, outputFolder, {
      audioOnly,
      transcribeOnly,
      retranscribe,
      dryRun,
    }, db))
    skipped = selected.length - actionable.length

    reporter.startHeader({
      outputFolder,
      totalFetched: recordings.length,
      selected: actionable.length,
      limit,
      since,
      diarizationEnabled,
      keepAudio: !deleteAudioAfterTranscribe,
      maxRuntimeMinutes,
      recordingOrder,
      dryRun,
    })

    for (let i = 0; i < actionable.length; i++) {
      if (deadline && Date.now() >= deadline) {
        stoppedEarly = true
        reporter.noteStoppedEarly(`Runtime cap reached after ${maxRuntimeMinutes} minute(s). Stopping cleanly.`)
        break
      }

      const rec = actionable[i]
      reporter.queue(i + 1, actionable.length, rec.filename)

      const itemStartedAt = Date.now()
      const defaultBaseName = generateFilename(rec)
      const dbEntry = db.findByRecordingId(rec.id)
      const baseName = dbEntry?.baseName ?? defaultBaseName
      const transcriptPath = path.join(transcriptDir, `${baseName}.txt`)

      let audioPath = findExistingAudio(audioDir, baseName)
      if (!audioPath && dbEntry && dbEntry.baseName !== baseName) {
        audioPath = findExistingAudio(audioDir, dbEntry.baseName)
      }

      if (audioPath && !dbEntry) {
        db.markDownloaded(rec.id, baseName, path.extname(audioPath).slice(1))
      }

      if (!db.isTranscribed(rec.id) && fs.existsSync(transcriptPath)) {
        if (!db.findByRecordingId(rec.id)) {
          db.markDownloaded(rec.id, baseName, audioPath ? path.extname(audioPath).slice(1) : '')
        }
        db.markTranscribed(rec.id)
      }

      const hadExistingAudio = Boolean(audioPath)
      const hasTranscript = fs.existsSync(transcriptPath)
      const alreadyTranscribed = db.isTranscribed(rec.id) && hasTranscript
      const countsTowardTranscription =
        !audioOnly &&
        !dryRun &&
        (!hasTranscript || retranscribe) &&
        ((!transcribeOnly) || Boolean(audioPath)) &&
        (retranscribe || !db.isTranscribed(rec.id) || Boolean(audioPath))

      if (dryRun) {
        let label = 'would transcribe existing audio'
        if (audioOnly && !audioPath) {
          label = 'would download'
        } else if (transcribeOnly && audioPath && !alreadyTranscribed) {
          label = 'would transcribe existing audio'
        } else if (!audioOnly && !transcribeOnly) {
          if (!audioPath) label = 'would download + transcribe'
          else label = 'would transcribe existing audio'
        }
        reporter.result({
          label,
          durationMs: Date.now() - itemStartedAt,
        })
        continue
      }

      if (audioOnly) {
        reporter.phase('downloading')
        try {
          const downloadedPath = await downloadRecording(client, rec.id, audioDir, baseName)
          db.markDownloaded(rec.id, baseName, path.extname(downloadedPath).slice(1))
          downloaded += 1
          reporter.phase('downloaded')
          reporter.result({
            label: 'downloaded',
            durationMs: Date.now() - itemStartedAt,
          })
        } catch (err) {
          failed += 1
          reporter.phase('failed')
          reporter.result({
            label: `failed download: ${err instanceof Error ? err.message : String(err)}`,
            durationMs: Date.now() - itemStartedAt,
            failed: true,
          })
        }
        continue
      }

      let downloadedThisRun = false
      if (!audioPath) {
        reporter.phase('downloading')
        try {
          audioPath = await downloadRecording(client, rec.id, audioDir, baseName)
          db.markDownloaded(rec.id, baseName, path.extname(audioPath).slice(1))
          downloaded += 1
          downloadedThisRun = true
          reporter.phase('downloaded')
        } catch (err) {
          failed += 1
          reporter.phase('failed')
          reporter.result({
            label: `failed download: ${err instanceof Error ? err.message : String(err)}`,
            durationMs: Date.now() - itemStartedAt,
            failed: true,
          })
          continue
        }
      }

      const audioBytes = audioPath && fs.existsSync(audioPath)
        ? fs.statSync(audioPath).size
        : rec.filesize
      let transcriptionNoDiarize = noDiarize
      let fellBackToNoDiarize = false
      const safetyIssue =
        process.env.PLAUD_SYNC_BYPASS_MEMORY_CHECK === '1'
          ? null
          : assessTranscriptionSafety({
              audioBytes,
              durationMs: rec.duration,
              diarizationEnabled: !transcriptionNoDiarize && Boolean(hfToken),
            })

      if (safetyIssue && !transcriptionNoDiarize && hfToken) {
        const noDiarizeIssue = assessTranscriptionSafety({
          audioBytes,
          durationMs: rec.duration,
          diarizationEnabled: false,
        })

        if (!noDiarizeIssue) {
          transcriptionNoDiarize = true
          fellBackToNoDiarize = true
          reporter.noteStoppedEarly(
            `Low memory for speaker diarization on "${rec.filename}". Continuing with transcription only.`,
          )
        }
      }

      if (safetyIssue && !fellBackToNoDiarize) {
        failed += 1
        reporter.phase('failed')
        reporter.result({
          label:
            `blocked by memory safety check: ${safetyIssue.reason}; ` +
            `need about ${safetyIssue.recommendedFreeGiB} GiB available before retrying`,
          durationMs: Date.now() - itemStartedAt,
          failed: true,
          countedTranscription: countsTowardTranscription,
        })
        stoppedEarly = true
        reporter.noteStoppedEarly(
          `Low memory detected before starting "${rec.filename}". Stopping cleanly so you can retry later after freeing memory.`,
        )
        break
      }

      const timings = {
        transcriptionMs: 0,
        diarizationMs: 0,
        writeMs: 0,
      }

      try {
        await transcriber.transcribe(audioPath, transcriptPath, hfToken, verbose, transcriptionNoDiarize, {
          onPhaseChange: (phase) => reporter.phase(phase),
          onTiming: (phaseTiming) => {
            timings.transcriptionMs = phaseTiming.transcriptionMs
            timings.diarizationMs = phaseTiming.diarizationMs
            timings.writeMs = phaseTiming.writeMs
          },
        })
        db.markTranscribed(rec.id)
        if (deleteAudioAfterTranscribe && fs.existsSync(audioPath)) {
          fs.unlinkSync(audioPath)
        }
        transcribed += 1
        reporter.phase('done')
        reporter.result({
          label: parseResultLabel({
            downloaded: downloadedThisRun,
            transcribed: true,
            hadExistingAudio,
            fellBackToNoDiarize,
          }),
          durationMs: Date.now() - itemStartedAt,
          timings,
          countedTranscription: countsTowardTranscription,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)

        if (!fellBackToNoDiarize && !transcriptionNoDiarize && hfToken && isDiarizationMemorySafetyMessage(message)) {
          reporter.noteStoppedEarly(
            `Low memory during speaker diarization for "${rec.filename}". Retrying without diarization.`,
          )
          try {
            await transcriber.transcribe(audioPath, transcriptPath, hfToken, verbose, true, {
              onPhaseChange: (phase) => reporter.phase(phase),
              onTiming: (phaseTiming) => {
                timings.transcriptionMs = phaseTiming.transcriptionMs
                timings.diarizationMs = phaseTiming.diarizationMs
                timings.writeMs = phaseTiming.writeMs
              },
            })
            db.markTranscribed(rec.id)
            if (deleteAudioAfterTranscribe && fs.existsSync(audioPath)) {
              fs.unlinkSync(audioPath)
            }
            transcribed += 1
            reporter.phase('done')
            reporter.result({
              label: parseResultLabel({
                downloaded: downloadedThisRun,
                transcribed: true,
                hadExistingAudio,
                fellBackToNoDiarize: true,
              }),
              durationMs: Date.now() - itemStartedAt,
              timings,
              countedTranscription: countsTowardTranscription,
            })
            continue
          } catch (retryErr) {
            const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr)
            failed += 1
            reporter.phase('failed')
            reporter.result({
              label: `failed transcription: ${retryMessage}`,
              durationMs: Date.now() - itemStartedAt,
              failed: true,
              timings,
              countedTranscription: countsTowardTranscription,
            })
            if (isMemorySafetyMessage(retryMessage)) {
              stoppedEarly = true
              reporter.noteStoppedEarly(
                `Low memory detected while transcribing "${rec.filename}". Stopping cleanly so you can retry later after freeing memory.`,
              )
              break
            }
            continue
          }
        }

        failed += 1
        reporter.phase('failed')
        reporter.result({
          label: `failed transcription: ${message}`,
          durationMs: Date.now() - itemStartedAt,
          failed: true,
          timings,
          countedTranscription: countsTowardTranscription,
        })
        if (isMemorySafetyMessage(message)) {
          stoppedEarly = true
          reporter.noteStoppedEarly(
            `Low memory detected while transcribing "${rec.filename}". Stopping cleanly so you can retry later after freeing memory.`,
          )
          break
        }
      }
    }

    const summary: SyncRunSummary = {
      scanned: recordings.length,
      selected: actionable.length,
      downloaded,
      transcribed,
      skipped,
      failed,
      wallTimeMs: Date.now() - runStartedAt,
      stoppedEarly,
    }
    reporter.finish(summary)
    return summary
  } finally {
    db.close()
  }
}

async function downloadRecording(
  client: PlaudClient,
  id: string,
  audioDir: string,
  baseName: string,
): Promise<string> {
  const mp3Url = await client.getMp3Url(id)

  if (mp3Url) {
    const res = await fetch(mp3Url)
    if (!res.ok) {
      throw new Error(`MP3 download failed: ${res.status} ${res.statusText}`)
    }
    const filePath = path.join(audioDir, `${baseName}.mp3`)
    try {
      await streamResponseToFile(res, filePath)
      return filePath
    } catch (err) {
      fs.rmSync(filePath, { force: true })
      throw err
    }
  }

  const res = await client.downloadAudio(id)
  const filePath = path.join(audioDir, `${baseName}.opus`)
  try {
    await streamResponseToFile(res, filePath)
    return filePath
  } catch (err) {
    fs.rmSync(filePath, { force: true })
    throw err
  }
}

async function streamResponseToFile(res: Response, filePath: string): Promise<void> {
  if (!res.body) {
    throw new Error('Download response had no body')
  }

  const output = fs.createWriteStream(filePath)
  try {
    await pipeline(Readable.fromWeb(res.body as globalThis.ReadableStream), output)
  } catch (err) {
    output.destroy()
    throw err
  }
}
