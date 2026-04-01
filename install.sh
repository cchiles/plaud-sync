#!/bin/bash
set -e

INSTALL_DIR="/usr/local/bin"

# Check for bun
if ! command -v bun &> /dev/null; then
  echo "bun not found. Install with: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# Check for uv
if ! command -v uv &> /dev/null; then
  echo "Installing uv..."
  brew install uv
fi

# Check for HF_TOKEN
if [ -z "$HF_TOKEN" ]; then
  echo ""
  echo "Speaker diarization requires a free Hugging Face token (read access)."
  echo ""
  echo "One-time setup:"
  echo "  1. Create an account at https://huggingface.co/join"
  echo "  2. Accept the user agreement for BOTH of these models:"
  echo "     https://huggingface.co/pyannote/speaker-diarization-3.1"
  echo "     https://huggingface.co/pyannote/segmentation-3.0"
  echo "  3. Create a read token at https://huggingface.co/settings/tokens"
  echo ""
  read -p "Enter your HF token (or press Enter to skip): " HF_INPUT
  if [ -n "$HF_INPUT" ]; then
    export HF_TOKEN="$HF_INPUT"
    # Detect shell and append to profile
    if [ -f "$HOME/.zshrc" ]; then
      echo "export HF_TOKEN=$HF_INPUT" >> "$HOME/.zshrc"
      echo "Added HF_TOKEN to ~/.zshrc"
    elif [ -f "$HOME/.bashrc" ]; then
      echo "export HF_TOKEN=$HF_INPUT" >> "$HOME/.bashrc"
      echo "Added HF_TOKEN to ~/.bashrc"
    fi
  else
    echo "Skipping. Diarization won't work until HF_TOKEN is set."
  fi
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

# Pre-download mlx-whisper model so first sync is fast
echo "Pre-downloading mlx-whisper model (large-v3-turbo)..."
uvx --python 3.12 --from mlx-whisper python -c "
from huggingface_hub import snapshot_download
snapshot_download('mlx-community/whisper-large-v3-turbo')
print('Model cached.')
"

echo ""
echo "Installed. Run 'plaud-sync login' to get started."
