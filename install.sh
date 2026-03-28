#!/bin/bash
set -e

INSTALL_DIR="/usr/local/bin"

# Check for bun
if ! command -v bun &> /dev/null; then
  echo "bun not found. Install with: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# Check for Homebrew
if ! command -v brew &> /dev/null; then
  echo "Homebrew not found. Install from: https://brew.sh"
  exit 1
fi

# Check for whisper-cli (provided by whisper-cpp package)
if ! command -v whisper-cli &> /dev/null; then
  echo "Installing whisper-cpp..."
  brew install whisper-cpp
fi

# Find model directory
MODEL_DIR=""
for dir in /opt/homebrew/share/whisper-cpp/models /usr/local/share/whisper-cpp/models; do
  if [ -d "$dir" ]; then
    MODEL_DIR="$dir"
    break
  fi
done

if [ -z "$MODEL_DIR" ]; then
  echo "whisper-cpp models directory not found."
  exit 1
fi

# Download model if missing
MODEL_FILE="$MODEL_DIR/ggml-large-v3-turbo.bin"
if [ ! -f "$MODEL_FILE" ]; then
  echo "Downloading whisper model (large-v3-turbo)..."
  curl -L --progress-bar \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" \
    -o "$MODEL_FILE"
fi

# Install dependencies
bun install

# Compile standalone binary
echo "Building plaud-sync..."
bun build bin/plaud-sync.ts --compile --outfile plaud-sync

# Install to /usr/local/bin
echo "Installing to $INSTALL_DIR/plaud-sync..."
sudo mv plaud-sync "$INSTALL_DIR/plaud-sync"
sudo chmod 755 "$INSTALL_DIR/plaud-sync"

echo ""
echo "Installed. Run 'plaud-sync login' to get started."
