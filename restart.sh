#!/bin/bash
# AI SDLC Platform - Pull latest code, install deps, build, restart everything.
#
# Usage:
#   bash restart.sh                   # full deploy: git pull + npm ci + build + restart
#   bash restart.sh --no-pull         # skip git pull (use working-tree as-is)
#   bash restart.sh --no-install      # skip npm ci (faster when no dep changes)
#   bash restart.sh --no-build        # skip frontend rebuild (only safe if .next is current)
#   bash restart.sh --quick           # = --no-pull --no-install --no-build (just restart procs)
#
# All flags can be combined. Default = full deploy, idempotent.

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
LOGS_DIR="$BASE_DIR/logs"

# Flag parsing
DO_PULL=1
DO_INSTALL=1
DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-pull)    DO_PULL=0 ;;
    --no-install) DO_INSTALL=0 ;;
    --no-build)   DO_BUILD=0 ;;
    --quick)      DO_PULL=0; DO_INSTALL=0; DO_BUILD=0 ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# Load nvm if available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

# Find node binary
NODE=$(which node 2>/dev/null)
if [ -z "$NODE" ]; then
  echo "ERROR: node not found. Install Node.js 20+ via nvm first."
  exit 1
fi
echo "Using node: $NODE ($(node -v))"

mkdir -p "$LOGS_DIR"

echo "=== AI SDLC Platform Restart ==="

# ── Step 1: Pull latest code ───────────────────────────────────────────────
# Idempotent — if local matches remote, nothing happens. Stops the deploy if
# the working tree has uncommitted changes that would be overwritten by pull,
# so we don't silently clobber server-side hotfixes.
if [ "$DO_PULL" = "1" ]; then
  echo "[1/6] Pulling latest code..."
  cd "$BASE_DIR"
  git pull --ff-only > "$LOGS_DIR/git-pull.log" 2>&1
  if [ $? -ne 0 ]; then
    echo "  git pull FAILED — see $LOGS_DIR/git-pull.log"
    echo "  (likely cause: local commits not on remote, OR uncommitted changes)"
    exit 1
  fi
else
  echo "[1/6] Skip git pull (--no-pull)"
fi

# ── Step 2: Stop existing processes ────────────────────────────────────────
echo "[2/6] Stopping existing processes..."
fuser -k -9 3000/tcp 2>/dev/null
fuser -k -9 3001/tcp 2>/dev/null
sleep 2

# ── Step 3: Install dependencies ───────────────────────────────────────────
# `npm ci` is the deploy-safe install: respects package-lock exactly, fails if
# lock and package.json disagree. Faster than `npm install`. Logs go to disk so
# build/runtime steps stay readable.
if [ "$DO_INSTALL" = "1" ]; then
  echo "[3/6] Installing dependencies..."
  cd "$BASE_DIR/backend"
  npm ci > "$LOGS_DIR/backend-install.log" 2>&1
  if [ $? -ne 0 ]; then
    echo "  Backend npm ci FAILED — see $LOGS_DIR/backend-install.log"
    exit 1
  fi
  cd "$BASE_DIR/frontend"
  npm ci > "$LOGS_DIR/frontend-install.log" 2>&1
  if [ $? -ne 0 ]; then
    echo "  Frontend npm ci FAILED — see $LOGS_DIR/frontend-install.log"
    exit 1
  fi
else
  echo "[3/6] Skip npm ci (--no-install)"
fi

# ── Step 4: Rebuild frontend ───────────────────────────────────────────────
# `next start` serves whatever's in .next/ — without a fresh build, stale code
# gets served forever, even after a full restart. NEXT_PUBLIC_* env vars are
# inlined HERE, so any change to .env requires this step.
if [ "$DO_BUILD" = "1" ]; then
  echo "[4/6] Building frontend..."
  cd "$BASE_DIR/frontend"
  rm -rf .next
  $NODE node_modules/.bin/next build > "$LOGS_DIR/frontend-build.log" 2>&1
  if [ $? -ne 0 ]; then
    echo "  Build FAILED — see $LOGS_DIR/frontend-build.log"
    exit 1
  fi
else
  echo "[4/6] Skip build (--no-build)"
fi

# ── Step 5: Start backend ──────────────────────────────────────────────────
echo "[5/6] Starting backend on :3001..."
cd "$BASE_DIR/backend"
nohup $NODE src/server.js > "$LOGS_DIR/backend.log" 2>&1 &
BACKEND_PID=$!

# ── Step 6: Start frontend ─────────────────────────────────────────────────
echo "[6/6] Starting frontend on :3000..."
cd "$BASE_DIR/frontend"
nohup $NODE node_modules/.bin/next start -p 3000 > "$LOGS_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!

# Wait and verify
sleep 4

BACKEND_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health)
FRONTEND_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000)

echo ""
if [ "$BACKEND_STATUS" = "200" ]; then
  echo "  Backend:  OK (pid $BACKEND_PID)"
else
  echo "  Backend:  FAILED (check $LOGS_DIR/backend.log)"
fi

if [ "$FRONTEND_STATUS" = "200" ]; then
  echo "  Frontend: OK (pid $FRONTEND_PID)"
else
  echo "  Frontend: FAILED (check $LOGS_DIR/frontend.log)"
fi

echo ""
echo "  Logs: tail -f $LOGS_DIR/backend.log"
echo "        tail -f $LOGS_DIR/frontend.log"
echo ""
