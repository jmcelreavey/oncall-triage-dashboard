#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  printf "[dev] %s\n" "$*"
}

NODE_REQUIRED_MAJOR=24

purge_prefix_env() {
  local name
  local upper
  while IFS='=' read -r name _; do
    upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
    case "$upper" in
      NPM_CONFIG_PREFIX|PREFIX)
        unset "$name"
      ;;
    esac
  done < <(env)
}

purge_prefix_env

if [[ -f "$HOME/.zshrc" ]]; then
  log "Syncing env from .zshrc via zsh"
  zsh -f -c "unset npm_config_prefix NPM_CONFIG_PREFIX PREFIX; source \"$HOME/.zshrc\"; cd \"$ROOT_DIR\" && node \"$ROOT_DIR/scripts/bootstrap-env.mjs\""
else
  node "$ROOT_DIR/scripts/bootstrap-env.mjs"
fi
node "$ROOT_DIR/scripts/build-skills-context.mjs" "$HOME/.config/oncall-triage-dashboard/skills_context.md" || true

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
ORIGINAL_NODE_MAJOR="$NODE_MAJOR"
if [[ "$NODE_MAJOR" -ne "$NODE_REQUIRED_MAJOR" ]]; then
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1090
    purge_prefix_env
    source "$HOME/.nvm/nvm.sh"
    purge_prefix_env
    nvm install "$NODE_REQUIRED_MAJOR"
    nvm use "$NODE_REQUIRED_MAJOR"
  elif command -v fnm >/dev/null 2>&1; then
    fnm install "$NODE_REQUIRED_MAJOR" || true
    fnm use "$NODE_REQUIRED_MAJOR" || true
  else
    log "Warning: Node $NODE_MAJOR detected and no nvm/fnm found. Prisma may fail."
  fi
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
log "Using Node $(node -v)"
if [[ "$NODE_MAJOR" -ne "$NODE_REQUIRED_MAJOR" ]]; then
  log "Warning: Node $NODE_MAJOR detected (expected $NODE_REQUIRED_MAJOR)."
fi

log "Ensuring Prisma database exists"
if command -v sqlite3 >/dev/null 2>&1; then
  ( cd "$ROOT_DIR/apps/api" && sqlite3 dev.db "VACUUM;" )
fi
( cd "$ROOT_DIR/apps/api" && npm run db:push ) || log "Prisma db push failed. Check Node version and Prisma." 

node "$ROOT_DIR/scripts/ensure-opencode-server.mjs" || true

# Stop any existing dev servers to prevent port conflicts and database locks
"$ROOT_DIR/scripts/stop-dev.sh" 2>/dev/null || true

cd "$ROOT_DIR"
log "Starting dev servers"
exec npx concurrently -n web,api -c blue,green "npm:dev:web" "npm:dev:api"
