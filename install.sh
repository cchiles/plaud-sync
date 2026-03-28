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

# Check for whisper-cpp
if ! command -v whisper-cpp &> /dev/null; then
  echo "Installing whisper-cpp..."
  brew install whisper-cpp
fi

# Check for model (ARM and Intel paths)
MODEL_FOUND=0
for MODEL_DIR in /opt/homebrew/share/whisper-cpp/models /usr/local/share/whisper-cpp/models; do
  if [ -f "$MODEL_DIR/ggml-large-v3-turbo.bin" ]; then
    MODEL_FOUND=1
    break
  fi
done

if [ "$MODEL_FOUND" -eq 0 ]; then
  echo "Downloading whisper model (large-v3-turbo)..."
  whisper-cpp-download-ggml-model large-v3-turbo
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
