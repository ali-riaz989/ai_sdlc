-- AI SDLC Database Schema
-- Run: psql -U ai_sdlc_user -h localhost -d ai_sdlc_production -f schema.sql

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
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
    db_password VARCHAR(200),
    db_type VARCHAR(20),
    project_url VARCHAR(500),
    setup_error TEXT,
    status VARCHAR(50) DEFAULT 'active',
    last_synced_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(200) NOT NULL,
    role VARCHAR(50) DEFAULT 'user',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Change requests table
CREATE TABLE IF NOT EXISTS change_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_number SERIAL UNIQUE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    title VARCHAR(255) NOT NULL,
    prompt TEXT NOT NULL,
    category VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    priority VARCHAR(20) DEFAULT 'medium',
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- AI analysis results
CREATE TABLE IF NOT EXISTS ai_analysis (
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
CREATE TABLE IF NOT EXISTS generated_code (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_request_id UUID REFERENCES change_requests(id) ON DELETE CASCADE,
    file_path VARCHAR(500) NOT NULL,
    original_content TEXT,
    generated_content TEXT NOT NULL,
    diff TEXT,
    change_type VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Instant previews
CREATE TABLE IF NOT EXISTS instant_previews (
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
CREATE TABLE IF NOT EXISTS staging_environments (
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
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_request_id UUID REFERENCES change_requests(id) ON DELETE SET NULL,
    user_id INTEGER,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id TEXT,
    old_value JSONB,
    new_value JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_change_requests_status ON change_requests(status);
CREATE INDEX IF NOT EXISTS idx_change_requests_project ON change_requests(project_id);
CREATE INDEX IF NOT EXISTS idx_change_requests_user ON change_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_staging_envs_request ON staging_environments(change_request_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_request ON audit_logs(change_request_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Grant schema permissions to ai_sdlc_user
GRANT ALL ON SCHEMA public TO ai_sdlc_user;
GRANT ALL ON ALL TABLES IN SCHEMA public TO ai_sdlc_user;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ai_sdlc_user;

-- ── Chat persistence (per user, per project) ────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id         UUID REFERENCES projects(id) ON DELETE CASCADE,
  role               VARCHAR(16) NOT NULL,
  text               TEXT,
  type               VARCHAR(32) DEFAULT 'text',
  data               JSONB,
  change_request_id  UUID REFERENCES change_requests(id) ON DELETE SET NULL,
  created_at         TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_user_project ON chat_messages(user_id, project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_chat_project       ON chat_messages(project_id, created_at DESC, id DESC);

-- Strict role enum: admin | editor
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'editor';
UPDATE users SET role = 'editor' WHERE role NOT IN ('admin', 'editor');

-- ── Live edit (project-wide text/image overrides with step-by-step revert) ──
CREATE TABLE IF NOT EXISTS text_overrides (
  id              BIGSERIAL PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url             VARCHAR(512) NOT NULL,
  selector        TEXT NOT NULL,
  field           VARCHAR(32) NOT NULL DEFAULT 'text',
  previous_value  TEXT,
  new_value       TEXT NOT NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reverted        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_text_overrides_apply ON text_overrides(project_id, url, reverted, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_text_overrides_user  ON text_overrides(user_id, project_id, created_at DESC);

-- ── Column-drift safety ─────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS above is a no-op when the table already exists,
-- so any column added to a pre-existing table after the first deploy needs an
-- explicit ALTER here. ADD COLUMN IF NOT EXISTS keeps these idempotent — safe
-- to re-run migrate.sh repeatedly. Keep this list in sync with the CREATE
-- TABLE definitions above when you add new columns.
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS error_message TEXT;

-- ── Request telemetry (per change_request) ─────────────────────────────────
-- One structured row per change_request lifecycle. Single DB write at the end
-- of processing aggregates everything: timings, tokens, retries, AI reasoning,
-- file mutations, errors. Surfaced in the admin "/admin/logs" UI for testing.
CREATE TABLE IF NOT EXISTS request_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id   UUID NOT NULL UNIQUE REFERENCES change_requests(id) ON DELETE CASCADE,
  user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  project_id          UUID REFERENCES projects(id) ON DELETE SET NULL,
  status              VARCHAR(32) NOT NULL,
  pipeline            VARCHAR(32),                          -- directGenerate | fastTextSwap | fullPipeline
  duration_ms         INTEGER,
  ai_calls            INTEGER NOT NULL DEFAULT 0,
  retries             INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_create_tokens INTEGER NOT NULL DEFAULT 0,
  files_touched       INTEGER NOT NULL DEFAULT 0,
  error_category      VARCHAR(64),
  error_message       TEXT,
  reasoning           TEXT,
  events              JSONB NOT NULL DEFAULT '[]'::jsonb,
  phase_breakdown     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ai_calls_detail     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_request_logs_created  ON request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_status   ON request_logs(status);
CREATE INDEX IF NOT EXISTS idx_request_logs_user     ON request_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_project  ON request_logs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_duration ON request_logs(duration_ms DESC) WHERE duration_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_logs_errors   ON request_logs(error_category) WHERE error_category IS NOT NULL;
