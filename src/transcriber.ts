import * as childProcess from 'child_process'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

function execFilePromise(
  cmd: string,
  args: string[],
  opts: { timeout?: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(cmd, args, opts, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

const HOMEBREW_MODEL_DIRS = [
  '/opt/homebrew/share/whisper-cpp/models',
  '/usr/local/share/whisper-cpp/models',
]

export class Transcriber {
  private modelPath: string

  constructor(modelPath: string) {
    this.modelPath = modelPath
  }

  async transcribe(audioPath: string, outputBasename: string): Promise<void> {
    await execFilePromise('whisper-cpp', [
      '-m', this.modelPath,
      '-f', audioPath,
      '-otxt',
      '-of', outputBasename,
    ], { timeout: 600_000 })
  }
}

export function findWhisperModel(explicitPath?: string): string | null {
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath
  }

  for (const dir of HOMEBREW_MODEL_DIRS) {
    const candidate = path.join(dir, 'ggml-large-v3-turbo.bin')
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

export function checkPrerequisites(modelPath: string | null): string[] {
  const errors: string[] = []

  try {
    execFileSync('which', ['whisper-cpp'])
  } catch {
    errors.push('whisper-cpp not found. Install with: brew install whisper-cpp')
  }

  if (!modelPath) {
    errors.push(
      'Whisper model not found. Download with: whisper-cpp-download-ggml-model large-v3-turbo',
    )
  }

  return errors
}
