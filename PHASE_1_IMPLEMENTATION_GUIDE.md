# Phase 1 Implementation Guide: Edit Website + Auto-Deploy to Staging

## Overview

This document provides complete implementation instructions for Phase 1 of the AI-Driven SDLC system. Phase 1 enables non-technical users to edit website content through natural language prompts and automatically deploy changes to staging environments.

**Timeline:** 4 Weeks  
**Goal:** Non-tech users edit content → AI generates code → Instant preview → Auto-deploy to staging

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Prerequisites](#prerequisites)
3. [Week 1: Infrastructure Setup](#week-1-infrastructure-setup)
4. [Week 2: Core Backend Development](#week-2-core-backend-development)
5. [Week 3: Frontend Development](#week-3-frontend-development)
6. [Week 4: Staging Deployment & Testing](#week-4-staging-deployment--testing)
7. [GitHub Integration Guide](#github-integration-guide)
8. [Testing & Validation](#testing--validation)
9. [Deployment Checklist](#deployment-checklist)

---

## System Architecture

### High-Level Flow

```
┌─────────────┐
│   User      │
│ (Non-tech)  │
└──────┬──────┘
       │
       │ 1. Submits prompt: "Change homepage text"
       ↓
┌─────────────────────────────────────────────┐
│   AI SDLC Platform (Next.js + Node.js)      │
│                                             │
│  ┌────────────────────────────────────┐    │
│  │  Frontend (Next.js)                │    │
│  │  • Prompt Interface                │    │
│  │  • Preview Display                 │    │
│  │  • Status Tracking                 │    │
│  └────────────────────────────────────┘    │
│                  ↓                          │
│  ┌────────────────────────────────────┐    │
│  │  Backend API (Node.js/Express)     │    │
│  │  • Request Management              │    │
│  │  • AI Service Integration          │    │
│  │  • Preview Engine                  │    │
│  │  • Staging Orchestration           │    │
│  └────────────────────────────────────┘    │
│                  ↓                          │
│  ┌────────────────────────────────────┐    │
│  │  Database (PostgreSQL)             │    │
│  │  • Change requests                 │    │
│  │  • Generated code                  │    │
│  │  • Staging environments            │    │
│  │  • Audit logs                      │    │
│  └────────────────────────────────────┘    │
└────────────────────────────────────────────
       │
       │ 2. Clone Laravel project from GitHub
       ↓
┌─────────────────────────────────────────────┐
│   GitHub Repository                         │
│                                             │
│  Your Laravel Projects:                     │
│  • github.com/yourcompany/lgc              │
│  • github.com/yourcompany/admin            │
│  • github.com/yourcompany/api              │
│                                             │
│  Access: Read + Write (via SSH key/token)  │
└─────────────────────────────────────────────┘
       │
       
       │ 3. AI analyzes & generates code
       ↓
┌─────────────────────────────────────────────┐
│   Anthropic Claude API                      │
│   • Analyzes Laravel structure              │
│   • Generates code changes                  │
│   • Returns modified files                  │
└─────────────────────────────────────────────┘
       │
       │ 4. Create staging environment
       ↓
┌─────────────────────────────────────────────┐
│   Docker Staging Environment                │
│                                             │
│  Container: cr-abc123.staging.yoursite.com  │
│  • Full Laravel application                 │
│  • Database snapshot (masked)               │
│  • Applied code changes                     │
│  • Auto-cleanup after 7 days                │
└─────────────────────────────────────────────┘
       │
       │ 5. User views staging
       ↓
┌─────────────┐
│   User      │
│   Reviews   │
│   Staging   │
└─────────────┘
```

---

## Prerequisites

### Required Accounts & Access

1. **Anthropic Claude API**
   - Sign up: https://console.anthropic.com/
   - Create API key
   - Note: Phase 1 will cost ~$15-30/month for API usage

2. **GitHub Account**
   - Organization account (recommended)
   - Repositories for your Laravel projects
   - Admin access to create tokens/SSH keys

3. **Server/VPS**
   - Provider: DigitalOcean, AWS, Linode, etc.
   - Specs: 8GB RAM, 4 vCPU, 100GB SSD
   - OS: Ubuntu 22.04 LTS
   - Root/sudo access

4. **Domain**
   - Main domain for AI SDLC platform
   - Wildcard subdomain for staging (*.staging.yoursite.com)
   - DNS access

### Required Skills

- **Backend:** Node.js, Express, PostgreSQL
- **Frontend:** React, Next.js, Tailwind CSS
- **DevOps:** Docker, Linux, Nginx, Git
- **API:** REST APIs, WebSockets

---

## Week 1: Infrastructure Setup

### Day 1-2: Server Provisioning & Base Installation

#### Step 1.1: Provision Server

**DigitalOcean Example:**
```bash
# Create Droplet via web interface or API
# - Ubuntu 22.04 LTS
# - 8GB RAM / 4 vCPUs
# - 100GB SSD
# - Datacenter: Closest to your users

# Note the IP address: e.g., 192.168.1.100
```

#### Step 1.2: Initial Server Setup

```bash
# SSH into server
ssh root@192.168.1.100

# Update system
apt update && apt upgrade -y

# Create non-root user
adduser aiuser
usermod -aG sudo aiuser

# Setup SSH key authentication
mkdir -p /home/aiuser/.ssh
cp ~/.ssh/authorized_keys /home/aiuser/.ssh/
chown -R aiuser:aiuser /home/aiuser/.ssh
chmod 700 /home/aiuser/.ssh
chmod 600 /home/aiuser/.ssh/authorized_keys

# Disable root login
nano /etc/ssh/sshd_config
# Set: PermitRootLogin no
systemctl restart ssh

# Setup firewall
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# Exit and login as aiuser
exit
ssh aiuser@192.168.1.100
```

#### Step 1.3: Install Core Software

```bash
# Install Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version  # Should be v18.x
npm --version   # Should be 9.x or higher

# Install PostgreSQL 14
sudo apt install -y postgresql postgresql-contrib

# Start PostgreSQL
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Install Redis
sudo apt install -y redis-server

# Start Redis
sudo systemctl start redis-server
sudo systemctl enable redis-server

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add user to docker group
sudo usermod -aG docker aiuser

# Logout and login to apply group changes
exit
ssh aiuser@192.168.1.100

# Verify Docker
docker --version
docker ps  # Should work without sudo

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/download/v2.20.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
docker-compose --version

# Install Nginx
sudo apt install -y nginx

# Install Git
sudo apt install -y git

# Install build essentials
sudo apt install -y build-essential
```

### Day 2-3: Database & Directory Setup

#### Step 1.4: PostgreSQL Configuration

```bash
# Switch to postgres user
sudo -u postgres psql

# Inside PostgreSQL prompt:
CREATE DATABASE ai_sdlc_production;
CREATE USER ai_sdlc_user WITH PASSWORD 'your_secure_password_here';
GRANT ALL PRIVILEGES ON DATABASE ai_sdlc_production TO ai_sdlc_user;

# Grant schema permissions
\c ai_sdlc_production
GRANT ALL ON SCHEMA public TO ai_sdlc_user;

# Exit PostgreSQL
\q
```

**Database Schema Creation:**

Save this as `schema.sql`:

```sql
-- Projects table
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    display_name VARCHAR(200) NOT NULL,
    repo_url VARCHAR(500) NOT NULL,
    repo_branch VARCHAR(100) DEFAULT 'main',
    local_path VARCHAR(500) NOT NULL,
    production_url VARCHAR(500),
    db_host VARCHAR(200),
    db_port INTEGER DEFAULT 3306,
    db_name VARCHAR(100),
    db_user VARCHAR(100),
    status VARCHAR(50) DEFAULT 'active',
    last_synced_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Change requests table
CREATE TABLE change_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_number SERIAL UNIQUE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    title VARCHAR(255) NOT NULL,
    prompt TEXT NOT NULL,
    category VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    priority VARCHAR(20) DEFAULT 'medium',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- AI analysis results
CREATE TABLE ai_analysis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_request_id UUID REFERENCES change_requests(id) ON DELETE CASCADE,
    model_used VARCHAR(50),
    analysis_result JSONB,
    complexity_score INTEGER,
    estimated_files_affected INTEGER,
    risk_assessment VARCHAR(50),
    recommendations TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Generated code
CREATE TABLE generated_code (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_request_id UUID REFERENCES change_requests(id) ON DELETE CASCADE,
    file_path VARCHAR(500) NOT NULL,
    original_content TEXT,
    generated_content TEXT NOT NULL,
    diff TEXT,
    change_type VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Instant previews (Phase 1 specific)
CREATE TABLE instant_previews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_request_id UUID REFERENCES change_requests(id) ON DELETE CASCADE,
    preview_html TEXT,
    preview_css TEXT,
    preview_js TEXT,
    preview_url VARCHAR(500),
    expires_at TIMESTAMP,
    viewed_count INTEGER DEFAULT 0,
    approved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Staging environments
CREATE TABLE staging_environments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_request_id UUID REFERENCES change_requests(id) ON DELETE CASCADE,
    container_id VARCHAR(100),
    container_name VARCHAR(100),
    url VARCHAR(500),
    database_snapshot_id VARCHAR(100),
    status VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    last_accessed_at TIMESTAMP
);

-- Audit logs
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_request_id UUID REFERENCES change_requests(id) ON DELETE SET NULL,
    user_id INTEGER,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    old_value JSONB,
    new_value JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Users table (simple auth for Phase 1)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(200) NOT NULL,
    role VARCHAR(50) DEFAULT 'user',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_change_requests_status ON change_requests(status);
CREATE INDEX idx_change_requests_project ON change_requests(project_id);
CREATE INDEX idx_change_requests_user ON change_requests(user_id);
CREATE INDEX idx_staging_envs_request ON staging_environments(change_request_id);
CREATE INDEX idx_audit_logs_request ON audit_logs(change_request_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(created_at);
CREATE INDEX idx_users_email ON users(email);
```

**Apply the schema:**

```bash
# Save schema.sql to server, then:
psql -U ai_sdlc_user -d ai_sdlc_production -f schema.sql
```

#### Step 1.5: Directory Structure Setup

```bash
# Create main application directory
sudo mkdir -p /opt/ai-sdlc
sudo chown -R aiuser:aiuser /opt/ai-sdlc

# Create subdirectories
cd /opt/ai-sdlc
mkdir -p projects          # Permanent Laravel project clones
mkdir -p staging           # Temporary staging environments
mkdir -p staging/snapshots # Database snapshots
mkdir -p logs              # Application logs
mkdir -p backups           # Database backups

# Set permissions
chmod 755 projects
chmod 755 staging
chmod 755 logs
chmod 700 backups
```

### Day 3-4: GitHub Integration Setup

#### Step 1.6: GitHub SSH Key Setup

This is how the AI SDLC platform will access your Laravel repositories.

```bash
# Generate SSH key for GitHub access
ssh-keygen -t ed25519 -C "ai-sdlc@yourcompany.com" -f ~/.ssh/github_ai_sdlc

# Display public key
cat ~/.ssh/github_ai_sdlc.pub

# Copy this key to GitHub:
# 1. Go to GitHub.com
# 2. Settings → SSH and GPG keys
# 3. Click "New SSH key"
# 4. Paste the public key
# 5. Give it a title: "AI SDLC Platform"
```

**Configure SSH for GitHub:**

```bash
# Create SSH config
nano ~/.ssh/config

# Add this configuration:
Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/github_ai_sdlc
    IdentitiesOnly yes

# Set permissions
chmod 600 ~/.ssh/config
chmod 600 ~/.ssh/github_ai_sdlc
chmod 644 ~/.ssh/github_ai_sdlc.pub

# Test connection
ssh -T git@github.com
# Should see: "Hi username! You've successfully authenticated..."
```

#### Step 1.7: GitHub Personal Access Token (Alternative/Additional)

For using GitHub API (creating branches, PRs, etc.):

```bash
# Go to GitHub:
# Settings → Developer settings → Personal access tokens → Tokens (classic)
# Click "Generate new token (classic)"

# Select scopes:
☑ repo (Full control of private repositories)
  ☑ repo:status
  ☑ repo_deployment
  ☑ public_repo
  ☑ repo:invite
  ☑ security_events
☑ workflow
☑ write:packages
☑ read:packages

# Generate token and save it securely
# Example: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

#### Step 1.8: Clone Laravel Projects

```bash
cd /opt/ai-sdlc/projects

# Clone your Laravel projects
# Replace with your actual repository URLs

# Project 1: LGC
git clone git@github.com:yourcompany/lgc.git
cd lgc
git config user.name "AI SDLC Bot"
git config user.email "ai-sdlc@yourcompany.com"
cd ..

# Project 2: Admin Dashboard
git clone git@github.com:yourcompany/admin-dashboard.git
cd admin-dashboard
git config user.name "AI SDLC Bot"
git config user.email "ai-sdlc@yourcompany.com"
cd ..

# Project 3: API Service
git clone git@github.com:yourcompany/api-service.git
cd api-service
git config user.name "AI SDLC Bot"
git config user.email "ai-sdlc@yourcompany.com"
cd ..

# Verify clones
ls -la
# Should see: lgc/ admin-dashboard/ api-service/
```

#### Step 1.9: Insert Projects into Database

```bash
# Connect to PostgreSQL
psql -U ai_sdlc_user -d ai_sdlc_production

# Insert your projects
INSERT INTO projects (name, display_name, repo_url, local_path, production_url) VALUES
('lgc', 'LGC Website', 'git@github.com:yourcompany/lgc.git', '/opt/ai-sdlc/projects/lgc', 'https://lgc.yoursite.com'),
('admin', 'Admin Dashboard', 'git@github.com:yourcompany/admin-dashboard.git', '/opt/ai-sdlc/projects/admin-dashboard', 'https://admin.yoursite.com'),
('api', 'API Service', 'git@github.com:yourcompany/api-service.git', '/opt/ai-sdlc/projects/api-service', 'https://api.yoursite.com');

# Verify
SELECT name, display_name, production_url FROM projects;

# Exit
\q
```

### Day 4-5: Domain & SSL Setup

#### Step 1.10: DNS Configuration

```
Add these DNS records:

A Record:
  Host: platform
  Value: 192.168.1.100 (your server IP)
  TTL: 300

A Record:
  Host: *.staging
  Value: 192.168.1.100
  TTL: 300

Result:
- platform.yoursite.com → AI SDLC interface
- cr-abc123.staging.yoursite.com → Staging environments
```

#### Step 1.11: Nginx Configuration

```bash
# Create Nginx config for AI SDLC platform
sudo nano /etc/nginx/sites-available/ai-sdlc

# Add this configuration:
```

```nginx
# AI SDLC Platform - Main Application
server {
    listen 80;
    server_name platform.yoursite.com;
    
    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name platform.yoursite.com;
    
    # SSL certificates (will be generated next)
    ssl_certificate /etc/letsencrypt/live/platform.yoursite.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/platform.yoursite.com/privkey.pem;
    
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;
    
    # Frontend (Next.js)
    location / {
        proxy_pass http://localhost:3000;
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
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    
    # WebSocket for real-time updates
    location /socket.io {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

# Staging Environments - Wildcard subdomain
server {
    listen 80;
    server_name ~^(?<subdomain>.+)\.staging\.yoursite\.com$;
    
    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ~^(?<subdomain>.+)\.staging\.yoursite\.com$;
    
    # Wildcard SSL certificate
    ssl_certificate /etc/letsencrypt/live/staging.yoursite.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/staging.yoursite.com/privkey.pem;
    
    # Proxy to Docker container
    # Container port will be dynamically mapped
    location / {
        # This will be updated dynamically by the staging service
        # For now, return 503 if container not found
        return 503;
    }
}
```

```bash
# Enable the site
sudo ln -s /etc/nginx/sites-available/ai-sdlc /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Don't reload yet (SSL certs not created)
```

#### Step 1.12: SSL Certificate Setup

```bash
# Install Certbot
sudo apt install -y certbot python3-certbot-nginx

# Get certificate for main platform
sudo certbot certonly --nginx -d platform.yoursite.com

# Get wildcard certificate for staging
sudo certbot certonly --manual --preferred-challenges dns -d staging.yoursite.com -d '*.staging.yoursite.com'

# Follow prompts to add DNS TXT records
# The certbot will ask you to add:
# _acme-challenge.staging.yoursite.com TXT "random-string"

# After DNS records are set (wait 5 minutes for propagation), press Enter

# Setup auto-renewal
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer

# Reload Nginx
sudo systemctl reload nginx
```

---

## Week 2: Core Backend Development

### Day 6-7: Backend Project Setup

#### Step 2.1: Initialize Backend Project

```bash
cd /opt/ai-sdlc
mkdir backend
cd backend

# Initialize Node.js project
npm init -y

# Update package.json
nano package.json
```

**package.json:**

```json
{
  "name": "ai-sdlc-backend",
  "version": "1.0.0",
  "description": "AI-driven SDLC backend orchestration",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js",
    "test": "jest"
  },
  "keywords": ["ai", "sdlc", "laravel"],
  "author": "Your Company",
  "license": "MIT"
}
```

#### Step 2.2: Install Dependencies

```bash
# Core dependencies
npm install express cors dotenv

# Database
npm install pg sequelize

# Authentication & Security
npm install jsonwebtoken bcryptjs helmet express-rate-limit

# AI Integration
npm install @anthropic-ai/sdk

# Git Operations
npm install simple-git @octokit/rest

# Docker
npm install dockerode

# Utilities
npm install uuid winston morgan

# WebSocket
npm install socket.io

# Development dependencies
npm install --save-dev nodemon jest supertest
```

#### Step 2.3: Project Structure

```bash
# Create directory structure
mkdir -p src/{config,controllers,middleware,models,routes,services,utils}

# Create files
touch src/server.js
touch src/config/{database.js,auth.js}
touch src/middleware/{auth.js,errorHandler.js,validation.js}
touch src/utils/{logger.js,auditLogger.js}
touch .env
touch .env.example
```

#### Step 2.4: Environment Configuration

**Create .env file:**

```bash
nano .env
```

```env
# Application
NODE_ENV=production
PORT=3001
APP_URL=https://platform.yoursite.com

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=ai_sdlc_production
DB_USER=ai_sdlc_user
DB_PASSWORD=your_secure_password_here

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Authentication
JWT_SECRET=your_jwt_secret_generate_strong_random_string
JWT_EXPIRES_IN=7d

# Anthropic Claude API
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx

# GitHub Integration
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GITHUB_REPO_OWNER=yourcompany

# Projects Configuration
PROJECT_BASE_PATH=/opt/ai-sdlc/projects

# Staging Configuration
STAGING_BASE_PATH=/opt/ai-sdlc/staging
STAGING_DOMAIN=staging.yoursite.com
STAGING_CLEANUP_DAYS=7

# Docker Configuration
DOCKER_NETWORK=ai-sdlc-network

# Logging
LOG_LEVEL=info
```

**Create .env.example (for developers):**

```bash
cp .env .env.example
# Edit .env.example to remove sensitive values
nano .env.example
# Replace actual values with placeholders
```

### Day 7-8: Core Backend Services

#### Step 2.5: Database Configuration

**src/config/database.js:**

```javascript
const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'postgres',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000
    }
  }
);

// Test connection
async function testConnection() {
  try {
    await sequelize.authenticate();
    console.log('✓ Database connection established successfully');
  } catch (error) {
    console.error('✗ Unable to connect to database:', error);
    process.exit(1);
  }
}

module.exports = { sequelize, testConnection };
```

#### Step 2.6: Logger Utility

**src/utils/logger.js:**

```javascript
const winston = require('winston');
const path = require('path');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    // Error logs
    new winston.transports.File({ 
      filename: path.join(__dirname, '../../logs/error.log'), 
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5
    }),
    // Combined logs
    new winston.transports.File({ 
      filename: path.join(__dirname, '../../logs/combined.log'),
      maxsize: 10485760, // 10MB
      maxFiles: 5
    })
  ]
});

// Console logging in development
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

module.exports = logger;
```

#### Step 2.7: Audit Logger

**src/utils/auditLogger.js:**

```javascript
const { sequelize } = require('../config/database');
const logger = require('./logger');

/**
 * Log actions to audit trail
 */
async function log(data) {
  try {
    const {
      change_request_id = null,
      user_id = null,
      action,
      entity_type = null,
      entity_id = null,
      old_value = null,
      new_value = null,
      ip_address = null,
      user_agent = null
    } = data;

    await sequelize.query(
      `INSERT INTO audit_logs 
       (change_request_id, user_id, action, entity_type, entity_id, 
        old_value, new_value, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      {
        bind: [
          change_request_id,
          user_id,
          action,
          entity_type,
          entity_id,
          old_value ? JSON.stringify(old_value) : null,
          new_value ? JSON.stringify(new_value) : null,
          ip_address,
          user_agent
        ]
      }
    );

    logger.info('Audit log created', { action, user_id });
  } catch (error) {
    logger.error('Failed to create audit log', { error: error.message, data });
  }
}

module.exports = { log };
```

#### Step 2.8: Authentication Middleware

**src/middleware/auth.js:**

```javascript
const jwt = require('jsonwebtoken');

/**
 * Verify JWT token and attach user to request
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    req.user = user;
    req.ip_address = req.ip;
    req.user_agent = req.get('user-agent');
    next();
  });
}

/**
 * Check if user has required role
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
}

module.exports = { authenticateToken, requireRole };
```

#### Step 2.9: Error Handler Middleware

**src/middleware/errorHandler.js:**

```javascript
const logger = require('../utils/logger');

/**
 * Global error handler
 */
function errorHandler(err, req, res, next) {
  logger.error('Error occurred', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    user: req.user?.id
  });

  // Default error
  let statusCode = 500;
  let message = 'Internal server error';

  // Handle specific error types
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = err.message;
  } else if (err.name === 'UnauthorizedError') {
    statusCode = 401;
    message = 'Unauthorized';
  } else if (err.statusCode) {
    statusCode = err.statusCode;
    message = err.message;
  }

  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
}

module.exports = errorHandler;
```

### Day 8-9: AI Service Integration

#### Step 2.10: AI Service

**src/services/aiService.js:**

```javascript
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');

class AIService {
  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    this.model = 'claude-sonnet-4-20250514';
  }

  /**
   * Analyze change request and create implementation plan
   */
  async analyzeChangeRequest(prompt, projectContext, category) {
    logger.info('Starting AI analysis', { category });

    const systemPrompt = this._buildAnalysisSystemPrompt(projectContext);

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4000,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: `Analyze this ${category} change request for a Laravel application:

${prompt}

Respond with a JSON object containing:
{
  "understanding": "Brief summary of what needs to be done",
  "complexity": 1-10 scale,
  "risk_level": "low" | "medium" | "high",
  "change_type": "content" | "styling" | "template" | "feature",
  "files_affected": ["path/to/file1.php", "path/to/file2.blade.php"],
  "implementation_plan": [
    {
      "step": 1,
      "description": "What to do",
      "file_path": "path/to/file.php",
      "change_type": "modify",
      "details": "Specific changes needed"
    }
  ],
  "can_instant_preview": true/false,
  "requires_staging": true/false,
  "estimated_time_minutes": 5
}`
        }]
      });

      const analysisText = response.content[0].text;
      const analysis = this._extractJSON(analysisText);

      logger.info('AI analysis completed', { 
        complexity: analysis.complexity,
        risk: analysis.risk_level 
      });

      return analysis;
    } catch (error) {
      logger.error('AI analysis failed', { error: error.message });
      throw new Error(`AI analysis failed: ${error.message}`);
    }
  }

  /**
   * Generate code for a specific file change
   */
  async generateCode(fileInfo, projectContext, originalContent = null) {
    logger.info('Generating code', { file: fileInfo.file_path });

    const systemPrompt = `You are an expert Laravel developer. Generate clean, secure, production-ready code.

CRITICAL RULES:
- Follow PSR-12 coding standards
- Use Laravel best practices
- Include proper validation
- Never use eval(), exec(), system()
- Always use parameterized queries
- Escape output in views

Generate ONLY the code, no explanations.`;

    try {
      let userPrompt = `File: ${fileInfo.file_path}
Change type: ${fileInfo.change_type}
Description: ${fileInfo.description}
Details: ${fileInfo.details}
`;

      if (originalContent) {
        userPrompt += `\nCurrent content:\n\`\`\`php\n${originalContent}\n\`\`\`\n`;
        userPrompt += `\nModify this file according to the requirements.`;
      } else {
        userPrompt += `\nCreate this new file.`;
      }

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 8000,
        temperature: 0.1,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });

      const code = this._extractCode(response.content[0].text);

      logger.info('Code generated successfully', { 
        file: fileInfo.file_path,
        length: code.length 
      });

      return code;
    } catch (error) {
      logger.error('Code generation failed', { 
        file: fileInfo.file_path,
        error: error.message 
      });
      throw new Error(`Code generation failed: ${error.message}`);
    }
  }

  /**
   * Build system prompt for analysis based on Laravel context
   */
  _buildAnalysisSystemPrompt(projectContext) {
    return `You are an expert Laravel developer analyzing change requests.

Laravel Project Context:
${JSON.stringify(projectContext, null, 2)}

Analyze the request and determine:
1. What files need to be changed
2. Complexity (1-10 scale)
3. Risk level (low/medium/high)
4. Whether instant preview is possible (for simple content/CSS changes)
5. Whether full staging is required (for logic/database changes)

For Phase 1, focus on:
- Content changes (text, copy)
- CSS/styling modifications
- Blade template edits
- Simple view updates

Respond ONLY with valid JSON.`;
  }

  /**
   * Extract JSON from AI response
   */
  _extractJSON(text) {
    // Remove markdown code blocks if present
    let cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    
    // Find JSON object
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('No JSON found in AI response');
    }

    try {
      return JSON.parse(match[0]);
    } catch (error) {
      throw new Error(`Invalid JSON in AI response: ${error.message}`);
    }
  }

  /**
   * Extract code from AI response
   */
  _extractCode(text) {
    // Remove markdown code blocks
    let code = text.replace(/```php\n?/g, '').replace(/```\n?/g, '');
    return code.trim();
  }
}

