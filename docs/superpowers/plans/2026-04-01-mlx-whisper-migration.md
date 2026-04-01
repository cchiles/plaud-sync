# mlx-whisper + pyannote Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace whisperx with mlx-whisper (Metal GPU acceleration) + standalone pyannote diarization for dramatically faster transcription on Apple Silicon M4.

**Architecture:** Two-phase transcription pipeline. Phase 1: mlx-whisper transcribes audio to JSON with timestamps via `uvx --from mlx-whisper mlx_whisper`. Phase 2: pyannote.audio diarizes the same audio via a bundled Python script run through `uv run`. The TypeScript transcriber merges the outputs (maximum-overlap speaker assignment) and formats the final transcript. Each Python tool runs in its own isolated uvx/uv environment — no dependency conflicts.

**Tech Stack:** mlx-whisper (MLX/Metal), pyannote.audio 3.x (PyTorch), uv/uvx, TypeScript/Bun

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/transcriber.ts` | Rewrite | Two-phase spawn (mlx_whisper + diarize), merge, format |
| `src/diarize.py` | Create | Standalone pyannote diarization script, outputs JSON to stdout |
| `install.sh` | Modify | Pre-download mlx-whisper model instead of faster-whisper model |
| `src/cli.ts` | Modify | Add `--no-diarize` flag, update help text |
| `src/sync.ts` | Modify | Pass `noDiarize` option through to transcriber |
| `test/transcriber.test.ts` | Rewrite | Mock spawn for two-phase pipeline |

---

### Task 1: Create the pyannote diarization script

**Files:**
- Create: `src/diarize.py`

- [ ] **Step 1: Write the diarization script**

```python
#!/usr/bin/env python3
"""Standalone speaker diarization using pyannote.audio.
Outputs JSON array of {start, end, speaker} to stdout.
"""
import sys
import json
from pyannote.audio import Pipeline

def main():
    audio_path = sys.argv[1]
    hf_token = sys.argv[2]

    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=hf_token,
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
```

- [ ] **Step 2: Verify script syntax**

Run: `python3 -c "import ast; ast.parse(open('src/diarize.py').read()); print('OK')"`
Expected: OK

- [ ] **Step 3: Commit**

```bash
git add src/diarize.py
git commit -m "feat: add standalone pyannote diarization script"
```

---

### Task 2: Rewrite transcriber for two-phase pipeline

**Files:**
- Modify: `src/transcriber.ts`

- [ ] **Step 1: Write the failing test for mlx-whisper transcription**

Update `test/transcriber.test.ts` to mock two spawn calls (mlx_whisper and diarize):

```typescript
import { describe, it, expect, spyOn } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as child_process from 'child_process'
import { EventEmitter } from 'events'
import { Transcriber, checkPrerequisites } from '../src/transcriber.js'

