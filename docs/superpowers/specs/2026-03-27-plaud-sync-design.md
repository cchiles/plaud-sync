# Plaud Sync — Design Spec

## Goal

A macOS CLI tool that authenticates with the Plaud API, downloads audio recordings, transcribes them locally using whisper.cpp, and saves audio + plain text transcripts to a configurable folder. Runs on-demand or automatically via launchd.

## Architecture

Single-package TypeScript CLI. No monorepo. Modules with clear boundaries: auth, API client, transcription wrapper, sync engine, CLI commands. System dependencies: whisper.cpp and ffmpeg (both via Homebrew).

## Tech Stack

- **Runtime:** Bun + TypeScript
- **CLI framework:** commander
- **Validation:** zod
- **Testing:** bun:test
- **Transcription:** whisper.cpp (system binary via Homebrew)
- **Audio conversion:** ffmpeg (system binary via Homebrew)
- **Model:** ggml-large-v3-turbo (default)

## File Structure

```
plaud-sync/
  src/
    types.ts         # Shared interfaces
    config.ts        # Credential + token storage
    auth.ts          # Plaud API authentication, token lifecycle
    client.ts        # Plaud API client
    transcriber.ts   # whisper.cpp subprocess wrapper
    sync.ts          # Sync engine orchestration
    cli.ts           # Commander CLI definitions
  bin/
    plaud-sync.ts    # Executable entry point
  test/
    config.test.ts
    auth.test.ts
    client.test.ts
    transcriber.test.ts
    sync.test.ts
```

## Config Directory

`~/.plaud-sync/` contains:

- `config.json` — credentials + token (file mode 0o600)
- `logs/` — log output from launchd runs

### config.json schema

```typescript
{
  credentials: {
    email: string
    password: string
    region: 'us' | 'eu'
  }
  token: {
    accessToken: string
    tokenType: string
    issuedAt: number   // epoch ms
    expiresAt: number  // epoch ms
  }
}
```

## Authentication

Adapted from the reference project's reverse-engineered Plaud API.

1. User runs `plaud-sync login`, enters email, password, region (us/eu)
2. POST to `{baseUrl}/auth/access-token` with URL-encoded `username` + `password`
3. Response contains `access_token` (JWT) — decode to extract `iat`/`exp`
4. Store token in config. Tokens last ~300 days.
5. Auto-refresh when token is within 30 days of expiry.

### API Base URLs

- US: `https://api.plaud.ai`
- EU: `https://api-euc1.plaud.ai`

### Region Mismatch

If API returns `status: -302` with `data.domains.api`, switch region based on domain and retry the request.

## API Client

Methods needed (no cloud transcript fetching — we transcribe locally):

- **`listRecordings()`** — GET `/file/simple/web`. Returns array of recordings. Filter out `is_trash: true`.
- **`getMp3Url(id)`** — GET `/file/temp-url/{id}?is_opus=false`. Returns temporary MP3 download URL, or null.
- **`downloadAudio(id)`** — GET `/file/download/{id}`. Returns raw opus audio as ArrayBuffer. Fallback when MP3 URL unavailable.

All requests include `Authorization: Bearer {token}` header.

## Plaud Recording Shape

```typescript
interface PlaudRecording {
  id: string
  filename: string
  fullname: string
  filesize: number
  duration: number       // milliseconds
  start_time: number     // epoch ms
  end_time: number       // epoch ms
  is_trash: boolean
  is_trans: boolean
  is_summary: boolean
  keywords: string[]
  serial_number: string
}
```

## Sync Engine

### Idempotent Sync

No sync state file. The filesystem is the source of truth.

1. Fetch all recordings from Plaud API
2. Sort by `start_time` ascending (oldest first)
3. For each recording:
   a. Generate filename: `{YYYY-MM-DD}_{sanitized_filename}`
   b. Skip if audio file already exists in `audio/` subfolder
   c. Download audio — try MP3 URL first, fall back to raw opus
   d. Save to `{outputFolder}/audio/{name}.{ext}`
   e. Skip transcription if transcript file already exists in `transcripts/` subfolder
   f. Convert audio to 16kHz mono WAV via ffmpeg
   g. Transcribe WAV with whisper.cpp → save to `{outputFolder}/transcripts/{name}.txt`
   h. Clean up temp WAV

Every run checks all recordings against what's on disk. Already-downloaded and already-transcribed files are skipped. No state to track or corrupt.

### File Naming

- Pattern: `{YYYY-MM-DD}_{slug}.{ext}`
- Slug: `filename.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 50)` — same as reference project
- Audio and transcript share the same base name

### Error Handling

- If a single recording fails (download or transcription), log the error and continue to the next
- Incomplete files (download interrupted) should be cleaned up before retrying

## Transcription

### whisper.cpp Wrapper

Thin subprocess wrapper around the `whisper-cpp` binary.

**Invocation:**
```bash
ffmpeg -i input.mp3 -ar 16000 -ac 1 -f wav temp.wav
whisper-cpp -m {modelPath} -f temp.wav -otxt -of {outputBasename}
```

Always convert to WAV first via ffmpeg — one code path, no branching.

Produces `{outputBasename}.txt` with plain text.

### Model Management

- Default model: `large-v3-turbo`
- Model path: standard Homebrew location or discovered via `which whisper-cpp` + relative path
- If model is missing, fail with clear instructions: `whisper-cpp-download-ggml-model large-v3-turbo`

### Prerequisites Check

Before syncing, verify:
1. `whisper-cpp` binary is on PATH
2. `ffmpeg` binary is on PATH
3. Model file exists
4. Credentials are configured and token is valid

Fail fast with clear error messages and install instructions.

## CLI Commands

```
plaud-sync login                          # Interactive credential setup
plaud-sync sync [folder]                  # Sync recordings (default: ~/PlaudSync)
plaud-sync install [--interval 30]        # Install launchd agent
plaud-sync uninstall                      # Remove launchd agent
```

### `login`

Interactive prompts for email, password, region. Validates by attempting auth. Saves to config.

### `sync`

Runs the sync engine. Accepts optional folder argument (defaults to `~/PlaudSync`).

### `install`

Generates and loads a LaunchAgent plist:
- Location: `~/Library/LaunchAgents/com.plaud-sync.agent.plist`
- Runs `plaud-sync sync` on a schedule
- Default interval: 30 minutes (configurable via `--interval`, in minutes)
- Stdout/stderr → `~/.plaud-sync/logs/`

### `uninstall`

Unloads and removes the LaunchAgent plist.

## Output Folder Structure

```
~/PlaudSync/
  audio/
    2026-03-25_meeting-with-team.mp3
    2026-03-26_voice-memo.opus
  transcripts/
    2026-03-25_meeting-with-team.txt
    2026-03-26_voice-memo.txt
```

## Future Considerations (not in scope)

- **Speaker diarization** — add as a post-transcription step using pyannote or similar
- **MCP server** — expose recordings to AI assistants
- **Desktop app** — menu bar or Electron/Tauri UI
- **SRT/VTT output** — timestamped subtitle formats
- **Markdown output** — frontmatter + embedded transcripts for Obsidian
