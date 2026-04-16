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

const DEFAULT_TRANSCRIPTION_MODEL = 'mlx-community/whisper-small-mlx'

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
  availableBytes: number
  freeBytes: number
  reclaimableBytes: number
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
const RAW_MEMORY_SNAPSHOT_MODE = 'raw'

function toGiB(bytes: number): number {
  return bytes / GIB
}

function roundGiB(bytes: number): number {
  return Math.round(toGiB(bytes) * 10) / 10
}

function isJsonTokenBoundary(char: string | undefined): boolean {
  return char == null || /[\s,[\]{}:]/.test(char)
}

function normalizeNonFiniteJsonNumbers(raw: string): string {
  let normalized = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < raw.length; i++) {
    const current = raw[i]

    if (inString) {
      normalized += current
      if (escaped) {
        escaped = false
      } else if (current === '\\') {
        escaped = true
      } else if (current === '"') {
        inString = false
      }
      continue
    }

    if (current === '"') {
      inString = true
      normalized += current
      continue
    }

    if (raw.startsWith('-Infinity', i) && isJsonTokenBoundary(raw[i - 1]) && isJsonTokenBoundary(raw[i + 9])) {
      normalized += 'null'
      i += 8
      continue
    }

    if (raw.startsWith('Infinity', i) && isJsonTokenBoundary(raw[i - 1]) && isJsonTokenBoundary(raw[i + 8])) {
      normalized += 'null'
      i += 7
      continue
    }

    if (raw.startsWith('NaN', i) && isJsonTokenBoundary(raw[i - 1]) && isJsonTokenBoundary(raw[i + 3])) {
      normalized += 'null'
      i += 2
      continue
    }

    normalized += current
  }

  return normalized
}

function parsePossiblyNonFiniteJson<T>(raw: string): T {
  return JSON.parse(normalizeNonFiniteJsonNumbers(raw)) as T
}

function sanitizeWhisperSegments(segments: MlxWhisperSegment[]): MlxWhisperSegment[] {
  return segments.filter((segment) =>
    Number.isFinite(segment.start) &&
    Number.isFinite(segment.end) &&
    typeof segment.text === 'string',
  )
}

function sanitizeDiarizationSegments(segments: DiarizeSegment[]): DiarizeSegment[] {
  return segments.filter((segment) =>
    Number.isFinite(segment.start) &&
    Number.isFinite(segment.end) &&
    typeof segment.speaker === 'string' &&
    segment.speaker.length > 0,
  )
}

export function parseMacOSVmStatSnapshot(output: string, totalBytes: number): MemorySnapshot | null {
  const pageSizeMatch = output.match(/page size of (\d+) bytes/i)
  if (!pageSizeMatch) return null

  const pageSize = Number.parseInt(pageSizeMatch[1], 10)
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null

  const readPageCount = (label: string): number => {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = output.match(new RegExp(`${escapedLabel}:\\s+(\\d+)\\.?`, 'i'))
    return match ? Number.parseInt(match[1], 10) : 0
  }

  const freeBytes = readPageCount('Pages free') * pageSize
  const speculativeBytes = readPageCount('Pages speculative') * pageSize
  const inactiveBytes = readPageCount('Pages inactive') * pageSize
  const purgeableBytes = readPageCount('Pages purgeable') * pageSize
  const reclaimableBytes = speculativeBytes + inactiveBytes + purgeableBytes
  const availableBytes = Math.min(totalBytes, freeBytes + reclaimableBytes)

  return {
    availableBytes,
    freeBytes,
    reclaimableBytes,
    totalBytes,
  }
}

export function getMemorySnapshot(): MemorySnapshot {
  const totalBytes = os.totalmem()
  const freeBytes = os.freemem()

  if (process.platform !== 'darwin' || process.env.PLAUD_SYNC_MEMORY_SNAPSHOT_MODE === RAW_MEMORY_SNAPSHOT_MODE) {
    return {
      availableBytes: freeBytes,
      freeBytes,
      reclaimableBytes: 0,
      totalBytes,
    }
  }

  try {
    const vmStat = execFileSync('vm_stat', { encoding: 'utf-8' })
    return parseMacOSVmStatSnapshot(vmStat, totalBytes) ?? {
      availableBytes: freeBytes,
      freeBytes,
      reclaimableBytes: 0,
      totalBytes,
    }
  } catch {
    return {
      availableBytes: freeBytes,
      freeBytes,
      reclaimableBytes: 0,
      totalBytes,
    }
  }
}