module.exports = new AIService();
```

### Day 9-10: Laravel Context Analyzer

#### Step 2.11: Laravel Analyzer Service

**src/services/laravelAnalyzer.js:**

```javascript
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

class LaravelAnalyzer {
  /**
   * Analyze Laravel project structure
   */
  async analyzeProject(projectPath) {
    logger.info('Analyzing Laravel project', { projectPath });

    try {
      const analysis = {
        routes: await this._analyzeRoutes(projectPath),
        controllers: await this._analyzeControllers(projectPath),
        models: await this._analyzeModels(projectPath),
        views: await this._analyzeViews(projectPath),
        config: await this._analyzeConfig(projectPath)
      };

      logger.info('Laravel analysis complete', {
        routes: analysis.routes.length,
        controllers: analysis.controllers.length,
        models: analysis.models.length,
        views: analysis.views.length
      });

      return analysis;
    } catch (error) {
      logger.error('Laravel analysis failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Analyze route files
   */
  async _analyzeRoutes(projectPath) {
    const routes = [];
    const routesPath = path.join(projectPath, 'routes');

    try {
      const files = await fs.readdir(routesPath);
      
      for (const file of files) {
        if (file.endsWith('.php')) {
          const filePath = path.join(routesPath, file);
          const content = await fs.readFile(filePath, 'utf-8');
          
          routes.push({
            file: file,
            path: filePath,
            content_preview: content.substring(0, 500)
          });
        }
      }
    } catch (error) {
      logger.warn('Could not analyze routes', { error: error.message });
    }

    return routes;
  }

  /**
   * Analyze controllers
   */
  async _analyzeControllers(projectPath) {
    const controllers = [];
    const controllersPath = path.join(projectPath, 'app/Http/Controllers');

    try {
      const files = await this._getPhpFilesRecursive(controllersPath);
      
      for (const file of files) {
        controllers.push({
          name: path.basename(file, '.php'),
          path: file,
          relative_path: path.relative(projectPath, file)
        });
      }
    } catch (error) {
      logger.warn('Could not analyze controllers', { error: error.message });
    }

    return controllers;
  }

  /**
   * Analyze models
   */
  async _analyzeModels(projectPath) {
    const models = [];
    const modelsPath = path.join(projectPath, 'app/Models');

    try {
      const files = await this._getPhpFilesRecursive(modelsPath);
      
      for (const file of files) {
        models.push({
          name: path.basename(file, '.php'),
          path: file,
          relative_path: path.relative(projectPath, file)
        });
      }
    } catch (error) {
      logger.warn('Could not analyze models', { error: error.message });
    }

    return models;
  }

  /**
   * Analyze views
   */
  async _analyzeViews(projectPath) {
    const views = [];
    const viewsPath = path.join(projectPath, 'resources/views');

    try {
      const files = await this._getBladeFilesRecursive(viewsPath);
      
      for (const file of files) {
        views.push({
          name: path.basename(file),
          path: file,
          relative_path: path.relative(projectPath, file)
        });
      }
    } catch (error) {
      logger.warn('Could not analyze views', { error: error.message });
    }

    return views;
  }

  /**
   * Analyze config files
   */
  async _analyzeConfig(projectPath) {
    const config = {};
    const configPath = path.join(projectPath, 'config');

    try {
      const files = await fs.readdir(configPath);
      
      for (const file of files) {
        if (file.endsWith('.php')) {
          config[file] = path.join(configPath, file);
        }
      }
    } catch (error) {
      logger.warn('Could not analyze config', { error: error.message });
    }

    return config;
  }

  /**
   * Get all PHP files recursively
   */
  async _getPhpFilesRecursive(dir) {
    const files = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          files.push(...await this._getPhpFilesRecursive(fullPath));
        } else if (entry.name.endsWith('.php')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Directory might not exist, that's okay
    }

    return files;
  }

  /**
   * Get all Blade files recursively
   */
  async _getBladeFilesRecursive(dir) {
    const files = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          files.push(...await this._getBladeFilesRecursive(fullPath));
        } else if (entry.name.endsWith('.blade.php')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Directory might not exist
    }

    return files;
  }
}

module.exports = new LaravelAnalyzer();
```

---

## Week 3: Frontend Development

### Day 11-12: Frontend Setup

#### Step 3.1: Initialize Frontend Project

```bash
cd /opt/ai-sdlc
npx create-next-app@latest frontend

# During setup, choose:
# ✓ TypeScript? No
# ✓ ESLint? Yes
# ✓ Tailwind CSS? Yes
# ✓ src/ directory? Yes
# ✓ App Router? Yes
# ✓ Import alias? No

cd frontend
```

#### Step 3.2: Install Additional Dependencies

```bash
# State management & data fetching
npm install @tanstack/react-query axios zustand

# UI components
npm install @headlessui/react lucide-react

# Forms
npm install react-hook-form

# Real-time
npm install socket.io-client

# Utilities
npm install clsx date-fns
```

#### Step 3.3: Environment Configuration

**Create .env.local:**

```bash
nano .env.local
```

```env
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_WS_URL=http://localhost:3001
NEXT_PUBLIC_STAGING_DOMAIN=staging.yoursite.com
```

#### Step 3.4: Project Structure

```bash
cd src
mkdir -p {components,lib,hooks,contexts}
mkdir -p components/{ui,features}
mkdir -p components/features/{prompt,preview,dashboard}

# Create files
touch lib/api.js
touch lib/socket.js
touch contexts/AuthContext.jsx
```

### Day 12-14: Core Frontend Components

#### Step 3.5: API Client

**src/lib/api.js:**

```javascript
import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Create axios instance
const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Request interceptor - add auth token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor - handle errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// API methods
export const apiClient = {
  // Auth
  login: (email, password) => 
    api.post('/api/auth/login', { email, password }),
  
  register: (name, email, password) => 
    api.post('/api/auth/register', { name, email, password }),

  // Projects
  getProjects: () => 
    api.get('/api/projects'),

  // Change Requests
  createChangeRequest: (data) => 
    api.post('/api/change-requests', data),
  
  getChangeRequest: (id) => 
    api.get(`/api/change-requests/${id}`),
  
  listChangeRequests: (filters = {}) => 
    api.get('/api/change-requests', { params: filters }),

  // Preview
  getInstantPreview: (id) => 
    api.get(`/api/change-requests/${id}/preview`),

  // Staging
  getStagingEnvironment: (id) => 
    api.get(`/api/change-requests/${id}/staging`)
};

export default api;
```

#### Step 3.6: WebSocket Client

**src/lib/socket.js:**

```javascript
import { io } from 'socket.io-client';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001';

class SocketClient {
  constructor() {
    this.socket = null;
    this.listeners = new Map();
  }

