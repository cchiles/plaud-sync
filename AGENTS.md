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
plaud-sync status                         # Show config + launch agent state
plaud-sync doctor                         # Run prerequisite and health checks
plaud-sync config path                    # Show config file path
plaud-sync config show                    # Show non-secret config state
plaud-sync config set hf-token <token>    # Save Hugging Face token
```

## Paths

- **Binary:** `/usr/local/bin/plaud-sync`
- **Config:** `~/Library/Application Support/plaud-sync/config.json`
- **Legacy config (migrated automatically):** `~/.config/plaud-sync/config.json`
- **Logs:** `~/Library/Logs/plaud-sync/`
- **LaunchAgent:** `~/Library/LaunchAgents/com.plaud-sync.agent.plist`
- **Output:** `~/PlaudSync/` (default)

## Running Tests

```
bun test
```
