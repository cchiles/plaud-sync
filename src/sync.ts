import * as fs from 'fs'
import * as path from 'path'
import type { PlaudClient } from './client.js'
import type { Transcriber } from './transcriber.js'
import type { PlaudRecording } from './types.js'

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
}

export async function syncRecordings(
  client: PlaudClient,
  transcriber: Transcriber,
  outputFolder: string,
  options: SyncOptions = {},
): Promise<void> {
  const { hfToken, concurrency = 2, audioOnly = false, transcribeOnly = false, verbose = false } = options
  const audioDir = path.join(outputFolder, 'audio')
  const transcriptDir = path.join(outputFolder, 'transcripts')
  fs.mkdirSync(audioDir, { recursive: true })
  fs.mkdirSync(transcriptDir, { recursive: true })

  process.stdout.write('Fetching recordings...\n')
  const recordings = await client.listRecordings()
  const sorted = [...recordings].sort((a, b) => a.start_time - b.start_time)
  process.stdout.write(`Found ${sorted.length} recording(s)\n`)

  // Phase 1: Download audio
  let downloaded = 0
  let downloadFailed = 0
  const audioFiles: { rec: PlaudRecording; audioPath: string; baseName: string }[] = []

  if (!transcribeOnly) {
    for (let i = 0; i < sorted.length; i++) {
      const rec = sorted[i]
      const baseName = generateFilename(rec)
      const existing = findExistingAudio(audioDir, baseName)

      if (existing) {
        audioFiles.push({ rec, audioPath: existing, baseName })
        continue
      }

      const progress = `[${i + 1}/${sorted.length}]`
      process.stdout.write(`${progress} Downloading ${rec.filename}...`)
      try {
        const audioPath = await downloadRecording(client, rec.id, audioDir, baseName)
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
      const baseName = generateFilename(rec)
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
  const needsTranscription = audioFiles.filter(
    ({ baseName }) => !fs.existsSync(path.join(transcriptDir, `${baseName}.txt`)),
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

      process.stdout.write(`  Starting ${rec.filename}...\n`)
      try {
        await transcriber.transcribe(audioPath, transcriptPath, hfToken, verbose)
        transcribed++
        completed++
        process.stdout.write(`  [${completed}/${total}] ${rec.filename} done\n`)
      } catch (err) {
        transcribeFailed++
        completed++
        process.stdout.write(`  [${completed}/${total}] ${rec.filename} failed\n`)
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