  connect(token) {
    if (this.socket?.connected) {
      return this.socket;
    }

    this.socket = io(WS_URL, {
      auth: { token },
      transports: ['websocket', 'polling']
    });

    this.socket.on('connect', () => {
      console.log('WebSocket connected');
    });

    this.socket.on('disconnect', () => {
      console.log('WebSocket disconnected');
    });

    return this.socket;
  }

  subscribeToChangeRequest(requestId, callback) {
    if (!this.socket) return;

    const event = `change-request:${requestId}`;
    this.socket.on(event, callback);
    this.listeners.set(event, callback);
  }

  unsubscribeFromChangeRequest(requestId) {
    if (!this.socket) return;

    const event = `change-request:${requestId}`;
    const callback = this.listeners.get(event);
    
    if (callback) {
      this.socket.off(event, callback);
      this.listeners.delete(event);
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.listeners.clear();
    }
  }
}

export default new SocketClient();
```

#### Step 3.7: Main Application Layout

**src/app/page.jsx:**

```javascript
'use client';

import { useState, useEffect } from 'react';
import { apiClient } from '@/lib/api';
import PromptInterface from '@/components/features/prompt/PromptInterface';
import RecentRequests from '@/components/features/dashboard/RecentRequests';

export default function Home() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    try {
      const response = await apiClient.getProjects();
      setProjects(response.data);
    } catch (error) {
      console.error('Failed to load projects:', error);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center min-h-screen">
      <div className="text-lg">Loading...</div>
    </div>;
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">
            AI-Driven SDLC Platform
          </h1>
          <p className="text-gray-600 mt-2">
            Edit your Laravel projects through natural language
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <PromptInterface projects={projects} />
          </div>
          <div>
            <RecentRequests />
          </div>
        </div>
      </div>
    </main>
  );
}
```

#### Step 3.8: Prompt Interface Component

**src/components/features/prompt/PromptInterface.jsx:**

```javascript
'use client';

