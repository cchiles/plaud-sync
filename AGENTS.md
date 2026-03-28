# Plaud Sync

A macOS CLI tool that syncs Plaud recordings and transcribes them locally using whisper.cpp.

## Tech Stack

- **Runtime:** Bun + TypeScript (compiled to standalone binary)
- **Validation:** zod
- **Testing:** bun:test
- **System deps:** whisper-cpp (Homebrew)

## Install

```
./install.sh
```

Compiles a standalone binary to `/usr/local/bin/plaud-sync`. No bun needed at runtime.

## Uninstall

```
./uninstall.sh
```

## Commands

```
plaud-sync login                          # Configure credentials
plaud-sync sync [folder]                  # Sync recordings (default: ~/PlaudSync)
plaud-sync install [--interval 30]        # Install launchd agent
plaud-sync uninstall                      # Remove launchd agent
```

## Paths

- **Binary:** `/usr/local/bin/plaud-sync`
- **Config:** `~/Library/Application Support/plaud-sync/config.json`
- **Logs:** `~/Library/Logs/plaud-sync/`
- **LaunchAgent:** `~/Library/LaunchAgents/com.plaud-sync.agent.plist`
- **Output:** `~/PlaudSync/` (default)

## Running Tests

```
bun test
```
