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
  hfToken?: string,
): Promise<void> {
  const audioDir = path.join(outputFolder, 'audio')
  const transcriptDir = path.join(outputFolder, 'transcripts')
  fs.mkdirSync(audioDir, { recursive: true })
  fs.mkdirSync(transcriptDir, { recursive: true })

  process.stdout.write('Fetching recordings...\n')
  const recordings = await client.listRecordings()
  const sorted = [...recordings].sort((a, b) => a.start_time - b.start_time)
  process.stdout.write(`Found ${sorted.length} recording(s)\n`)

  let synced = 0
  let skipped = 0
  let failed = 0

  for (let i = 0; i < sorted.length; i++) {
    const rec = sorted[i]
    const baseName = generateFilename(rec)
    const progress = `[${i + 1}/${sorted.length}]`

    const audioExisted = !!findExistingAudio(audioDir, baseName)

    try {
      let audioPath = findExistingAudio(audioDir, baseName)
      const transcriptPath = path.join(transcriptDir, `${baseName}.txt`)
      const hasTranscript = fs.existsSync(transcriptPath)

      if (audioPath && hasTranscript) {
        skipped++
        continue
      }

      if (!audioPath) {
        process.stdout.write(`${progress} Downloading ${rec.filename}...`)
        audioPath = await downloadRecording(client, rec.id, audioDir, baseName)
        synced++
        process.stdout.write(' done\n')
      }

      if (!hasTranscript) {
        process.stdout.write(`${progress} Transcribing ${rec.filename}...`)
        await transcriber.transcribe(audioPath, transcriptPath, hfToken)
        process.stdout.write(' done\n')
      }
    } catch (err) {
      failed++
      process.stdout.write(' failed\n')
      if (!audioExisted) {
        for (const ext of ['mp3', 'opus']) {
          const partial = path.join(audioDir, `${baseName}.${ext}`)
          if (fs.existsSync(partial)) fs.unlinkSync(partial)
        }
      }
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`  Error: ${message}\n`)
    }
  }

  process.stdout.write(
    `\nDone: ${synced} downloaded, ${skipped} skipped, ${failed} failed\n`,
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