import { useState } from 'react';
import { apiClient } from '@/lib/api';
import socketClient from '@/lib/socket';

export default function PromptInterface({ projects }) {
  const [selectedProject, setSelectedProject] = useState('');
  const [prompt, setPrompt] = useState('');
  const [category, setCategory] = useState('content');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    
    if (!selectedProject || !prompt.trim()) {
      alert('Please select a project and enter a prompt');
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      const response = await apiClient.createChangeRequest({
        project_id: selectedProject,
        title: prompt.substring(0, 100),
        prompt: prompt,
        category: category
      });

      const changeRequest = response.data;
      
      // Subscribe to real-time updates
      socketClient.subscribeToChangeRequest(
        changeRequest.id,
        (update) => {
          console.log('Status update:', update);
          setResult(prev => ({
            ...prev,
            status: update.status,
            message: update.message
          }));
        }
      );

      setResult({
        id: changeRequest.id,
        status: changeRequest.status,
        message: 'Processing your request...'
      });

    } catch (error) {
      console.error('Failed to submit:', error);
      alert('Failed to submit request. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-xl font-semibold mb-4">
        What would you like to change?
      </h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Project Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Select Project
          </label>
          <select
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={loading}
          >
            <option value="">Choose a project...</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.display_name}
              </option>
            ))}
          </select>
        </div>

        {/* Prompt Input */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Describe your change
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            rows={6}
            placeholder="Example: Change the homepage hero text to 'Welcome to our new platform'"
            disabled={loading}
          />
          <p className="text-sm text-gray-500 mt-1">
            Be specific about what you want to change
          </p>
        </div>

        {/* Category Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Change Type
          </label>
          <div className="grid grid-cols-3 gap-3">
            {['content', 'styling', 'layout'].map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={`px-4 py-2 rounded-lg border-2 transition-colors ${
                  category === cat
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
                disabled={loading}
              >
                {cat.charAt(0).toUpperCase() + cat.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={loading || !selectedProject || !prompt.trim()}
          className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Processing...' : 'Submit Change Request'}
        </button>
      </form>

      {/* Result Display */}
      {result && (
        <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-blue-900">
                Request ID: {result.id.substring(0, 8)}
              </p>
              <p className="text-sm text-blue-700 mt-1">
                Status: {result.status}
              </p>
              <p className="text-sm text-blue-600 mt-1">
                {result.message}
              </p>
            </div>
            <a
              href={`/requests/${result.id}`}
              className="text-blue-600 hover:text-blue-800 font-medium"
            >
              View Details →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## Week 4: Staging Deployment & Testing

### Day 15-17: Docker Staging Service

#### Step 4.1: Docker Staging Service

**src/services/dockerStagingService.js:**

```javascript
const Docker = require('dockerode');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const logger = require('../utils/logger');

const execAsync = promisify(exec);

class DockerStagingService {
  constructor() {
    this.docker = new Docker();
    this.stagingBasePath = process.env.STAGING_BASE_PATH;
    this.stagingDomain = process.env.STAGING_DOMAIN;
  }

  /**
   * Create staging environment for change request
   */
  async createStagingEnvironment(changeRequestId, projectPath, generatedFiles) {
    const envId = changeRequestId.substring(0, 8);
    const workDir = path.join(this.stagingBasePath, envId);

    logger.info('Creating staging environment', { envId, workDir });

    try {
      // Create working directory
      await fs.mkdir(workDir, { recursive: true });

      // Copy project files
      await this._copyProject(projectPath, workDir);

      // Apply generated code changes
      for (const file of generatedFiles) {
        await this._applyFileChange(workDir, file);
      }

      // Create .env file for staging
      await this._createEnvFile(workDir, envId);

      // Start Docker container
      const container = await this._startContainer(envId, workDir);

      // Wait for container to be ready
      await this._waitForContainer(container.id);

      // Run Laravel setup
      await this._setupLaravel(container.id);

      const url = `https://cr-${envId}.${this.stagingDomain}`;

      // Configure Nginx reverse proxy
      await this._configureNginx(envId, container.id);

      logger.info('Staging environment created', { url, containerId: container.id });

      return {
        containerId: container.id,
        containerName: `staging-${envId}`,
        url: url,
        workDir: workDir
      };

    } catch (error) {
      logger.error('Failed to create staging environment', { 
        error: error.message,
        envId 
      });
      
      // Cleanup on failure
      await this._cleanup(envId);
      throw error;
    }
  }

  /**
   * Copy project to staging directory
   */
  async _copyProject(source, destination) {
    logger.info('Copying project files', { source, destination });
    
    await execAsync(`cp -r ${source}/. ${destination}/`);
    
    // Remove git directory (we don't need it in staging)
    await execAsync(`rm -rf ${destination}/.git`).catch(() => {});
  }

  /**
   * Apply file change
   */
  async _applyFileChange(workDir, fileData) {
    const filePath = path.join(workDir, fileData.file_path);
    
    // Create directory if needed
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    
    // Write file
    await fs.writeFile(filePath, fileData.generated_content, 'utf-8');
    
    logger.info('Applied file change', { file: fileData.file_path });
  }

  /**
   * Create staging .env file
   */
  async _createEnvFile(workDir, envId) {
    const envContent = `
APP_NAME=Laravel
APP_ENV=staging
APP_KEY=base64:${Buffer.from(envId.repeat(4)).toString('base64')}
APP_DEBUG=true
APP_URL=https://cr-${envId}.${this.stagingDomain}

LOG_CHANNEL=stack

DB_CONNECTION=sqlite
DB_DATABASE=${workDir}/database/database.sqlite

CACHE_DRIVER=file
QUEUE_CONNECTION=sync
SESSION_DRIVER=file

MAIL_MAILER=log
`;

    await fs.writeFile(
      path.join(workDir, '.env'),
      envContent.trim(),
      'utf-8'
    );

    // Create SQLite database
    await fs.mkdir(path.join(workDir, 'database'), { recursive: true });
    await fs.writeFile(
      path.join(workDir, 'database/database.sqlite'),
      ''
    );
  }

  /**
   * Start Docker container
   */
  async _startContainer(envId, workDir) {
    logger.info('Starting Docker container', { envId });

    const container = await this.docker.createContainer({
      Image: 'php:8.2-apache',
      name: `staging-${envId}`,
      Env: [
        'APACHE_DOCUMENT_ROOT=/var/www/html/public'
      ],
      ExposedPorts: {
        '80/tcp': {}
      },
      HostConfig: {
        Binds: [
          `${workDir}:/var/www/html:rw`
        ],
        PortBindings: {
          '80/tcp': [{ HostPort: '0' }] // Random port
        }
      },
      Labels: {
        'ai-sdlc.env-id': envId,
        'ai-sdlc.type': 'staging'
      }
    });

    await container.start();

    return container;
  }

  /**
   * Wait for container to be ready
   */
  async _waitForContainer(containerId, maxRetries = 30) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const container = this.docker.getContainer(containerId);
        const info = await container.inspect();
        
        if (info.State.Running) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          return true;
        }
      } catch (error) {
        // Continue waiting
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    throw new Error('Container failed to start');
  }

  /**
   * Setup Laravel in container
   */
  async _setupLaravel(containerId) {
    logger.info('Setting up Laravel', { containerId });

    const container = this.docker.getContainer(containerId);

    // Install composer dependencies
    await this._execInContainer(container, [
      'composer', 'install', '--no-interaction', '--prefer-dist'
    ]);

    // Run migrations
    await this._execInContainer(container, [
      'php', 'artisan', 'migrate', '--force'
    ]);

    // Cache config
    await this._execInContainer(container, [
      'php', 'artisan', 'config:cache'
    ]);

    // Set permissions
    await this._execInContainer(container, [
      'chown', '-R', 'www-data:www-data', 
      '/var/www/html/storage', 
      '/var/www/html/bootstrap/cache'
    ]);

    logger.info('Laravel setup complete');
  }

  /**
   * Execute command in container
   */
  async _execInContainer(container, cmd) {
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true
    });

    const stream = await exec.start();

    return new Promise((resolve, reject) => {
      let output = '';
      
      stream.on('data', (chunk) => {
        output += chunk.toString();
      });

      stream.on('end', () => {
        resolve(output);
      });

      stream.on('error', reject);
    });
  }

  /**
   * Configure Nginx reverse proxy
   */
  async _configureNginx(envId, containerId) {
    // Get container info to find port
    const container = this.docker.getContainer(containerId);
    const info = await container.inspect();
    
    const port = info.NetworkSettings.Ports['80/tcp'][0].HostPort;
    
    // Create Nginx location config
    const nginxConfig = `
    # Staging environment: cr-${envId}
    location / {
        proxy_pass http://localhost:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
`;

    // Update Nginx configuration
    // This would typically update the wildcard staging config
    logger.info('Nginx configured', { envId, port });
  }

  /**
   * Cleanup staging environment
   */
  async _cleanup(envId) {
    try {
      // Stop and remove container
      const containerName = `staging-${envId}`;
      const container = this.docker.getContainer(containerName);
      
      await container.stop().catch(() => {});
      await container.remove().catch(() => {});

      // Remove working directory
      const workDir = path.join(this.stagingBasePath, envId);
      await fs.rm(workDir, { recursive: true, force: true });

      logger.info('Staging environment cleaned up', { envId });
    } catch (error) {
      logger.error('Cleanup failed', { error: error.message, envId });
    }
  }

  /**
   * Get container logs
   */
  async getContainerLogs(containerId, tail = 100) {
    const container = this.docker.getContainer(containerId);
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail: tail
    });
    return logs.toString();
  }
}

