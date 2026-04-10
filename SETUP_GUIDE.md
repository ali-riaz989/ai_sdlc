# AI SDLC Platform - AWS Ubuntu Server Setup Guide

## Prerequisites

### Server Requirements

| Requirement | Minimum |
|-------------|---------|
| OS | Ubuntu 22.04+ LTS |
| RAM | 4 GB (8 GB recommended) |
| CPU | 2 vCPU (4 recommended) |
| Disk | 50 GB SSD |
| Instance type | t3.medium or larger |

### Accounts Needed

| Service | Purpose |
|---------|---------|
| [Anthropic](https://console.anthropic.com/) | Claude API key for AI code generation |
| GitHub | SSH key on server to clone Laravel projects |

### Software Stack

| Software | Version | Purpose |
|----------|---------|---------|
| Node.js | 20.x | Backend + Frontend runtime |
| PostgreSQL | 14+ | Platform database |
| Nginx | any | Reverse proxy |
| PHP | 8.1+ | Laravel project serving (`php artisan serve`) |
| Composer | 2.x | Laravel dependency management |
| Git | any | Repository cloning |
| pm2 | latest | Process management for Laravel projects |

---

## Step 1: Launch AWS EC2 Instance

1. Go to AWS Console > EC2 > Launch Instance
2. Select **Ubuntu 22.04 LTS** AMI
3. Choose **t3.medium** (or larger)
4. Configure security group:
   - SSH (22) - your IP
   - HTTP (80) - 0.0.0.0/0
   - HTTPS (443) - 0.0.0.0/0
5. Create/select a key pair
6. Launch and note the public IP

```bash
ssh -i your-key.pem ubuntu@YOUR_SERVER_IP
```

---

## Step 2: System Setup

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Create app user (or use ubuntu)
sudo adduser aiuser
sudo usermod -aG sudo aiuser
su - aiuser
```

---

## Step 3: Install Node.js 20.x via nvm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
nvm alias default 20

# Verify
node -v   # v20.x.x
npm -v    # 10.x.x
```

---

## Step 4: Install PostgreSQL

```bash
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql

# Verify
sudo -u postgres psql -c "SELECT version();"
```

---

## Step 5: Install PHP + Composer

```bash
sudo apt install -y php php-cli php-mbstring php-xml php-curl php-zip php-mysql php-pgsql php-gd php-bcmath unzip

# Install Composer
curl -sS https://getcomposer.org/installer | php
sudo mv composer.phar /usr/local/bin/composer

# Verify
php -v         # 8.x
composer -V    # 2.x
```

---

## Step 6: Install Nginx & Git

```bash
sudo apt install -y nginx git
sudo systemctl enable nginx
```

---

## Step 7: Install pm2 (for Laravel project serving)

```bash
npm install -g pm2
```

---

## Step 8: Setup SSH Key for GitHub

```bash
ssh-keygen -t ed25519 -C "your-email@example.com"
cat ~/.ssh/id_ed25519.pub
```

Add the public key to GitHub > Settings > SSH and GPG keys.

```bash
# Test connection
ssh -T git@github.com
```

---

## Step 9: Clone the AI SDLC Platform

```bash
cd /home/aiuser
git clone git@github.com:ali-riaz989/ai_sdlc.git
cd ai_sdlc
```

---

## Step 10: Setup PostgreSQL Database

```bash
sudo -u postgres psql <<SQL
CREATE USER ai_sdlc_user WITH PASSWORD 'CHANGE_THIS_TO_A_STRONG_PASSWORD';
CREATE DATABASE ai_sdlc_production OWNER ai_sdlc_user;
GRANT ALL PRIVILEGES ON DATABASE ai_sdlc_production TO ai_sdlc_user;
\c ai_sdlc_production
GRANT ALL ON SCHEMA public TO ai_sdlc_user;
SQL
```

Apply the schema:

```bash
PGPASSWORD="CHANGE_THIS_TO_A_STRONG_PASSWORD" psql -U ai_sdlc_user -h localhost -d ai_sdlc_production -f schema.sql
```

Create default admin user (password: `Admin@1234`):

```bash
PGPASSWORD="CHANGE_THIS_TO_A_STRONG_PASSWORD" psql -U ai_sdlc_user -h localhost -d ai_sdlc_production <<SQL
INSERT INTO users (email, password_hash, name, role)
SELECT 'admin@platform.local',
       '\$2a\$10\$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
       'Admin',
       'admin'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'admin@platform.local');
SQL
```

---

## Step 11: Configure Backend

```bash
cd /home/aiuser/ai_sdlc/backend
npm install
cp .env.example .env
nano .env
```

Edit `.env` with your values:

```env
NODE_ENV=production
PORT=3001
APP_URL=http://YOUR_SERVER_IP:3001
FRONTEND_URL=http://YOUR_SERVER_IP

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=ai_sdlc_production
DB_USER=ai_sdlc_user
DB_PASSWORD=CHANGE_THIS_TO_A_STRONG_PASSWORD

# Auth
JWT_SECRET=GENERATE_A_RANDOM_64_CHAR_STRING
JWT_EXPIRES_IN=7d

# Anthropic API
ANTHROPIC_API_KEY=sk-ant-api03-YOUR_KEY_HERE

# Paths (update to match your server)
PROJECT_BASE_PATH=/home/aiuser/ai_sdlc/projects

# MySQL root password (only needed if connecting MySQL Laravel projects)
# MYSQL_ROOT_PASSWORD=your_mysql_root_pass

# PostgreSQL superuser (for creating project databases)
POSTGRES_SUPERUSER=postgres
POSTGRES_SUPERUSER_PASSWORD=
```

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## Step 12: Configure & Build Frontend

```bash
cd /home/aiuser/ai_sdlc/frontend
npm install
```

Create `.env.local`:

```bash
cat > .env.local <<EOF
NEXT_PUBLIC_API_URL=http://YOUR_SERVER_IP
EOF
```

> **Note:** If using Nginx on the same server, set `NEXT_PUBLIC_API_URL=http://YOUR_SERVER_IP` (port 80, Nginx proxies to backend). If accessing directly, use `http://YOUR_SERVER_IP:3001`.

Build:

```bash
npx next build
```

---

## Step 13: Configure Nginx

```bash
sudo nano /etc/nginx/sites-available/ai-sdlc
```

Paste the following (update `server_name`):

```nginx
server {
    listen 80;
    server_name YOUR_SERVER_IP your-domain.com;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Frontend
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Backend API
    location /api {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # WebSocket
    location /socket.io {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }

    location /health {
        proxy_pass http://127.0.0.1:3001;
    }
}
```

Enable and test:

```bash
sudo ln -sf /etc/nginx/sites-available/ai-sdlc /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

---

## Step 14: Setup Systemd Services

Update the service files with your username and paths:

```bash
# Edit paths in service files
sed -i 's|ali-riaz|aiuser|g; s|/home/aiuser/Desktop/ai_sdlc|/home/aiuser/ai_sdlc|g' ai-sdlc-backend.service
sed -i 's|ali-riaz|aiuser|g; s|/home/aiuser/Desktop/ai_sdlc|/home/aiuser/ai_sdlc|g' ai-sdlc-frontend.service

# Also update the nvm node path to match your install
NODE_PATH=$(which node)
sed -i "s|/home/aiuser/.nvm/versions/node/v20.20.2/bin/node|${NODE_PATH}|g" ai-sdlc-backend.service
sed -i "s|/home/aiuser/.nvm/versions/node/v20.20.2/bin/node|${NODE_PATH}|g" ai-sdlc-frontend.service

# Copy and enable
sudo cp ai-sdlc-backend.service /etc/systemd/system/
sudo cp ai-sdlc-frontend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable ai-sdlc-backend ai-sdlc-frontend
```

---

## Step 15: Start the Platform

```bash
sudo systemctl start ai-sdlc-backend
sudo systemctl start ai-sdlc-frontend

# Check status
sudo systemctl status ai-sdlc-backend
sudo systemctl status ai-sdlc-frontend

# Check health
curl http://localhost:3001/health
```

---

## Step 16: Open & Login

Open in browser: `http://YOUR_SERVER_IP`

**Default login:**
- Email: `admin@platform.local`
- Password: `Admin@1234`

---

## Step 17: Connect Your First Laravel Project

1. Click **"+ Connect Repo"** on the dashboard
2. Enter the GitHub repo URL (SSH format: `git@github.com:org/repo.git`)
3. Select database type (PostgreSQL / MySQL)
4. Choose setup method:
   - **Run Migrations** - creates a new DB and runs `php artisan migrate`
   - **Upload SQL File** - creates a new DB and imports a `.sql` dump
   - **Use Existing DB** - paste your `.env` with existing DB credentials (skips DB creation)
5. Wait for setup to complete (live terminal shows progress)

---

## Firewall Setup

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

> Ports 3000, 3001, 8100-8999 should NOT be open externally. Nginx proxies frontend/backend, and Laravel projects are accessed through the iframe.

---

## SSL with Certbot (Optional but Recommended)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## Useful Commands

```bash
# View logs
sudo journalctl -u ai-sdlc-backend -f
sudo journalctl -u ai-sdlc-frontend -f

# Restart services
sudo systemctl restart ai-sdlc-backend
sudo systemctl restart ai-sdlc-frontend

# View running Laravel projects
pm2 list

# Rebuild frontend after code changes
cd /home/aiuser/ai_sdlc/frontend && npx next build
sudo systemctl restart ai-sdlc-frontend
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Backend won't start | Check `backend/.env` has correct DB credentials and ANTHROPIC_API_KEY |
| Frontend shows "Loading..." | Verify backend is running: `curl http://localhost:3001/health` |
| Can't clone repos | Check SSH key is added to GitHub: `ssh -T git@github.com` |
| Laravel project 500 error | Check `projects/<name>/storage/logs/laravel.log` |
| Port already in use | `fuser -k 3001/tcp` then restart the service |
| Database connection error | Verify PostgreSQL is running: `sudo systemctl status postgresql` |
