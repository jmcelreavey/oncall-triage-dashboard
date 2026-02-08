#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../apps/web"
echo "[dev] Starting Next.js dev server..."
exec npm run dev
