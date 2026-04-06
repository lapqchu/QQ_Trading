#!/bin/bash
# Run this from inside the "QQ Trading" folder:
#   cd ~/Documents/Claude/Projects/"QQ Trading"
#   bash PUSH_TO_GITHUB.sh

set -e

# Clean up stale git state from earlier attempt
rm -rf .git

# Initialize fresh repo
git init
git branch -m main

# Stage everything (.gitignore excludes .env, .venv, node_modules, __pycache__, .DS_Store)
git add -A

# Verify .env is NOT staged
if git diff --cached --name-only | grep -q '\.env$'; then
  echo "ERROR: .env is staged! Aborting."
  exit 1
fi

echo "Files to be committed:"
git status --short

# Commit
git commit -m "Initial commit: TWD NDF trading dashboard

FX dashboard for TWD NDF swap points with LSEG market data integration.
Includes React/Vite frontend, Python/FastAPI backend, and standalone
JSX dashboard prototypes."

# Create GitHub repo and push
gh repo create QQ_Trading --public --source=. --remote=origin --push

echo ""
echo "Done! Your repo is at: https://github.com/$(gh api user -q .login)/QQ_Trading"
