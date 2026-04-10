#!/bin/bash
# AI SDLC Platform - Start/Restart backend and frontend
# Usage: bash restart.sh

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
LOGS_DIR="$BASE_DIR/logs"

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

# Kill existing processes on ports 3000 and 3001
echo "[1/3] Stopping existing processes..."
fuser -k -9 3000/tcp 2>/dev/null
fuser -k -9 3001/tcp 2>/dev/null
sleep 2

# Start backend
echo "[2/3] Starting backend on :3001..."
cd "$BASE_DIR/backend"
nohup $NODE src/server.js > "$LOGS_DIR/backend.log" 2>&1 &
BACKEND_PID=$!

# Start frontend
echo "[3/3] Starting frontend on :3000..."
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
