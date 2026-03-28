#!/bin/bash
set -e

# Check for bun
if ! command -v bun &> /dev/null; then
  echo "bun not found. Install with: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# Check for whisper-cpp
if ! command -v whisper-cpp &> /dev/null; then
  echo "whisper-cpp not found. Installing via Homebrew..."
  brew install whisper-cpp
fi

# Check for model
MODEL_DIR="/opt/homebrew/share/whisper-cpp/models"
if [ ! -f "$MODEL_DIR/ggml-large-v3-turbo.bin" ]; then
  echo "Downloading whisper model (large-v3-turbo)..."
  whisper-cpp-download-ggml-model large-v3-turbo
fi

# Install dependencies and link binary
bun install
bun link

echo ""
echo "Installed. Run 'plaud-sync login' to get started."
