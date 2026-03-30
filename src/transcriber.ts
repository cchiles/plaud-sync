import { execSync, execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

interface WhisperXSegment {
  start: number
  end: number
  text: string
  speaker?: string
}

type ExecFn = (cmd: string, opts: { timeout: number; stdio: string }) => void

export class Transcriber {
  private exec: ExecFn

  constructor(exec?: ExecFn) {
    this.exec = exec ?? ((cmd, opts) => execSync(cmd, opts as any))
  }

  async transcribe(audioPath: string, outputPath: string): Promise<void> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-sync-'))

    try {
      const hfToken = process.env.HF_TOKEN
      const args = [
        audioPath,
        '--model', 'large-v3-turbo',
        '--diarize',
        '--output_dir', tmpDir,
        '--output_format', 'json',
      ]
      if (hfToken) {
        args.push('--hf_token', hfToken)
      }

      this.exec(`whisperx ${args.map(a => `'${a}'`).join(' ')}`, {
        timeout: 600_000,
        stdio: 'pipe',
      })

      const baseName = path.basename(audioPath, path.extname(audioPath))
      const jsonPath = path.join(tmpDir, `${baseName}.json`)
      const raw = fs.readFileSync(jsonPath, 'utf-8')
      const data = JSON.parse(raw) as { segments: WhisperXSegment[] }

      const formatted = formatTranscript(data.segments)
      fs.writeFileSync(outputPath, formatted)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }
}

function formatTranscript(segments: WhisperXSegment[]): string {
  const lines: string[] = []
  let lastSpeaker = ''

  for (const seg of segments) {
    const speaker = seg.speaker ?? 'Unknown'
    const text = seg.text.trim()
    if (!text) continue

    if (speaker !== lastSpeaker) {
      if (lines.length > 0) lines.push('')
      lines.push(`[${speaker}]`)
      lastSpeaker = speaker
    }
    lines.push(text)
  }

  return lines.join('\n') + '\n'
}

export function checkPrerequisites(): string[] {
  const errors: string[] = []

  try {
    execFileSync('which', ['whisperx'])
  } catch {
    errors.push('whisperx not found. Install with: pip install whisperx')
  }

  if (!process.env.HF_TOKEN) {
    errors.push(
      'HF_TOKEN not set. Required for speaker diarization. Get a token at https://huggingface.co/settings/tokens',
    )
  }

  return errors
}
