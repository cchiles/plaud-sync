import { spawn, execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const DIARIZE_PY = `#!/usr/bin/env python3
import sys
import json
from pyannote.audio import Pipeline

def main():
    audio_path = sys.argv[1]
    hf_token = sys.argv[2]

    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        token=hf_token,
    )

    diarization = pipeline(audio_path)

    segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append({
            "start": round(turn.start, 3),
            "end": round(turn.end, 3),
            "speaker": speaker,
        })

    json.dump(segments, sys.stdout)

if __name__ == "__main__":
    main()
`

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

interface MemorySnapshot {
  freeBytes: number
  totalBytes: number
}

export interface TranscriptionSafetyInput {
  audioBytes: number
  durationMs: number
  diarizationEnabled: boolean
}

export interface TranscriptionSafetyIssue {
  reason: string
  recommendedFreeGiB: number
  currentFreeGiB: number
  estimatedNeedGiB: number
}

interface RuntimeSafetyThresholds {
  stopFreeBytes: number
  stopFreeGiB: number
  estimatedNeedGiB: number
}

export type TranscriptionPhase =
  | 'transcribing'
  | 'diarizing'
  | 'writing transcript'

export interface TranscribeHooks {
  onPhaseChange?: (phase: TranscriptionPhase) => void
  onTiming?: (timing: { transcriptionMs: number; diarizationMs: number; writeMs: number }) => void
}

const GIB = 1024 ** 3
const DEFAULT_MEMORY_POLL_MS = 2000

function toGiB(bytes: number): number {
  return bytes / GIB
}

function roundGiB(bytes: number): number {
  return Math.round(toGiB(bytes) * 10) / 10
}

function estimateWorkingSetBytes(input: TranscriptionSafetyInput): number {
  const baseBytes = input.diarizationEnabled ? 12 * GIB : 6 * GIB
  const audioBytes = Math.max(1 * GIB, input.audioBytes * 3)
  const durationBytes = Math.ceil(input.durationMs / (30 * 60 * 1000)) * (input.diarizationEnabled ? 1.5 * GIB : 0.75 * GIB)
  return baseBytes + audioBytes + durationBytes
}

function getRuntimeSafetyThresholds(input: TranscriptionSafetyInput): RuntimeSafetyThresholds {
  const estimatedNeedBytes = estimateWorkingSetBytes(input)
  const stopFreeBytes = Math.max(
    input.diarizationEnabled ? 6 * GIB : 2 * GIB,
    Math.ceil(estimatedNeedBytes * 0.35),
  )

  return {
    stopFreeBytes,
    stopFreeGiB: roundGiB(stopFreeBytes),
    estimatedNeedGiB: roundGiB(estimatedNeedBytes),
  }
}

export function assessTranscriptionSafety(
  input: TranscriptionSafetyInput,
  memory: MemorySnapshot = { freeBytes: os.freemem(), totalBytes: os.totalmem() },
): TranscriptionSafetyIssue | null {
  const estimatedNeedBytes = estimateWorkingSetBytes(input)
  const recommendedFreeBytes = Math.max(
    input.diarizationEnabled ? 10 * GIB : 4 * GIB,
    Math.ceil(estimatedNeedBytes * 0.75),
  )
  const minimumTotalBytes = input.diarizationEnabled ? 16 * GIB : 8 * GIB
  const currentFreeGiB = roundGiB(memory.freeBytes)
  const estimatedNeedGiB = roundGiB(estimatedNeedBytes)
  const recommendedFreeGiB = roundGiB(recommendedFreeBytes)

  if (memory.totalBytes < minimumTotalBytes) {
    return {
      reason: `machine has ${roundGiB(memory.totalBytes)} GiB total RAM; this mode expects at least ${roundGiB(minimumTotalBytes)} GiB`,
      recommendedFreeGiB,
      currentFreeGiB,
      estimatedNeedGiB,
    }
  }

  if (memory.freeBytes < recommendedFreeBytes) {
    return {
      reason: `only ${currentFreeGiB} GiB free; this recording is estimated to need about ${estimatedNeedGiB} GiB of working memory`,
      recommendedFreeGiB,
      currentFreeGiB,
      estimatedNeedGiB,
    }
  }

  return null
}

function runProcess(
  cmd: string,
  args: string[],
  options: {
    verbose: boolean
    captureStdout?: boolean
    env?: Record<string, string>
    safetyInput?: TranscriptionSafetyInput
    phaseLabel?: string
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const captureStdout = options.captureStdout ?? false
    const proc = spawn(cmd, args, {
      stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', options.verbose ? 'inherit' : 'pipe'],
      env: { ...process.env, ...options.env },
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const thresholds = options.safetyInput ? getRuntimeSafetyThresholds(options.safetyInput) : null
    const pollMs = Math.max(
      250,
      Number.parseInt(process.env.PLAUD_SYNC_MEMORY_POLL_MS ?? `${DEFAULT_MEMORY_POLL_MS}`, 10) || DEFAULT_MEMORY_POLL_MS,
    )
    let watchdogReason: string | null = null
    let settled = false
    let watchdogTimer: ReturnType<typeof setInterval> | undefined

    if (captureStdout && proc.stdout) {
      proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    }
    if (!options.verbose && proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    }

    if (thresholds) {
      watchdogTimer = setInterval(() => {
        const freeBytes = os.freemem()
        if (freeBytes >= thresholds.stopFreeBytes || watchdogReason) return

        watchdogReason =
          `${options.phaseLabel ?? 'transcription'} stopped to protect system memory: ` +
          `free memory fell to ${roundGiB(freeBytes)} GiB, below the ${thresholds.stopFreeGiB} GiB safety floor ` +
          `(job estimate ${thresholds.estimatedNeedGiB} GiB)`

        proc.kill('SIGTERM')
      }, pollMs)
    }

    const cleanup = () => {
      if (watchdogTimer) clearInterval(watchdogTimer)
    }

    proc.on('close', (code) => {
      cleanup()
      if (settled) return
      settled = true

      if (watchdogReason) {
        reject(new Error(watchdogReason))
        return
      }

      if (code === 0) {
        resolve(captureStdout ? Buffer.concat(stdoutChunks).toString() : '')
        return
      }

      const stderr = Buffer.concat(stderrChunks).toString().trim()
      const detail = stderr ? `: ${stderr}` : ''
      reject(new Error(`${cmd} ${args[0]} exited with code ${code}${detail}`))
    })
    proc.on('error', (err) => {
      cleanup()
      if (settled) return
      settled = true
      reject(err)
    })
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
    hooks: TranscribeHooks = {},
  ): Promise<void> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-sync-'))
    const audioStats = fs.statSync(audioPath)
    const safetyInput: TranscriptionSafetyInput = {
      audioBytes: audioStats.size,
      durationMs: Math.max(1, Math.ceil(audioStats.size / (32 * 1024))),
      diarizationEnabled: !noDiarize && Boolean(hfToken),
    }
    const phaseTimings = {
      transcriptionMs: 0,
      diarizationMs: 0,
      writeMs: 0,
    }

    try {
      hooks.onPhaseChange?.('transcribing')
      // Phase 1: Transcribe with mlx-whisper
      const mlxArgs = [
        '--python', '3.12', '--from', 'mlx-whisper', 'mlx_whisper',
        audioPath,
        '--model', 'mlx-community/whisper-large-v3-turbo',
        '--language', 'en',
        '--output-format', 'json',
        '--output-dir', tmpDir,
        '--compression-ratio-threshold', '2.0',
      ]
      if (verbose) mlxArgs.push('--verbose', 'True')
      if (!noDiarize && hfToken) {
        // Word timestamps needed for accurate speaker merge, also enables hallucination silence detection
        mlxArgs.push('--word-timestamps', 'True', '--hallucination-silence-threshold', '2')
      }

      const hfEnv = hfToken ? { HF_TOKEN: hfToken } : undefined
      const transcriptionStartedAt = Date.now()
      await runProcess('uvx', mlxArgs, {
        verbose,
        captureStdout: false,
        env: hfEnv,
        safetyInput,
        phaseLabel: 'transcription',
      })
      phaseTimings.transcriptionMs = Date.now() - transcriptionStartedAt

      const baseName = path.basename(audioPath, path.extname(audioPath))
      const jsonPath = path.join(tmpDir, `${baseName}.json`)
      const raw = fs.readFileSync(jsonPath, 'utf-8')
      const data = JSON.parse(raw) as { segments: MlxWhisperSegment[] }

      if (noDiarize || !hfToken) {
        // No diarization — format without speaker labels
        const lines = data.segments
          .map((seg) => seg.text.trim())
          .filter(Boolean)
        hooks.onPhaseChange?.('writing transcript')
        const writeStartedAt = Date.now()
        fs.writeFileSync(outputPath, lines.join('\n') + '\n')
        phaseTimings.writeMs = Date.now() - writeStartedAt
        hooks.onTiming?.(phaseTimings)
        return
      }

      // Phase 2: Diarize with pyannote
      const diarizeScript = path.join(tmpDir, 'diarize.py')
      fs.writeFileSync(diarizeScript, DIARIZE_PY)
      const diarizeArgs = [
        'run', '--python', '3.12',
        '--with', 'pyannote-audio',
        '--with', 'torch',
        '--with', 'torchaudio',
        'python', diarizeScript, audioPath, hfToken,
      ]

      hooks.onPhaseChange?.('diarizing')
      const diarizationStartedAt = Date.now()
      const diarizeJson = await runProcess('uv', diarizeArgs, {
        verbose,
        captureStdout: true,
        env: hfEnv,
        safetyInput,
        phaseLabel: 'diarization',
      })
      phaseTimings.diarizationMs = Date.now() - diarizationStartedAt
      const diarization = JSON.parse(diarizeJson) as DiarizeSegment[]

      // Merge and format
      const merged = assignSpeakers(data.segments, diarization)
      const formatted = formatTranscript(merged)
      hooks.onPhaseChange?.('writing transcript')
      const writeStartedAt = Date.now()
      fs.writeFileSync(outputPath, formatted)
      phaseTimings.writeMs = Date.now() - writeStartedAt
      hooks.onTiming?.(phaseTimings)
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
