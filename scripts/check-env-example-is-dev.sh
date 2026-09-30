#!/usr/bin/env bash
# Keep .env.example a dev template. It used to be a production file: an
# active HIGHFIVE_API_KEY placeholder, NODE_ENV=production, PORT=3001 and a
# production VITE_API_URL. Compose feeds `cp .env.example .env` into three
# services, so the placeholder became the admin password of every fresh dev
# box (#260). Fail if any of those variables is set on an uncommented line.
# Wired via `make check-env-example-is-dev`, the husky pre-push hook and the
# CI repo-guards job.

set -uo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root" || exit 1

file=".env.example"
forbidden='^[[:space:]]*(export[[:space:]]+)?(HIGHFIVE_API_KEY|NODE_ENV|PORT|VITE_API_URL)[[:space:]]*='

if hits="$(grep -nE "$forbidden" "$file")"; then
  echo "FAIL: $file sets production-only variables on active lines:" >&2
  echo "$hits" >&2
  echo "Leave them commented out: the dev stack runs on their defaults, and" >&2
  echo "production values belong in .env.production.example or the live host's .env." >&2
  exit 1
fi

echo "OK: $file sets no production-only variables"
