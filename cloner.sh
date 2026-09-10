#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "Usage: $0 <organization> <repo-file> <group> <parallel-jobs>" >&2
  echo "Use an empty group (\"\") when repositories have no group prefix." >&2
  exit 1
fi

ORG="$1"
REPO_FILE="$2"
GROUP="$3"
JOBS="$4"
BASE_DIR="$PWD"
export ORG GROUP

if ! [[ "$JOBS" =~ ^[1-9][0-9]*$ ]]; then
  echo "parallel-jobs must be a positive integer" >&2
  exit 1
fi

if [ ! -f "$REPO_FILE" ]; then
  echo "Repository file not found: $REPO_FILE" >&2
  exit 1
fi

mkdir -p "$BASE_DIR"
cd "$BASE_DIR"

# clones in parallel, strips CRLF safely
tr -d '\r' < "$REPO_FILE" | \
xargs -I{} -P "$JOBS" bash -lc '
  repo="$1"
  repo="$(echo "$repo" | xargs)"   # trim whitespace
  [ -z "$repo" ] && exit 0

  if [ -d "$repo/.git" ]; then
    echo "[SKIP] $repo already exists"
    exit 0
  fi

  # try both naming patterns; keep directory name as <repo>
  dot_repo="${GROUP:+$GROUP.}${repo}"
  hyphen_repo="${GROUP:+$GROUP-}${repo}"
  if git clone "git@github.com:${ORG}/${dot_repo}.git" "$repo" 2>/dev/null; then
    echo "[OK] git@github.com:${ORG}/${dot_repo}.git"
  elif git clone "git@github.com:${ORG}/${hyphen_repo}.git" "$repo"; then
    echo "[OK] git@github.com:${ORG}/${hyphen_repo}.git"
  else
    echo "[FAIL] $repo"
  fi
' _ {}