module.exports = new DockerStagingService();
```

### Day 17-18: Complete Backend Routes

#### Step 4.2: Change Request Controller

**src/controllers/changeRequestController.js:**

```javascript
const { sequelize } = require('../config/database');
const aiService = require('../services/aiService');
const laravelAnalyzer = require('../services/laravelAnalyzer');
const dockerStagingService = require('../services/dockerStagingService');
const auditLogger = require('../utils/auditLogger');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;

class ChangeRequestController {
  /**
   * Create new change request
   */
  async create(req, res, next) {
    try {
      const { project_id, title, prompt, category } = req.body;
      const userId = req.user.id;

      // Validate input
      if (!project_id || !title || !prompt) {
        return res.status(400).json({ 
          error: 'project_id, title, and prompt are required' 
        });
      }

      // Get project
      const [projects] = await sequelize.query(
        'SELECT * FROM projects WHERE id = $1',
        { bind: [project_id] }
      );

      if (projects.length === 0) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const project = projects[0];

      // Create change request
      const requestId = uuidv4();
      await sequelize.query(
        `INSERT INTO change_requests 
         (id, project_id, user_id, title, prompt, category, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        { 
          bind: [requestId, project_id, userId, title, prompt, category || 'content']
        }
      );

      // Log audit
      await auditLogger.log({
        change_request_id: requestId,
        user_id: userId,
        action: 'CREATE_CHANGE_REQUEST',
        entity_type: 'ChangeRequest',
        entity_id: requestId,
        new_value: { title, category },
        ip_address: req.ip_address,
        user_agent: req.user_agent
      });

      // Get the created request
      const [newRequest] = await sequelize.query(
        'SELECT * FROM change_requests WHERE id = $1',
        { bind: [requestId] }
      );

      // Start async processing
      this._processChangeRequest(requestId, project).catch(error => {
        logger.error('Processing failed', { error: error.message, requestId });
      });

      res.json(newRequest[0]);

    } catch (error) {
      next(error);
    }
  }

  /**
   * Get change request by ID
   */
  async getById(req, res, next) {
    try {
      const { id } = req.params;

      const [requests] = await sequelize.query(
        `SELECT cr.*, p.display_name as project_name
         FROM change_requests cr
         JOIN projects p ON cr.project_id = p.id
         WHERE cr.id = $1`,
        { bind: [id] }
      );

      if (requests.length === 0) {
        return res.status(404).json({ error: 'Change request not found' });
      }

      res.json(requests[0]);

    } catch (error) {
      next(error);
    }
  }

  /**
   * List change requests
   */
  async list(req, res, next) {
    try {
      const { status, project_id, page = 1, limit = 20 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let query = `
        SELECT cr.*, p.display_name as project_name, p.production_url
        FROM change_requests cr
        JOIN projects p ON cr.project_id = p.id
        WHERE 1=1
      `;
      const binds = [];

      if (status) {
        binds.push(status);
        query += ` AND cr.status = $${binds.length}`;
      }

      if (project_id) {
        binds.push(project_id);
        query += ` AND cr.project_id = $${binds.length}`;
      }

      query += ` ORDER BY cr.created_at DESC LIMIT $${binds.length + 1} OFFSET $${binds.length + 2}`;
      binds.push(parseInt(limit), offset);

      const [requests] = await sequelize.query(query, { bind: binds });

      res.json(requests);

    } catch (error) {
      next(error);
    }
  }

  /**
   * Process change request (async)
   */
  async _processChangeRequest(requestId, project) {
    try {
      logger.info('Processing change request', { requestId });

      // Update status
      await this._updateStatus(requestId, 'analyzing');

      // Analyze Laravel project
      const projectContext = await laravelAnalyzer.analyzeProject(project.local_path);

      // Get change request details
      const [requests] = await sequelize.query(
        'SELECT * FROM change_requests WHERE id = $1',
        { bind: [requestId] }
      );
      const changeRequest = requests[0];

      // AI Analysis
      const analysis = await aiService.analyzeChangeRequest(
        changeRequest.prompt,
        projectContext,
        changeRequest.category
      );

      // Save analysis
      const analysisId = uuidv4();
      await sequelize.query(
        `INSERT INTO ai_analysis 
         (id, change_request_id, model_used, analysis_result, 
          complexity_score, estimated_files_affected, risk_assessment)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        {
          bind: [
            analysisId,
            requestId,
            'claude-sonnet-4-20250514',
            JSON.stringify(analysis),
            analysis.complexity,
            analysis.files_affected.length,
            analysis.risk_level
          ]
        }
      );

      // Generate code
      await this._updateStatus(requestId, 'generating_code');
      
      const generatedFiles = [];
      for (const step of analysis.implementation_plan) {
        // Read original file if exists
        const filePath = path.join(project.local_path, step.file_path);
        let originalContent = null;
        try {
          originalContent = await fs.readFile(filePath, 'utf-8');
        } catch (error) {
          // File doesn't exist, that's okay
        }

        // Generate code
        const code = await aiService.generateCode(step, projectContext, originalContent);

        // Save generated code
        const codeId = uuidv4();
        await sequelize.query(
          `INSERT INTO generated_code
           (id, change_request_id, file_path, original_content, 
            generated_content, change_type)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          {
            bind: [
              codeId,
              requestId,
              step.file_path,
              originalContent,
              code,
              step.change_type
            ]
          }
        );

        generatedFiles.push({
          file_path: step.file_path,
          generated_content: code,
          change_type: step.change_type
        });
      }

      // Create staging environment
      await this._updateStatus(requestId, 'staging');

      const stagingEnv = await dockerStagingService.createStagingEnvironment(
        requestId,
        project.local_path,
        generatedFiles
      );

      // Save staging environment
      const stagingId = uuidv4();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

      await sequelize.query(
        `INSERT INTO staging_environments
         (id, change_request_id, container_id, container_name, url, 
          status, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'ready', $6)`,
        {
          bind: [
            stagingId,
            requestId,
            stagingEnv.containerId,
            stagingEnv.containerName,
            stagingEnv.url,
            expiresAt
          ]
        }
      );

      // Update status
      await this._updateStatus(requestId, 'review');

      logger.info('Change request processing complete', { 
        requestId, 
        stagingUrl: stagingEnv.url 
      });

    } catch (error) {
      logger.error('Change request processing failed', { 
        requestId, 
        error: error.message 
      });

      await this._updateStatus(requestId, 'failed');
    }
  }

  /**
   * Update change request status
   */
  async _updateStatus(requestId, newStatus) {
    await sequelize.query(
      'UPDATE change_requests SET status = $1, updated_at = NOW() WHERE id = $2',
      { bind: [newStatus, requestId] }
    );

    logger.info('Status updated', { requestId, status: newStatus });

    // Emit WebSocket event
    // (This would be implemented with Socket.io in server.js)
  }
}

module.exports = new ChangeRequestController();
```

#### Step 4.3: Main Server File

**src/server.js:**

```javascript
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const socketIo = require('socket.io');

const { sequelize, testConnection } = require('./config/database');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

// Import routes
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const changeRequestRoutes = require('./routes/changeRequests');

// Initialize Express
const app = express();
const server = http.createServer(app);

// Initialize Socket.io
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) }}));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/change-requests', changeRequestRoutes);

// Error handling
app.use(errorHandler);

// Socket.io connection handling
io.on('connection', (socket) => {
  logger.info('Client connected', { socketId: socket.id });

  socket.on('subscribe:change-request', (requestId) => {
    socket.join(`cr-${requestId}`);
    logger.info('Subscribed to change request', { requestId, socketId: socket.id });
  });

  socket.on('disconnect', () => {
    logger.info('Client disconnected', { socketId: socket.id });
  });
});

// Export io for use in controllers
app.set('io', io);

// Start server
const PORT = process.env.PORT || 3001;

async function startServer() {
  try {
    // Test database connection
    await testConnection();

    // Start listening
    server.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      console.log(`✓ Server running on http://localhost:${PORT}`);
      console.log(`✓ Environment: ${process.env.NODE_ENV}`);
    });
  } catch (error) {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  }
}

startServer();

module.exports = { app, io };
```

---

## GitHub Integration Guide

### Complete GitHub Workflow

#### GitHub Repository Structure

Your repositories should have this structure:

```
yourcompany/
├── lgc/                    # Main Laravel project
├── admin-dashboard/        # Admin Laravel project
└── api-service/            # API Laravel project
```

#### GitHub Access Setup Summary

**Option 1: SSH Keys (Recommended)**
- ✅ Best for server-to-server
- ✅ No rate limits
- ✅ More secure
- See Section 1.6-1.7 for setup

**Option 2: Personal Access Token**
- ✅ Required for GitHub API (PRs, branches)
- ✅ Easier to revoke
- See Section 1.7 for creation

#### How AI SDLC Interacts with GitHub

1. **Read Access (SSH)**
   - Clone repositories
   - Pull latest changes
   - Read file contents

2. **Write Access (SSH)**
   - Create branches locally
   - Push branches to remote

3. **API Access (Token)**
   - Create pull requests
   - Add labels
   - Comment on PRs
   - Trigger workflows

---

## Testing & Validation

### Manual Testing Checklist

#### Week 4 Testing Phase

**Day 19: Integration Testing**

```bash
# Test 1: Create Change Request
curl -X POST http://localhost:3001/api/change-requests \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "project_id": "PROJECT_UUID",
    "title": "Change homepage text",
    "prompt": "Change the homepage hero heading to Welcome to LGC Platform",
    "category": "content"
  }'

