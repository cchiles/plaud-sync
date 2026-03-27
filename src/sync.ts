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

export async function syncRecordings(
  client: PlaudClient,
  transcriber: Transcriber,
  outputFolder: string,
): Promise<void> {
  const audioDir = path.join(outputFolder, 'audio')
  const transcriptDir = path.join(outputFolder, 'transcripts')
  fs.mkdirSync(audioDir, { recursive: true })
  fs.mkdirSync(transcriptDir, { recursive: true })

  const recordings = await client.listRecordings()
  const sorted = [...recordings].sort((a, b) => a.start_time - b.start_time)

  let synced = 0
  let skipped = 0
  let failed = 0

  for (const rec of sorted) {
    const baseName = generateFilename(rec)

    try {
      let audioPath = findExistingAudio(audioDir, baseName)

      if (!audioPath) {
        audioPath = await downloadRecording(client, rec.id, audioDir, baseName)
        synced++
      } else {
        skipped++
      }

      const transcriptPath = path.join(transcriptDir, `${baseName}.txt`)
      if (!fs.existsSync(transcriptPath)) {
        const transcriptBasename = path.join(transcriptDir, baseName)
        await transcriber.transcribe(audioPath, transcriptBasename)
      }
    } catch (err) {
      failed++
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Failed to sync ${rec.filename} (${rec.id}): ${message}\n`)
    }
  }

  process.stdout.write(
    `Sync complete: ${synced} new, ${skipped} skipped, ${failed} failed (${sorted.length} total)\n`,
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
