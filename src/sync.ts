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

    // Phase 1: Download audio
    let downloaded = 0
    let downloadFailed = 0
    const audioFiles: { rec: PlaudRecording; audioPath: string; baseName: string }[] = []

    if (!transcribeOnly) {
      for (let i = 0; i < sorted.length; i++) {
        const rec = sorted[i]
        const baseName = generateFilename(rec)

        // Check database first (by recording ID)
        const dbEntry = db.findByRecordingId(rec.id)
        if (dbEntry) {
          const existing = findExistingAudio(audioDir, dbEntry.baseName)
          if (existing) {
            // Backfill transcription status if transcript exists on disk
            if (!db.isTranscribed(rec.id) && fs.existsSync(path.join(transcriptDir, `${dbEntry.baseName}.txt`))) {
              db.markTranscribed(rec.id)
            }
            audioFiles.push({ rec, audioPath: existing, baseName: dbEntry.baseName })
            continue
          }
          if (
            deleteAudioAfterTranscribe &&
            !retranscribe &&
            fs.existsSync(path.join(transcriptDir, `${dbEntry.baseName}.txt`))
          ) {
            if (!db.isTranscribed(rec.id)) {
              db.markTranscribed(rec.id)
            }
            continue
          }
        }

        // Fall back to filename match on disk
        const existing = findExistingAudio(audioDir, baseName)
        if (existing) {
          db.markDownloaded(rec.id, baseName, path.extname(existing).slice(1))
          // Backfill transcription status if transcript exists on disk
          if (fs.existsSync(path.join(transcriptDir, `${baseName}.txt`))) {
            db.markTranscribed(rec.id)
          }
          audioFiles.push({ rec, audioPath: existing, baseName })
          continue
        }
        if (
          deleteAudioAfterTranscribe &&
          !retranscribe &&
          fs.existsSync(path.join(transcriptDir, `${baseName}.txt`))
        ) {
          db.markDownloaded(rec.id, baseName, '')
          db.markTranscribed(rec.id)
          continue
        }

        const progress = `[${i + 1}/${sorted.length}]`
        process.stdout.write(`${progress} Downloading ${rec.filename}...`)
        try {
          const audioPath = await downloadRecording(client, rec.id, audioDir, baseName)
          const ext = path.extname(audioPath).slice(1)
          db.markDownloaded(rec.id, baseName, ext)
          audioFiles.push({ rec, audioPath, baseName })
          downloaded++
          process.stdout.write(' done\n')
        } catch (err) {
          downloadFailed++
          process.stdout.write(' failed\n')
          const message = err instanceof Error ? err.message : String(err)
          process.stderr.write(`  Error: ${message}\n`)
        }
      }

      if (downloaded > 0) {
        process.stdout.write(`\nDownloaded ${downloaded} recording(s)\n`)
      }
    } else {
      // transcribe-only: use existing audio files on disk
      for (const rec of sorted) {
        const dbEntry = db.findByRecordingId(rec.id)
        const baseName = dbEntry?.baseName ?? generateFilename(rec)
        const existing = findExistingAudio(audioDir, baseName)
        if (existing) {
          audioFiles.push({ rec, audioPath: existing, baseName })
        }
      }
    }

    if (audioOnly) {
      process.stdout.write(`\nDone: ${downloaded} downloaded, ${downloadFailed} failed\n`)
      return
    }

    // Phase 2: Transcribe
    const needsTranscription = retranscribe
      ? audioFiles
      : audioFiles.filter(
          ({ rec, baseName }) =>
            !db.isTranscribed(rec.id) && !fs.existsSync(path.join(transcriptDir, `${baseName}.txt`)),
        )

    let transcribed = 0
    let transcribeFailed = 0
    const total = needsTranscription.length

    if (total > 0) {
      process.stdout.write(`\nTranscribing ${total} recording(s) (${concurrency} parallel)...\n`)
    }

    let nextIndex = 0
    let completed = 0

    async function worker(): Promise<void> {
      while (nextIndex < total) {
        const i = nextIndex++
        const { rec, audioPath, baseName } = needsTranscription[i]
        const transcriptPath = path.join(transcriptDir, `${baseName}.txt`)

        const start = Date.now()
        const timer = verbose ? null : setInterval(() => {
          const elapsed = Math.floor((Date.now() - start) / 1000)
          process.stdout.write(`\r  [${completed + 1}/${total}] ${rec.filename} (${elapsed}s)`)
        }, 1000)
        if (verbose) {
          process.stdout.write(`  [${completed + 1}/${total}] ${rec.filename}\n`)
        } else {
          process.stdout.write(`  [${completed + 1}/${total}] ${rec.filename} (0s)`)
        }
        try {
          await transcriber.transcribe(audioPath, transcriptPath, hfToken, verbose, noDiarize)
          db.markTranscribed(rec.id)
          if (deleteAudioAfterTranscribe && fs.existsSync(audioPath)) {
            fs.unlinkSync(audioPath)
          }
          if (timer) clearInterval(timer)
          const elapsed = Math.floor((Date.now() - start) / 1000)
          transcribed++
          completed++
          if (verbose) {
            process.stdout.write(`  [${completed}/${total}] ${rec.filename} done (${elapsed}s)\n`)
          } else {
            process.stdout.write(`\r  [${completed}/${total}] ${rec.filename} done (${elapsed}s)\n`)
          }
        } catch (err) {
          if (timer) clearInterval(timer)
          const elapsed = Math.floor((Date.now() - start) / 1000)
          transcribeFailed++
          completed++
          if (verbose) {
            process.stdout.write(`  [${completed}/${total}] ${rec.filename} failed (${elapsed}s)\n`)
          } else {
            process.stdout.write(`\r  [${completed}/${total}] ${rec.filename} failed (${elapsed}s)\n`)
          }
          const message = err instanceof Error ? err.message : String(err)
          process.stderr.write(`    Error: ${message}\n`)
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker())
    await Promise.all(workers)

    const skipped = sorted.length - downloaded - downloadFailed - needsTranscription.length + transcribed + transcribeFailed
    process.stdout.write(
      `\nDone: ${downloaded} downloaded, ${transcribed} transcribed, ${skipped} skipped, ${downloadFailed + transcribeFailed} failed\n`,
    )
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