# Expected: 200 OK with change request object

# Test 2: Check Status
curl http://localhost:3001/api/change-requests/CHANGE_REQUEST_ID \
  -H "Authorization: Bearer YOUR_TOKEN"

# Expected: Status should progress:
# pending → analyzing → generating_code → staging → review

# Test 3: Access Staging
# Open browser: https://cr-XXXXXXXX.staging.yoursite.com
# Expected: See Laravel app with changes applied

# Test 4: View Logs
docker logs staging-XXXXXXXX

# Expected: See Laravel logs, no errors
```

**Day 20: End-to-End Testing**

Test complete workflow:

1. ✅ User submits prompt via frontend
2. ✅ AI analyzes Laravel project
3. ✅ AI generates code
4. ✅ Code saved to database
5. ✅ Staging environment created
6. ✅ Laravel app runs in Docker
7. ✅ Changes visible in staging
8. ✅ Status updates in real-time

### Automated Testing

**Create test suite:**

```bash
cd backend

# Create test file
mkdir -p tests
touch tests/changeRequest.test.js
```

**tests/changeRequest.test.js:**

```javascript
const request = require('supertest');
const { app } = require('../src/server');

describe('Change Request API', () => {
  let authToken;
  let projectId;

  beforeAll(async () => {
    // Login to get token
    const response = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'test@example.com',
        password: 'password123'
      });
    
    authToken = response.body.token;
    projectId = 'YOUR_PROJECT_UUID';
  });

  test('Create change request', async () => {
    const response = await request(app)
      .post('/api/change-requests')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        project_id: projectId,
        title: 'Test change',
        prompt: 'Change homepage text',
        category: 'content'
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('id');
    expect(response.body.status).toBe('pending');
  });

  test('Get change request', async () => {
    // First create
    const createRes = await request(app)
      .post('/api/change-requests')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        project_id: projectId,
        title: 'Test',
        prompt: 'Test prompt',
        category: 'content'
      });

    const requestId = createRes.body.id;

    // Then get
    const response = await request(app)
      .get(`/api/change-requests/${requestId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(requestId);
  });
});
```

**Run tests:**

```bash
npm test
```

---

## Deployment Checklist

### Pre-Production Checklist

#### Security
- [ ] All environment variables set
- [ ] Strong JWT secret generated
- [ ] Database password is strong
- [ ] Firewall rules configured (UFW)
- [ ] SSH key authentication only (no password)
- [ ] SSL certificates installed and auto-renewing
- [ ] Nginx security headers configured
- [ ] API rate limiting enabled
- [ ] Input validation on all endpoints

#### Infrastructure
- [ ] Server provisioned and accessible
- [ ] PostgreSQL installed and running
- [ ] Redis installed and running
- [ ] Docker installed and working
- [ ] Nginx installed and configured
- [ ] DNS records pointing correctly
- [ ] Subdomains resolving (platform, *.staging)
- [ ] Disk space sufficient (100GB+)

#### Application
- [ ] Backend running on port 3001
- [ ] Frontend running on port 3000
- [ ] Database schema applied
- [ ] Projects table populated
- [ ] Laravel projects cloned
- [ ] GitHub SSH access working
- [ ] Anthropic API key valid
- [ ] WebSocket connections working

#### Testing
- [ ] Health check endpoint responding
- [ ] Can create change request
- [ ] AI analysis completes
- [ ] Code generation works
- [ ] Staging environment starts
- [ ] Docker containers running
- [ ] Staging URL accessible
- [ ] Real-time updates working

### Production Launch Steps

**Step 1: Final Backend Check**

```bash
cd /opt/ai-sdlc/backend
npm run start

# Verify logs show no errors
tail -f logs/combined.log
```

**Step 2: Final Frontend Check**

```bash
cd /opt/ai-sdlc/frontend
npm run build
npm run start

# Verify build completes successfully
```

**Step 3: Setup as System Services**

**backend.service:**

```bash
sudo nano /etc/systemd/system/ai-sdlc-backend.service
```

```ini
[Unit]
Description=AI SDLC Backend
After=network.target postgresql.service

[Service]
Type=simple
User=aiuser
WorkingDirectory=/opt/ai-sdlc/backend
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**frontend.service:**

```bash
sudo nano /etc/systemd/system/ai-sdlc-frontend.service
```

```ini
[Unit]
Description=AI SDLC Frontend
After=network.target

[Service]
Type=simple
User=aiuser
WorkingDirectory=/opt/ai-sdlc/frontend
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**Enable and start services:**

```bash
sudo systemctl daemon-reload
sudo systemctl enable ai-sdlc-backend
sudo systemctl enable ai-sdlc-frontend
sudo systemctl start ai-sdlc-backend
sudo systemctl start ai-sdlc-frontend

# Check status
sudo systemctl status ai-sdlc-backend
sudo systemctl status ai-sdlc-frontend
```

**Step 4: Create First User**

```bash
# Connect to database
psql -U ai_sdlc_user -d ai_sdlc_production

# Insert admin user (password: 'admin123' - change this!)
INSERT INTO users (email, password_hash, name, role) VALUES
('admin@yourcompany.com', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'Admin User', 'admin');

# Exit
\q
```

**Step 5: Test Login**

Open https://platform.yoursite.com and login with admin@yourcompany.com

**Step 6: Submit First Change Request**

1. Select project
2. Enter prompt: "Change homepage heading to Test"
3. Submit
4. Monitor progress in real-time
5. Check staging environment when ready

---

## Success Metrics

### Phase 1 Goals

By end of Week 4, you should have:

✅ **Infrastructure**
- Server running 24/7
- Database with all tables
- 3 Laravel projects cloned
- GitHub access working

✅ **Application**
- Backend API functional
- Frontend interface working
- Real-time updates operational
- Authentication working

✅ **Core Features**
- Create change requests
- AI analyzes prompts
- AI generates code
- Staging environments deploy
- Changes visible in staging

✅ **Performance**
- Change request submitted: < 5 seconds
- AI analysis complete: < 30 seconds
- Code generation: < 1 minute
- Staging ready: < 3 minutes
- Total time to preview: < 5 minutes

✅ **Quality**
- AI generates valid Laravel code
- Staging environments are isolated
- No security vulnerabilities
- Clean, browsable staging sites
- Logs captured properly

---

## Troubleshooting Common Issues

### Issue: PostgreSQL connection fails

```bash
# Check PostgreSQL is running
sudo systemctl status postgresql

# Check connection
psql -U ai_sdlc_user -d ai_sdlc_production -h localhost

# If password fails, reset it:
sudo -u postgres psql
ALTER USER ai_sdlc_user WITH PASSWORD 'new_password';
\q

# Update .env file with new password
```

### Issue: GitHub SSH fails

```bash
# Test connection
ssh -T git@github.com

# If fails, check key:
cat ~/.ssh/github_ai_sdlc.pub
# Copy and add to GitHub again

# Check SSH config
cat ~/.ssh/config

# Regenerate if needed
ssh-keygen -t ed25519 -C "ai-sdlc@yourcompany.com" -f ~/.ssh/github_ai_sdlc
```

### Issue: Docker container won't start

```bash
# Check Docker daemon
sudo systemctl status docker

# Check container logs
docker logs staging-XXXXXXXX

# Check disk space
df -h

# Remove old containers
docker container prune

# Restart Docker
sudo systemctl restart docker
```

### Issue: Staging URL not accessible

```bash
# Check Nginx
sudo nginx -t
sudo systemctl status nginx

# Check SSL certificates
sudo certbot certificates

# Check container is running
docker ps | grep staging

# Check port mapping
docker port staging-XXXXXXXX

# Check firewall
sudo ufw status
```

### Issue: AI API fails

```bash
# Check API key
echo $ANTHROPIC_API_KEY

# Test API directly
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}'

# Check logs
tail -f /opt/ai-sdlc/backend/logs/error.log
```

---

## Phase 1 Complete!

Congratulations! You've now built a working AI-driven SDLC system for Phase 1.

### What You've Accomplished

✨ Non-technical users can submit change requests  
✨ AI analyzes Laravel projects and generates code  
✨ Staging environments deploy automatically  
✨ Real-time progress tracking  
✨ Complete audit trail  
✨ Secure, isolated staging environments  

### What's Next

**Phase 2** will add:
- Creating complete new pages
- Database migrations
- Multi-file generation
- Advanced testing

**Phase 3** will add:
- Production deployment
- QA workflows
- Approval process
- Rollback capability

### Getting Help

- Review logs: `/opt/ai-sdlc/backend/logs/`
- Check services: `sudo systemctl status ai-sdlc-*`
- Monitor containers: `docker ps`
- Database queries: `psql -U ai_sdlc_user -d ai_sdlc_production`

---

**Document Version:** 1.0  
**Last Updated:** March 2026  
**For:** Phase 1 Implementation  
**Next:** Phase 2 Implementation Guide