function estimateWorkingSetBytes(input: TranscriptionSafetyInput): number {
  const baseBytes = input.diarizationEnabled ? 5 * GIB : 2.5 * GIB
  const audioBytes = Math.max(0.5 * GIB, input.audioBytes * 0.5)
  const durationBytes =
    Math.ceil(input.durationMs / (30 * 60 * 1000)) * (input.diarizationEnabled ? 0.5 * GIB : 0.25 * GIB)
  return baseBytes + audioBytes + durationBytes
}

function getRuntimeSafetyThresholds(input: TranscriptionSafetyInput): RuntimeSafetyThresholds {
  const estimatedNeedBytes = estimateWorkingSetBytes(input)
  const stopFreeBytes = Math.max(
    input.diarizationEnabled ? 4 * GIB : 1.5 * GIB,
    Math.ceil(estimatedNeedBytes * 0.25),
  )

  return {
    stopFreeBytes,
    stopFreeGiB: roundGiB(stopFreeBytes),
    estimatedNeedGiB: roundGiB(estimatedNeedBytes),
  }
}

export function assessTranscriptionSafety(
  input: TranscriptionSafetyInput,
  memory: MemorySnapshot = getMemorySnapshot(),
): TranscriptionSafetyIssue | null {
  const estimatedNeedBytes = estimateWorkingSetBytes(input)
  const recommendedFreeBytes = Math.max(
    input.diarizationEnabled ? 4.5 * GIB : 2 * GIB,
    Math.ceil(estimatedNeedBytes * 0.35),
  )
  const minimumTotalBytes = input.diarizationEnabled ? 8 * GIB : 4 * GIB
  const currentAvailableGiB = roundGiB(memory.availableBytes)
  const estimatedNeedGiB = roundGiB(estimatedNeedBytes)
  const recommendedFreeGiB = roundGiB(recommendedFreeBytes)

  if (memory.totalBytes < minimumTotalBytes) {
    return {
      reason: `machine has ${roundGiB(memory.totalBytes)} GiB total RAM; this mode expects at least ${roundGiB(minimumTotalBytes)} GiB`,
      recommendedFreeGiB,
      currentFreeGiB: currentAvailableGiB,
      estimatedNeedGiB,
    }
  }

  if (memory.availableBytes < recommendedFreeBytes) {
    return {
      reason: `only ${currentAvailableGiB} GiB available; this recording is estimated to need about ${estimatedNeedGiB} GiB of working memory`,
      recommendedFreeGiB,
      currentFreeGiB: currentAvailableGiB,
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
        const memory = getMemorySnapshot()
        if (memory.availableBytes >= thresholds.stopFreeBytes || watchdogReason) return

        watchdogReason =
          `${options.phaseLabel ?? 'transcription'} stopped to protect system memory: ` +
          `available memory fell to ${roundGiB(memory.availableBytes)} GiB, below the ${thresholds.stopFreeGiB} GiB safety floor ` +
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
        '--model', DEFAULT_TRANSCRIPTION_MODEL,
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
      if (!fs.existsSync(jsonPath)) {
        throw new Error(
          `transcription finished without producing JSON output at ${jsonPath}; ` +
          `check that model ${DEFAULT_TRANSCRIPTION_MODEL} is available`,
        )
      }
      const raw = fs.readFileSync(jsonPath, 'utf-8')
      const data = parsePossiblyNonFiniteJson<{ segments: MlxWhisperSegment[] }>(raw)
      data.segments = sanitizeWhisperSegments(data.segments ?? [])

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
      const diarization = sanitizeDiarizationSegments(
        parsePossiblyNonFiniteJson<DiarizeSegment[]>(diarizeJson),
      )

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
