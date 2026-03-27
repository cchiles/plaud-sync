# Plaud Sync

A macOS CLI tool that syncs Plaud recordings and transcribes them locally using whisper.cpp.

## Tech Stack

- **Runtime:** Bun + TypeScript
- **CLI:** commander
- **Validation:** zod
- **Testing:** bun:test
- **System deps:** whisper.cpp, ffmpeg (Homebrew)

## Commands

```
bun bin/plaud-sync.ts login                          # Configure credentials
bun bin/plaud-sync.ts sync [folder]                  # Sync recordings (default: ~/PlaudSync)
bun bin/plaud-sync.ts install [--interval 30]        # Install launchd agent
bun bin/plaud-sync.ts uninstall                      # Remove launchd agent
```

## Running Tests

```
bun test
```
