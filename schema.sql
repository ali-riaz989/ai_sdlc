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
