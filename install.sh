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
  echo "whisperx requires a Hugging Face token for speaker diarization."
  echo "1. Get a token at: https://huggingface.co/settings/tokens"
  echo "2. Accept the pyannote model agreement at:"
  echo "   https://huggingface.co/pyannote/speaker-diarization-3.1"
  echo "3. Add to your shell profile:"
  echo "   export HF_TOKEN=hf_your_token_here"
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

echo ""
echo "Installed. Run 'plaud-sync login' to get started."
