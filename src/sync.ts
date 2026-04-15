import * as fs from 'fs'
import * as path from 'path'
import type { PlaudClient } from './client.js'
import type { Transcriber } from './transcriber.js'
import type { PlaudRecording } from './types.js'
import { SyncDb } from './db.js'

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

export interface SyncOptions {
  hfToken?: string
  concurrency?: number
  audioOnly?: boolean
  transcribeOnly?: boolean
  verbose?: boolean
  noDiarize?: boolean
  retranscribe?: boolean
  deleteAudioAfterTranscribe?: boolean
}

export async function syncRecordings(
  client: PlaudClient,
  transcriber: Transcriber,
  outputFolder: string,
  options: SyncOptions = {},
): Promise<void> {
  const {
    hfToken,
    concurrency = 1,
    audioOnly = false,
    transcribeOnly = false,
    verbose = false,
    noDiarize = false,
    retranscribe = false,
    deleteAudioAfterTranscribe = true,
  } = options
  const audioDir = path.join(outputFolder, 'audio')
  const transcriptDir = path.join(outputFolder, 'transcripts')
  fs.mkdirSync(audioDir, { recursive: true })
  fs.mkdirSync(transcriptDir, { recursive: true })

  const db = new SyncDb(outputFolder)

  try {
    process.stdout.write('Fetching recordings...\n')
    const recordings = await client.listRecordings()
    const sorted = [...recordings].sort((a, b) => b.start_time - a.start_time)
    process.stdout.write(`Found ${sorted.length} recording(s)\n`)

    let downloaded = 0
    let transcribed = 0
    let skipped = 0
    let failed = 0
    let downloadFailed = 0
    if (!transcribeOnly && !audioOnly && concurrency > 1) {
      process.stdout.write('Sequential sync enabled: processing one recording at a time.\n')
    }

    for (let i = 0; i < sorted.length; i++) {
      const rec = sorted[i]
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

      if (audioOnly) {
        if (audioPath) {
          skipped++
          continue
        }

        const progress = `[${i + 1}/${sorted.length}]`
        process.stdout.write(`${progress} Downloading ${rec.filename}...`)
        try {
          const downloadedPath = await downloadRecording(client, rec.id, audioDir, baseName)
          db.markDownloaded(rec.id, baseName, path.extname(downloadedPath).slice(1))
          downloaded++
          process.stdout.write(' done\n')
        } catch (err) {
          downloadFailed++
          failed++
          process.stdout.write(' failed\n')
          const message = err instanceof Error ? err.message : String(err)
          process.stderr.write(`  Error: ${message}\n`)
        }
        continue
      }

      if (!retranscribe && db.isTranscribed(rec.id) && !audioPath) {
        skipped++
        continue
      }

      if (!audioPath) {
        if (transcribeOnly) {
          skipped++
          continue
        }

        const progress = `[${i + 1}/${sorted.length}]`
        process.stdout.write(`${progress} Downloading ${rec.filename}...`)
        try {
          audioPath = await downloadRecording(client, rec.id, audioDir, baseName)
          db.markDownloaded(rec.id, baseName, path.extname(audioPath).slice(1))
          downloaded++
          process.stdout.write(' done\n')
        } catch (err) {
          downloadFailed++
          failed++
          process.stdout.write(' failed\n')
          const message = err instanceof Error ? err.message : String(err)
          process.stderr.write(`  Error: ${message}\n`)
          continue
        }
      }

      if (!retranscribe && db.isTranscribed(rec.id) && fs.existsSync(transcriptPath)) {
        skipped++
        continue
      }

      const start = Date.now()
      const timer = verbose ? null : setInterval(() => {
        const elapsed = Math.floor((Date.now() - start) / 1000)
        process.stdout.write(`\r  [${i + 1}/${sorted.length}] ${rec.filename} (${elapsed}s)`)
      }, 1000)
      if (verbose) {
        process.stdout.write(`  [${i + 1}/${sorted.length}] ${rec.filename}\n`)
      } else {
        process.stdout.write(`  [${i + 1}/${sorted.length}] ${rec.filename} (0s)`)
      }

      try {
        await transcriber.transcribe(audioPath, transcriptPath, hfToken, verbose, noDiarize)
        db.markTranscribed(rec.id)
        if (deleteAudioAfterTranscribe && fs.existsSync(audioPath)) {
          fs.unlinkSync(audioPath)
        }
        transcribed++
        if (timer) clearInterval(timer)
        const elapsed = Math.floor((Date.now() - start) / 1000)
        if (verbose) {
          process.stdout.write(`  [${i + 1}/${sorted.length}] ${rec.filename} done (${elapsed}s)\n`)
        } else {
          process.stdout.write(`\r  [${i + 1}/${sorted.length}] ${rec.filename} done (${elapsed}s)\n`)
        }
      } catch (err) {
        failed++
        if (timer) clearInterval(timer)
        const elapsed = Math.floor((Date.now() - start) / 1000)
        if (verbose) {
          process.stdout.write(`  [${i + 1}/${sorted.length}] ${rec.filename} failed (${elapsed}s)\n`)
        } else {
          process.stdout.write(`\r  [${i + 1}/${sorted.length}] ${rec.filename} failed (${elapsed}s)\n`)
        }
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`    Error: ${message}\n`)
      }
    }

    if (audioOnly) {
      process.stdout.write(`\nDone: ${downloaded} downloaded, ${downloadFailed} failed\n`)
      return
    }

    process.stdout.write(`\nDone: ${downloaded} downloaded, ${transcribed} transcribed, ${skipped} skipped, ${failed} failed\n`)
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
    const buffer = await res.arrayBuffer()
    const filePath = path.join(audioDir, `${baseName}.mp3`)
    fs.writeFileSync(filePath, Buffer.from(buffer))
    return filePath
  }

  const buffer = await client.downloadAudio(id)
  const filePath = path.join(audioDir, `${baseName}.opus`)
  fs.writeFileSync(filePath, Buffer.from(buffer))
  return filePath
}
