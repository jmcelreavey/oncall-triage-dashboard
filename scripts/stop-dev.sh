#!/usr/bin/env bash
# Kill all dev processes and release database locks

echo "Stopping all dev servers..."
pkill -f "concurrently.*npm:dev" || true
pkill -f "tsx.*apps/api" || true
pkill -f "next dev" || true

sleep 2

# Check for any remaining processes on port 4000
if lsof -ti:4000 >/dev/null 2>&1; then
  echo "Killing process on port 4000..."
  lsof -ti:4000 | xargs kill -9 || true
fi

# Check for database locks
if lsof apps/api/dev.db >/dev/null 2>&1; then
  echo "Releasing database lock..."
  lsof -t apps/api/dev.db | xargs kill -9 || true
fi

sleep 1
echo "All dev processes stopped."
