#!/bin/bash
# AI SDLC Platform - One-time setup script
# Run: sudo bash setup.sh

set -e

BASE_DIR="/home/ali-riaz/Desktop/ai_sdlc"
DB_USER="ai_sdlc_user"
DB_PASS="ai_sdlc_pass_2024"
DB_NAME="ai_sdlc_production"

echo ""
echo "=== AI SDLC Platform Setup ==="
echo ""

# ── 1. PostgreSQL ──────────────────────────────────────────────────────────────
echo "[1/4] Setting up PostgreSQL..."

sudo -u postgres psql <<PSQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}') \gexec

GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
PSQL

# Apply schema
PGPASSWORD="${DB_PASS}" psql -U "${DB_USER}" -h localhost -d "${DB_NAME}" -f "${BASE_DIR}/schema.sql"

# Create default admin user (password: Admin@1234)
PGPASSWORD="${DB_PASS}" psql -U "${DB_USER}" -h localhost -d "${DB_NAME}" <<PSQL
INSERT INTO users (email, password_hash, name, role)
SELECT 'admin@platform.local',
       '\$2a\$10\$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
       'Admin',
       'admin'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'admin@platform.local');
PSQL

echo "  ✓ Database ready  (admin@platform.local / Admin@1234)"

# ── 2. Nginx ───────────────────────────────────────────────────────────────────
echo "[2/4] Configuring Nginx..."
cp "${BASE_DIR}/nginx.conf" /etc/nginx/sites-available/ai-sdlc
ln -sf /etc/nginx/sites-available/ai-sdlc /etc/nginx/sites-enabled/ai-sdlc
nginx -t && systemctl reload nginx
echo "  ✓ Nginx configured"

# ── 3. Systemd services ────────────────────────────────────────────────────────
echo "[3/4] Installing systemd services..."
cp "${BASE_DIR}/ai-sdlc-backend.service"  /etc/systemd/system/
cp "${BASE_DIR}/ai-sdlc-frontend.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable ai-sdlc-backend ai-sdlc-frontend
echo "  ✓ Services installed (not started yet)"

# ── 4. Build frontend ──────────────────────────────────────────────────────────
echo "[4/4] Building Next.js frontend..."
cd "${BASE_DIR}/frontend"
npm run build
echo "  ✓ Frontend built"

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Before starting services, add your Anthropic API key:"
echo "  nano ${BASE_DIR}/backend/.env"
echo "  → set ANTHROPIC_API_KEY=sk-ant-api03-..."
echo ""
echo "Then start the platform:"
echo "  sudo systemctl start ai-sdlc-backend ai-sdlc-frontend"
echo "  sudo systemctl status ai-sdlc-backend ai-sdlc-frontend"
echo ""
echo "Open: http://localhost"
echo "Login: admin@platform.local / Admin@1234"
