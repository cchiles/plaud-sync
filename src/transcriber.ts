import { spawn, execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

interface MlxWhisperSegment {
  id: number
  start: number
  end: number
  text: string
}

interface DiarizeSegment {
  start: number
  end: number
  speaker: string
}

interface MergedSegment {
  start: number
  end: number
  text: string
  speaker: string
}

function runProcess(cmd: string, args: string[], verbose: boolean, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', verbose ? 'inherit' : 'pipe'],
      env: { ...process.env, ...env },
    })

    const chunks: Buffer[] = []
    proc.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk))

    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString())
      else reject(new Error(`${cmd} ${args[0]} exited with code ${code}`))
    })
    proc.on('error', reject)
  })
}

function assignSpeakers(
  segments: MlxWhisperSegment[],
  diarization: DiarizeSegment[],
): MergedSegment[] {
  return segments.map((seg) => {
    let bestSpeaker = 'Unknown'
    let bestOverlap = 0

    for (const d of diarization) {
      const overlap = Math.max(0, Math.min(seg.end, d.end) - Math.max(seg.start, d.start))
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        bestSpeaker = d.speaker
      }
    }

    return { start: seg.start, end: seg.end, text: seg.text, speaker: bestSpeaker }
  })
}

export class Transcriber {
  async transcribe(
    audioPath: string,
    outputPath: string,
    hfToken?: string,
    verbose = false,
    noDiarize = false,
  ): Promise<void> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-sync-'))

    try {
      // Phase 1: Transcribe with mlx-whisper
      const mlxArgs = [
        '--python', '3.12', '--from', 'mlx-whisper', 'mlx_whisper',
        audioPath,
        '--model', 'mlx-community/whisper-large-v3-turbo',
        '--language', 'en',
        '--output-format', 'json',
        '--output-dir', tmpDir,
        '--word-timestamps', 'True',
        '--hallucination-silence-threshold', '2',
        '--compression-ratio-threshold', '2.0',
      ]

      const hfEnv = hfToken ? { HF_TOKEN: hfToken } : {}
      await runProcess('uvx', mlxArgs, verbose, hfEnv)

      const baseName = path.basename(audioPath, path.extname(audioPath))
      const jsonPath = path.join(tmpDir, `${baseName}.json`)
      const raw = fs.readFileSync(jsonPath, 'utf-8')
      const data = JSON.parse(raw) as { segments: MlxWhisperSegment[] }

      if (noDiarize || !hfToken) {
        // No diarization — format without speaker labels
        const lines = data.segments
          .map((seg) => seg.text.trim())
          .filter(Boolean)
        fs.writeFileSync(outputPath, lines.join('\n') + '\n')
        return
      }

      // Phase 2: Diarize with pyannote
      const diarizeScript = path.join(path.dirname(new URL(import.meta.url).pathname), 'diarize.py')
      const diarizeArgs = [
        'run', '--python', '3.12',
        '--with', 'pyannote-audio',
        '--with', 'torch',
        '--with', 'torchaudio',
        'python', diarizeScript, audioPath, hfToken,
      ]

      const diarizeJson = await runProcess('uv', diarizeArgs, verbose)
      const diarization = JSON.parse(diarizeJson) as DiarizeSegment[]

      // Merge and format
      const merged = assignSpeakers(data.segments, diarization)
      const formatted = formatTranscript(merged)
      fs.writeFileSync(outputPath, formatted)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }
}

function formatTranscript(segments: MergedSegment[]): string {
  const lines: string[] = []
  let lastSpeaker = ''

  for (const seg of segments) {
    const text = seg.text.trim()
    if (!text) continue

    if (seg.speaker !== lastSpeaker) {
      if (lines.length > 0) lines.push('')
      lines.push(`[${seg.speaker}]`)
      lastSpeaker = seg.speaker
    }
    lines.push(text)
  }

  return lines.join('\n') + '\n'
}

export function checkPrerequisites(): string[] {
  const errors: string[] = []

  try {
    execFileSync('which', ['uv'])
  } catch {
    errors.push('uv not found. Install with: brew install uv')
  }

  return errors
}