describe('Transcriber', () => {
  it('runs mlx_whisper then diarize and merges output', async () => {
    const mlxOutput = {
      text: 'Hello there. Hi, how are you?',
      segments: [
        { id: 0, start: 0.0, end: 2.0, text: ' Hello there.' },
        { id: 1, start: 2.0, end: 4.0, text: ' Hi, how are you?' },
      ],
    }

    const diarizeOutput = [
      { start: 0.0, end: 2.5, speaker: 'SPEAKER_00' },
      { start: 2.5, end: 5.0, speaker: 'SPEAKER_01' },
    ]

    let callCount = 0
    const spy = spyOn(child_process, 'spawn').mockImplementation((cmd: string, args: string[]) => {
      const emitter = new EventEmitter() as any
      emitter.stdout = new EventEmitter()
      emitter.stderr = new EventEmitter()

      callCount++
      if (callCount === 1) {
        // mlx_whisper call — write JSON to output dir
        const outDirIdx = args.indexOf('--output_dir')
        if (outDirIdx !== -1) {
          const outDir = args[outDirIdx + 1]
          fs.mkdirSync(outDir, { recursive: true })
          fs.writeFileSync(path.join(outDir, 'test.json'), JSON.stringify(mlxOutput))
        }
        setTimeout(() => emitter.emit('close', 0), 0)
      } else {
        // diarize call — emit JSON to stdout
        setTimeout(() => {
          emitter.stdout.emit('data', Buffer.from(JSON.stringify(diarizeOutput)))
          emitter.emit('close', 0)
        }, 0)
      }

      return emitter
    })

    const outputPath = path.join(os.tmpdir(), `plaud-test-${Date.now()}.txt`)

    try {
      const transcriber = new Transcriber()
      await transcriber.transcribe('/audio/test.mp3', outputPath, 'hf_test_token')

      expect(spy).toHaveBeenCalledTimes(2)

      // First call should be mlx_whisper
      const firstArgs = spy.mock.calls[0][1] as string[]
      expect(firstArgs).toContain('mlx_whisper')
      expect(firstArgs).toContain('mlx-community/whisper-large-v3-turbo')

      // Second call should be diarize
      const secondArgs = spy.mock.calls[1][1] as string[]
      expect(secondArgs.some((a: string) => a.includes('diarize.py'))).toBe(true)

      const result = fs.readFileSync(outputPath, 'utf-8')
      expect(result).toContain('[SPEAKER_00]')
      expect(result).toContain('Hello there.')
      expect(result).toContain('[SPEAKER_01]')
      expect(result).toContain('Hi, how are you?')
    } finally {
      spy.mockRestore()
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
    }
  })

  it('skips diarization when noDiarize is true', async () => {
    const mlxOutput = {
      text: 'Hello there.',
      segments: [
        { id: 0, start: 0.0, end: 2.0, text: ' Hello there.' },
      ],
    }

    const spy = spyOn(child_process, 'spawn').mockImplementation((_cmd: string, args: string[]) => {
      const emitter = new EventEmitter() as any
      emitter.stdout = new EventEmitter()
      emitter.stderr = new EventEmitter()

      const outDirIdx = args.indexOf('--output_dir')
      if (outDirIdx !== -1) {
        const outDir = args[outDirIdx + 1]
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(path.join(outDir, 'test.json'), JSON.stringify(mlxOutput))
      }
      setTimeout(() => emitter.emit('close', 0), 0)

      return emitter
    })

    const outputPath = path.join(os.tmpdir(), `plaud-test-${Date.now()}.txt`)

    try {
      const transcriber = new Transcriber()
      await transcriber.transcribe('/audio/test.mp3', outputPath, undefined, false, true)

      expect(spy).toHaveBeenCalledTimes(1)

      const result = fs.readFileSync(outputPath, 'utf-8')
      expect(result).toContain('Hello there.')
      expect(result).not.toContain('[SPEAKER_')
    } finally {
      spy.mockRestore()
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
    }
  })

  it('throws when mlx_whisper fails', async () => {
    const emitter = new EventEmitter() as any
    emitter.stdout = new EventEmitter()
    emitter.stderr = new EventEmitter()
    const spy = spyOn(child_process, 'spawn').mockImplementation(() => {
      setTimeout(() => emitter.emit('close', 1), 0)
      return emitter
    })

    try {
      const transcriber = new Transcriber()
      await expect(
        transcriber.transcribe('/audio/test.mp3', '/transcripts/test.txt'),
      ).rejects.toThrow('mlx_whisper exited with code 1')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('checkPrerequisites', () => {
  it('returns error when uv is not found', () => {
    const errors = checkPrerequisites()
    expect(Array.isArray(errors)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/transcriber.test.ts`
Expected: FAIL (transcriber doesn't have noDiarize param or mlx_whisper logic yet)

- [ ] **Step 3: Rewrite transcriber.ts**

```typescript
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

function runProcess(cmd: string, args: string[], verbose: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', verbose ? 'inherit' : 'pipe'],
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
        '--output_format', 'json',
        '--output_dir', tmpDir,
      ]

      await runProcess('uvx', mlxArgs, verbose)

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/transcriber.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/transcriber.ts test/transcriber.test.ts
git commit -m "feat: replace whisperx with mlx-whisper + pyannote two-phase pipeline"
```

---

### Task 3: Add --no-diarize flag to CLI

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/sync.ts`

- [ ] **Step 1: Add noDiarize to SyncOptions in sync.ts**

In `src/sync.ts`, add `noDiarize` to the `SyncOptions` interface and pass it through:

```typescript
// In SyncOptions interface, add:
noDiarize?: boolean

// In the destructuring at line 35, add:
const { hfToken, concurrency = 1, audioOnly = false, transcribeOnly = false, verbose = false, noDiarize = false } = options

// In the transcriber.transcribe call at line 129, add noDiarize:
await transcriber.transcribe(audioPath, transcriptPath, hfToken, verbose, noDiarize)
```

- [ ] **Step 2: Add --no-diarize flag parsing in cli.ts**

In `src/cli.ts`, add the flag to the sync command:

```typescript
// In SyncFlags interface (~line 161), add:
noDiarize: boolean

// In the sync case (~line 307), add to variable declarations:
let noDiarize = false

// In the for loop, add a new else-if:
} else if (syncArgs[i] === '--no-diarize') {
  noDiarize = true

// In the return call, add noDiarize:
return syncCommand(folder, { concurrency, audioOnly, transcribeOnly, verbose, noDiarize })

// In syncCommand function (~line 196), pass through:
noDiarize: flags.noDiarize,

// Update USAGE string to include the flag:
//   --no-diarize                   Skip speaker diarization

// Update help text: change "Show whisperx output" to "Show transcription output"
```

- [ ] **Step 3: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts src/sync.ts
git commit -m "feat: add --no-diarize flag to skip speaker diarization"
```

---

### Task 4: Update install.sh for mlx-whisper model pre-download

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Replace the model pre-download section**

Replace the whisperx model download block with:

```bash
# Pre-download mlx-whisper model so first sync is fast
echo "Pre-downloading mlx-whisper model (large-v3-turbo)..."
uvx --python 3.12 --from mlx-whisper python -c "
from mlx_whisper import transcribe
from huggingface_hub import snapshot_download
snapshot_download('mlx-community/whisper-large-v3-turbo')
print('Model cached.')
"
```

- [ ] **Step 2: Commit**

```bash
git add install.sh
git commit -m "feat: update install.sh to pre-download mlx-whisper model"
```

---

### Task 5: Update sync.ts to not require HF token when --no-diarize

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Make HF token optional when --no-diarize is set**

In `syncCommand` in `src/cli.ts`, change the HF token check (~line 178):

```typescript
  const hfToken = config.getHfToken()
  if (!hfToken && !flags.noDiarize) {
    process.stderr.write('No HF token found. Run `plaud-sync login` or set HF_TOKEN.\n')
    process.exit(1)
  }
```

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "fix: allow sync without HF token when --no-diarize is set"
```

---

### Task 6: Final integration test

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 2: Verify build compiles**

Run: `bun build bin/plaud-sync.ts --compile --outfile /tmp/plaud-sync-test`
Expected: Build succeeds

- [ ] **Step 3: Clean up test binary**

Run: `rm /tmp/plaud-sync-test`
