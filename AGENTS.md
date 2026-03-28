# Plaud Sync

A macOS CLI tool that syncs Plaud recordings and transcribes them locally using whisper.cpp.

## Tech Stack

- **Runtime:** Bun + TypeScript
- **Validation:** zod
- **Testing:** bun:test
- **System deps:** whisper-cpp (Homebrew)

## Install

```
bun install
bun link
```

## Commands

```
plaud-sync login                          # Configure credentials
plaud-sync sync [folder]                  # Sync recordings (default: ~/PlaudSync)
plaud-sync install [--interval 30]        # Install launchd agent
plaud-sync uninstall                      # Remove launchd agent
```

## Running Tests

```
bun test
```
