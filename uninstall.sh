#!/bin/bash
set -e

BINARY="/usr/local/bin/plaud-sync"
PLIST="$HOME/Library/LaunchAgents/com.plaud-sync.agent.plist"
CONFIG_DIR="$HOME/Library/Application Support/plaud-sync"
LOG_DIR="$HOME/Library/Logs/plaud-sync"

# Unload LaunchAgent if present
if [ -f "$PLIST" ]; then
  echo "Unloading LaunchAgent..."
  launchctl unload "$PLIST" 2>/dev/null || true
  rm "$PLIST"
fi

# Remove binary
if [ -f "$BINARY" ]; then
  echo "Removing $BINARY..."
  sudo rm "$BINARY"
fi

# Ask about config
if [ -d "$CONFIG_DIR" ]; then
  read -p "Remove config and credentials ($CONFIG_DIR)? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf "$CONFIG_DIR"
    echo "Config removed."
  fi
fi

# Remove logs
if [ -d "$LOG_DIR" ]; then
  rm -rf "$LOG_DIR"
  echo "Logs removed."
fi

echo "Uninstalled."
