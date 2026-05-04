const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');
const simpleGit = require('simple-git');
const execFileP = promisify(execFile);
const { sequelize } = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { validateProject } = require('../middleware/validation');
const auditLogger = require('../utils/auditLogger');
const logger = require('../utils/logger');

const router = express.Router();
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH || path.join(__dirname, '../../../projects');

// GET /api/projects
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const [projects] = await sequelize.query(
      'SELECT id, name, display_name, repo_url, repo_branch, production_url, status, local_path, project_url, db_type, setup_error, last_synced_at, created_at FROM projects ORDER BY created_at DESC'
    );

    const STUCK_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
    const now = Date.now();

    const checked = await Promise.all(projects.map(async (p) => {
      // Mark orphaned active projects (directory deleted)
      if (p.status === 'active' && !p.project_url) {
        try { await fs.access(p.local_path); } catch {
          await sequelize.query(
            "UPDATE projects SET status = 'clone_failed', updated_at = NOW() WHERE id = $1",
            { bind: [p.id] }
          );
          return { ...p, status: 'clone_failed' };
        }
      }
      // Reset stuck setting_up / cloning processes older than 15 min
      if (['setting_up', 'cloning'].includes(p.status)) {
        const age = now - new Date(p.updated_at || p.created_at).getTime();
        if (age > STUCK_TIMEOUT_MS) {
          await sequelize.query(
            "UPDATE projects SET status = 'setup_failed', setup_error = 'Process timed out after 15 minutes — click Retry Setup', updated_at = NOW() WHERE id = $1",
            { bind: [p.id] }
          );
          return { ...p, status: 'setup_failed', setup_error: 'Process timed out after 15 minutes — click Retry Setup' };
        }
      }
      return p;
    }));

    res.json(checked.filter(Boolean));
  } catch (error) {
    next(error);
  }
});

// GET /api/projects/:id
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    const [projects] = await sequelize.query(
      'SELECT * FROM projects WHERE id = $1',
      { bind: [req.params.id] }
    );
    if (projects.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }
    // Surface the branch the "Push to dev" button targets so the UI label stays
    // in sync with the server-side push handler. Single source of truth =
    // PUSH_BRANCH constant declared further down in this file.
    res.json({ ...projects[0], push_branch: PUSH_BRANCH });
  } catch (error) {
    next(error);
  }
});

// GET /api/projects/:id/sections - List all available section partials in
// resources/views/sections/ so the frontend can show a picker for new-page creation.
router.get('/:id/sections', authenticateToken, async (req, res, next) => {
  try {
    const [projects] = await sequelize.query('SELECT local_path FROM projects WHERE id = $1', { bind: [req.params.id] });
    if (!projects.length) return res.status(404).json({ error: 'Project not found' });

    const sectionsDir = path.join(projects[0].local_path, 'resources', 'views', 'sections');
    let entries;
    try { entries = await fs.readdir(sectionsDir); }
    catch { return res.status(404).json({ error: 'sections directory not found at resources/views/sections' }); }

    // Sections that aren't yet usable as standalone snippets — exclude from picker
    const denylist = new Set(['partner', 'blogs_section']);
    const sections = entries
      .filter(f => f.endsWith('.blade.php'))
      .map(f => f.replace(/\.blade\.php$/, ''))
      .filter(name => !denylist.has(name))
      .map(name => ({
        name,
        displayName: name.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    res.json({ sections });
  } catch (error) { next(error); }
});

// Insert a Route::get(...) line into routes/web.php immediately above the real catch-all
// dynamic page route — i.e. the one that uses `{slug}` AND chains `->where('slug', '.*')`.
// The naive regex approach can match a `{slug}` route inside an earlier admin group, so we
// scan line-by-line and pick the last qualifying occurrence (which is always the bottom-of-file
// catch-all in a Laravel routes file).
function insertRouteAboveCatchAll(webContent, routeLine) {
  const lines = webContent.split('\n');
  let insertIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/Route::get\s*\(\s*['"]\{slug\}['"]/.test(lines[i])) {
      const lookahead = lines.slice(i, Math.min(i + 5, lines.length)).join('\n');
      if (/->where\s*\(\s*['"]slug['"]\s*,\s*['"]\.\*['"]/.test(lookahead)) {
        insertIdx = i; // keep looking — last match wins
      }
    }
  }
  if (insertIdx >= 0) {
    lines.splice(insertIdx, 0, routeLine, '');
    return lines.join('\n');
  }
  return webContent.trimEnd() + '\n\n' + routeLine + '\n';
}

// POST /api/projects/:id/ensure-section-previews - Idempotently install the preview
// wrapper view + param route in the LGC project so each section can render standalone
// via /__preview_section/<name>. Called when the new-page modal opens.
router.post('/:id/ensure-section-previews', authenticateToken, async (req, res, next) => {
  try {
    const [projects] = await sequelize.query('SELECT local_path FROM projects WHERE id = $1', { bind: [req.params.id] });
    if (!projects.length) return res.status(404).json({ error: 'Project not found' });
    const localPath = projects[0].local_path;

    // 1) Preview wrapper — extends layouts.static (DB-free) so any section can render
    //    standalone without bringing the full layout's runtime data dependencies.
    const wrapperRel = path.join('resources', 'views', '__preview_wrapper.blade.php');
    const wrapperAbs = path.join(localPath, wrapperRel);
    const wrapperContent = `@extends('layouts.static')

@section('content')
    @include('sections.' . $section_name)
@endsection
`;
    // Always overwrite so future tweaks to this wrapper roll out
    await fs.writeFile(wrapperAbs, wrapperContent, 'utf-8');

    // 2) Route: param route for any section name (validated server-side via view()->exists)
    const webPhpAbs = path.join(localPath, 'routes', 'web.php');
    let webContent;
    try { webContent = await fs.readFile(webPhpAbs, 'utf-8'); }
    catch { return res.status(500).json({ error: 'routes/web.php not found in project' }); }

    const previewRouteMarker = "Route::get('/__preview_section/{name}'";
    if (!webContent.includes(previewRouteMarker)) {
      const previewRoute = `Route::get('/__preview_section/{name}', function (\$name) {
    if (!preg_match('/^[a-z0-9_-]+$/i', \$name)) abort(400);
    if (!view()->exists('sections.' . \$name)) abort(404);
    return view('__preview_wrapper', ['section_name' => \$name]);
});`;
      const newWebContent = insertRouteAboveCatchAll(webContent, previewRoute);
      await fs.writeFile(webPhpAbs, newWebContent, 'utf-8');
    }

    // 3) Clear Laravel view cache so the wrapper compiles fresh
    const { exec } = require('child_process');
    await new Promise(resolve => exec('php artisan view:clear', { cwd: localPath }, () => resolve()));

    res.json({ ok: true, preview_url_template: '/__preview_section/<name>' });
  } catch (error) { next(error); }
});

// POST /api/projects/:id/pages - Scaffold a new page from a list of sections + URL.
// Body: { url: "/play/coaching", sections: ["hero_banner", "faqs", ...] }
// Effect:
//   1. Writes resources/views/frontend/static_pages/<lastSegment>.blade.php
//   2. Inserts a Route::get(...) line into routes/web.php above the catch-all dynamic page route
// Returns: { url, blade_file, route }
router.post('/:id/pages', authenticateToken, async (req, res, next) => {
  try {
    const { url, sections } = req.body || {};
    if (typeof url !== 'string' || !url.trim()) return res.status(400).json({ error: 'url is required' });
    if (!Array.isArray(sections) || !sections.length) return res.status(400).json({ error: 'sections must be a non-empty array' });

    const [projects] = await sequelize.query('SELECT local_path FROM projects WHERE id = $1', { bind: [req.params.id] });
    if (!projects.length) return res.status(404).json({ error: 'Project not found' });
    const localPath = projects[0].local_path;

    // Normalise URL: trim, leading slash, no trailing slash, no double slashes
    const cleanUrl = '/' + url.trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
    if (cleanUrl === '/') return res.status(400).json({ error: 'URL cannot be empty / root' });
    const segments = cleanUrl.slice(1).split('/');
    const slug = segments[segments.length - 1];
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) {
      return res.status(400).json({ error: 'last URL segment must contain only letters, digits, underscores, dashes' });
    }

    // Validate every section file exists in resources/views/sections/
    const sectionsDir = path.join(localPath, 'resources', 'views', 'sections');
    for (const s of sections) {
      if (typeof s !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(s)) {
        return res.status(400).json({ error: `invalid section name: ${s}` });
      }
      try { await fs.access(path.join(sectionsDir, `${s}.blade.php`)); }
      catch { return res.status(400).json({ error: `section "${s}" not found in resources/views/sections/` }); }
    }

    // Collision: blade file
    const bladeRel = path.join('resources', 'views', 'frontend', 'static_pages', `${slug}.blade.php`);
    const bladeAbs = path.join(localPath, bladeRel);
    try { await fs.access(bladeAbs); return res.status(409).json({ error: 'URL already exist, type a different url' }); }
    catch {}

    // Collision: route in web.php (any Route::get / Route::any with matching path)
    const webPhpRel = 'routes/web.php';
    const webPhpAbs = path.join(localPath, webPhpRel);
    let webContent;
    try { webContent = await fs.readFile(webPhpAbs, 'utf-8'); }
    catch { return res.status(500).json({ error: 'routes/web.php not found in project' }); }

    const routePath = cleanUrl;
    const routePathNoSlash = routePath.startsWith('/') ? routePath.slice(1) : routePath;
    // Match Route::<verb>('/play/coaching', ...) or 'play/coaching' (with optional leading slash)
    const escaped = routePathNoSlash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const routeCollisionRe = new RegExp(`Route::\\w+\\s*\\(\\s*['"]\\/?${escaped}['"]`);
    if (routeCollisionRe.test(webContent)) {
      return res.status(409).json({ error: 'URL already exist, type a different url' });
    }

    // Write blade file (uses layouts.static — the DB-free layout for scaffolded pages).
    //
    // Inline each section's RENDERED HTML (not @include, and not the raw .blade.php source).
    // Reasoning: @include shares a single source of truth with every other page using the
    // partial — editing the heading on /test/lgc would silently propagate to every page.
    // Copying the raw blade source preserves @php blocks and {{ $var }} interpolations,
    // which couples the new page to the section file's $section variables — the new page
    // is no longer self-contained, and editing it can break renders.
    // So: shell out to bin/render-section.php (Laravel renderer) to bake each section into
    // plain HTML with all variables resolved, then paste THAT into the new page. The
    // BladeSourceAttributeProvider's precompiler will inject correct data-blade-src
    // attributes pointing at this new page's own line numbers when it compiles.
    const renderScript = path.join(localPath, 'bin', 'render-section.php');
    const bladeParts = [];
    for (const s of sections) {
      try {
        const { stdout } = await execFileP('php', [renderScript, `sections.${s}`], {
          cwd: localPath,
          maxBuffer: 4 * 1024 * 1024,
          timeout: 30_000,
        });
        const html = stdout.replace(/\s+$/, '');
        if (!html) throw new Error('renderer returned empty output');
        bladeParts.push(`{{-- BEGIN section: ${s} --}}\n${html}\n{{-- END section: ${s} --}}`);
      } catch (e) {
        const msg = (e.stderr && String(e.stderr).trim()) || e.message || 'unknown render error';
        logger.warn('Section render failed', { section: s, error: msg });
        return res.status(500).json({ error: `failed to render section "${s}": ${msg}` });
      }
    }
    const bladeBody = bladeParts.join('\n\n');
    const bladeContent = `@extends('layouts.static')

@section('content')
${bladeBody}
@endsection
`;
    await fs.mkdir(path.dirname(bladeAbs), { recursive: true });
    await fs.writeFile(bladeAbs, bladeContent, 'utf-8');

    // Insert route into web.php — above the catch-all dynamic page route if present, else append
    const viewName = `frontend.static_pages.${slug}`;
    const routeLine = `Route::get('${routePath}', function () { return view('${viewName}'); });`;
    const newWebContent = insertRouteAboveCatchAll(webContent, routeLine);
    await fs.writeFile(webPhpAbs, newWebContent, 'utf-8');

    logger.info('Page scaffolded', { url: routePath, blade: bladeRel, sections: sections.length });
    res.json({ url: routePath, blade_file: bladeRel, route: routeLine });
  } catch (error) { next(error); }
});

// POST /api/projects/:id/resolve-route - Map a live page URL to its blade file once,
// so the chat-edit flow can skip repeating this on every prompt.
router.post('/:id/resolve-route', authenticateToken, async (req, res, next) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });

    const [projects] = await sequelize.query(
      'SELECT local_path FROM projects WHERE id = $1',
      { bind: [req.params.id] }
    );
    if (!projects.length) return res.status(404).json({ error: 'Project not found' });

    const routeResolver = require('../services/routeResolver');
    const resolved = await routeResolver.resolve(projects[0].local_path, url);
    if (!resolved) return res.status(404).json({ error: 'No route matched', url });

    // Confirm the blade file actually exists on disk before returning
    try { await fs.access(resolved.abs_path); }
    catch { return res.status(404).json({ error: 'Blade file missing on disk', blade_file: resolved.blade_file }); }

    res.json({ blade_file: resolved.blade_file, abs_path: resolved.abs_path, url });

    // Fire-and-forget: pre-warm Anthropic's prompt cache for the resolved page so the
    // user's first edit hits a warm cache (~2s) instead of cold (~4s). Builds the SAME
    // candidate set as _directGenerate so the cache key matches at edit time.
    setImmediate(async () => {
      try {
        const aiService = require('../services/aiService');
        const ctrl = require('../controllers/changeRequestController');
        const localPath = projects[0].local_path;
        const bladeAbs = resolved.abs_path;
        const bladeContent = await fs.readFile(bladeAbs, 'utf-8');
        const candidates = [{ path: resolved.blade_file, content: bladeContent, type: 'blade' }];
        try {
          const cssFiles = await ctrl._findLinkedCssFiles(localPath, { blade_file: resolved.blade_file });
          for (const f of cssFiles) {
            try {
              let content = await fs.readFile(f.abs, 'utf-8');
              if (content.length > 12000) content = content.substring(0, 12000);
              candidates.push({ path: f.rel, content, type: 'css' });
            } catch {}
          }
        } catch {}
        await aiService.warmEditCache({ candidates });
      } catch (e) {
        // Warmer is best-effort — never fail the user's request because of it
        require('../utils/logger').warn('Cache warm failed', { error: e.message });
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/projects - Create and clone a new project (async clone)
router.post('/', authenticateToken, requireRole('admin'), validateProject, async (req, res, next) => {
  try {
    const { name, display_name, repo_url, repo_branch = 'main', production_url, git_token } = req.body;
    const uuidv4 = () => require('crypto').randomUUID();

    const localPath = path.join(PROJECT_BASE_PATH, name);

    // If stale directory exists from a previous failed attempt, remove it
    try {
      await fs.access(localPath);
      // Check if already a valid project in DB
      const [existing] = await sequelize.query(
        "SELECT id FROM projects WHERE name = $1 AND status != 'cloning'",
        { bind: [name] }
      );
      if (existing.length > 0) {
        return res.status(409).json({ error: `Project '${name}' already exists` });
      }
      // Stale dir from failed clone — clean it up
      await fs.rm(localPath, { recursive: true, force: true });
    } catch (e) {
      // Directory doesn't exist, that's fine
    }

    // Save project record immediately with status 'cloning'
    const projectId = uuidv4();
    await sequelize.query(
      `INSERT INTO projects (id, name, display_name, repo_url, repo_branch, local_path, production_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'cloning')`,
      { bind: [projectId, name, display_name, repo_url, repo_branch, localPath, production_url || null] }
    );

    // Respond immediately — clone runs in background
    const [created] = await sequelize.query(
      'SELECT id, name, display_name, repo_url, repo_branch, production_url, status, local_path, created_at FROM projects WHERE id = $1',
      { bind: [projectId] }
    );
    res.status(202).json(created[0]);

    // Background clone
    _cloneInBackground({ projectId, name, repo_url, repo_branch, git_token, localPath, display_name, req });
  } catch (error) {
    next(error);
  }
});

async function _cloneInBackground({ projectId, name, repo_url, repo_branch, git_token, localPath, display_name, req }) {
  const setStatus = async (status) => {
    await sequelize.query(
      "UPDATE projects SET status = $1, updated_at = NOW() WHERE id = $2",
      { bind: [status, projectId] }
    );
  };

  try {
    // Build authenticated clone URL if token provided
    let cloneUrl = repo_url;
    if (git_token) {
      cloneUrl = repo_url.replace('https://', `https://oauth2:${git_token}@`);
    }

    logger.info('Cloning repository', { name, repo_url, repo_branch });

    const git = simpleGit().env({
      ...process.env,
      HOME: process.env.HOME || `/home/${require('os').userInfo().username}`,
      GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=no -o BatchMode=yes'
    });

    await git.clone(cloneUrl, localPath, ['--branch', repo_branch, '--depth', '1']);

    // Configure git identity in the cloned repo
    const repoGit = simpleGit(localPath);
    await repoGit.addConfig('user.name', 'AI SDLC Bot');
    await repoGit.addConfig('user.email', 'ai-sdlc@platform.local');

    await sequelize.query(
      "UPDATE projects SET status = 'active', last_synced_at = NOW(), updated_at = NOW() WHERE id = $1",
      { bind: [projectId] }
    );

    await auditLogger.log({
      user_id: req.user?.id,
      action: 'CREATE_PROJECT',
      entity_type: 'Project',
      entity_id: projectId,
      new_value: { name, display_name, repo_url },
    });

    logger.info('Repository cloned successfully', { name, localPath });
  } catch (error) {
    logger.error('Clone failed', { name, error: error.message });
    await setStatus('clone_failed');
    await fs.rm(localPath, { recursive: true, force: true }).catch(() => {});
  }
}

// POST /api/projects/:id/setup
// Body: { db_type: 'mysql'|'postgres', setup_action: 'migrate'|'import', mysql_root_password?: string }
// File: db_file (optional, for import action)
const multer = require('multer');
const os = require('os');
const crypto = require('crypto');
const { Client: PgClient } = require('pg');
const { spawn } = require('child_process');

// Run SQL via mysql CLI using spawn (avoids all shell quoting issues)
function mysqlExec(rootPassword, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('mysql', ['-u', 'root', `-p${rootPassword}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => reject(err.code === 'ENOENT' ? new Error('mysql binary not found on server (install: sudo apt install mysql-client)') : err));
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.replace(/^mysql: \[Warning\][^\n]*\n/m, '').trim()));
    });
    child.stdin.write(sql + ';');
    child.stdin.end();
  });
}
const upload = multer({ dest: os.tmpdir() });

router.post('/:id/setup', authenticateToken, requireRole('admin'), upload.single('db_file'), async (req, res, next) => {
  try {
    const [projects] = await sequelize.query(
      'SELECT * FROM projects WHERE id = $1',
      { bind: [req.params.id] }
    );
    if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projects[0];

    const { db_type, setup_action, env_content } = req.body;

    await sequelize.query(
      "UPDATE projects SET db_type = $1, status = 'setting_up', updated_at = NOW() WHERE id = $2",
      { bind: [db_type, project.id] }
    );

    res.json({ message: 'Setup started', status: 'setting_up' });

    const io = req.app.get('io');
    _setupProjectInBackground({
      project: { ...project, db_type },
      setup_action,
      mysql_root_password: process.env.MYSQL_ROOT_PASSWORD || null,
      db_file_path: req.file?.path || null,
      env_content: env_content || null,
      io
    });
  } catch (error) {
    next(error);
  }
});

async function _setupProjectInBackground({ project, setup_action, mysql_root_password, db_file_path, env_content, io }) {
  const readline        = require('readline');
  const logBuffer       = require('../utils/logBuffer');
  const pendingQuestions = require('../utils/pendingQuestions');

  const dbName     = `proj_${project.name.replace(/-/g, '_')}`;
  const dbUser     = process.env.DB_USER;
  const dbPass     = process.env.DB_PASSWORD;
  const isPostgres = project.db_type === 'postgres';
  const dbPort     = isPostgres ? 5432 : 3306;
  const room       = `project-setup-${project.id}`;

  // Extend PATH with nvm/node location — auto-detect from current process
  const NVM_BIN = process.env.NVM_BIN || require('path').dirname(process.execPath);
  const childEnv = {
    ...process.env,
    PATH: `${NVM_BIN}:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`
  };

  // Emit a log line to the frontend terminal and buffer it for late subscribers
  const log = (line, level = 'info') => {
    const entry = { line, level, ts: Date.now() };
    logBuffer.push(project.id, entry);
    io?.to(room).emit('project:log', entry);
    logger.info(`[setup:${project.name}] ${line}`);
  };

  // Run a command, streaming output line by line to the frontend
  const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
    log(`$ ${cmd} ${args.join(' ')}`, 'cmd');
    const child = spawn(cmd, args, {
      cwd: project.local_path,
      env: { ...childEnv, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const pipeLines = (stream, level) => {
      readline.createInterface({ input: stream }).on('line', line => {
        if (line.trim()) log(line, level);
      });
    };
    pipeLines(child.stdout, 'info');
    pipeLines(child.stderr, 'warn');

    // Heartbeat — shows "still running" every 10s if no output
    let lastLog = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastLog > 4000) {
        io?.to(room).emit('project:log', { line: `  ⏳ still running ${cmd}…`, level: 'info', ts: Date.now() });
        lastLog = Date.now();
      }
    }, 5000);
    child.stdout.on('data', () => { lastLog = Date.now(); });
    child.stderr.on('data', () => { lastLog = Date.now(); });

    let errBuf = '';
    child.stderr.on('data', d => { errBuf += d; });
    child.on('error', err => {
      clearInterval(heartbeat);
      if (err.code === 'ENOENT') reject(new Error(`${cmd}: command not found on server (install it or check PATH)`));
      else reject(err);
    });
    child.on('close', code => {
      clearInterval(heartbeat);
      code === 0 ? resolve() : reject(new Error(errBuf.trim() || `${cmd} exited with code ${code}`));
    });
  });

  // Ask the user in the terminal and wait for their answer (120s timeout → default last option)
  const ask = (question, options) => new Promise((resolve) => {
    io?.to(room).emit('project:question', { question, options });
    const timeoutId = setTimeout(() => {
      pendingQuestions.delete(project.id);
      resolve(options[0].value); // default to first option (Run) on timeout
    }, 120000);
    pendingQuestions.set(project.id, { resolve, timeout: timeoutId });
  });

  // Confirm before running a command — returns true if user wants to run it
  const confirm = async (label, command) => {
    const answer = await ask(`Run: ${command}\n\n${label}`, [
      { label: 'Run',  value: 'run'  },
      { label: 'Skip', value: 'skip' }
    ]);
    if (answer === 'skip') { log(`⏭ Skipped: ${command}`, 'warn'); return false; }
    return true;
  };

  // Ask Claude to analyze a failure and suggest fix commands, then let user run them
  const aiHelp = async (failedCmd, errorText) => {
    try {
      log('🤖 Asking Claude AI to diagnose the error...', 'ai');
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic();
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `A project setup command failed on an Ubuntu/Debian server. Analyze and suggest fix commands.

Failed command: ${failedCmd}
Project path: ${project.local_path}
Project type: Laravel PHP
Error output:
${errorText.substring(0, 3000)}

Reply ONLY with valid JSON (no markdown):
{
  "diagnosis": "Clear 1-2 sentence explanation of what went wrong",
  "fixes": [
    {
      "description": "What this fix does",
      "cmd": "the full shell command",
      "args": ["arg1", "arg2"]
    }
  ]
}

Rules:
- Each fix must be a single binary call with args array (no shell pipelines)
- Order fixes from most likely to work first
- Max 3 fixes
- If the command itself needs different args to retry, include that as a fix
- Common commands: apt-get, composer, php, npm, yarn, pip`
        }]
      });

      const raw = msg.content[0].text.trim().replace(/^```json\n?|\n?```$/g, '');
      const result = JSON.parse(raw);

      log(`🤖 ${result.diagnosis}`, 'ai');

      for (const fix of (result.fixes || [])) {
        const cmdStr = `${fix.cmd} ${(fix.args || []).join(' ')}`.trim();
        const answer = await ask(
          `💡 ${fix.description}\n\nSuggested command: ${cmdStr}`,
          [
            { label: 'Run this fix', value: 'run'  },
            { label: 'Skip',         value: 'skip' }
          ]
        );
        if (answer === 'run') {
          log(`🔧 Running fix: ${cmdStr}`, 'ai');
          try {
            await run(fix.cmd, fix.args || []);
            log('✓ Fix applied', 'success');
            return true; // fix was applied — caller should retry
          } catch (fixErr) {
            log(`⚠ Fix failed: ${fixErr.message}`, 'warn');
          }
        }
      }
    } catch (e) {
      log(`🤖 AI diagnosis unavailable: ${e.message}`, 'warn');
    }
    return false;
  };

  // Run a command with AI-assisted error recovery — retries once after AI fix
  const runWithAI = async (cmd, args, opts = {}) => {
    try {
      await run(cmd, args, opts);
    } catch (err) {
      const cmdStr = `${cmd} ${args.join(' ')}`;
      log(`❌ Command failed: ${cmdStr}`, 'error');
      const fixed = await aiHelp(cmdStr, err.message);
      if (fixed) {
        log(`🔄 Retrying: ${cmdStr}`, 'ai');
        await run(cmd, args, opts); // retry after fix
      } else {
        throw err;
      }
    }
  };

  // Run composer install with AI error recovery
  const runComposer = async () => {
    const cmd = 'composer install --no-interaction --prefer-dist --optimize-autoloader --no-scripts --ignore-platform-reqs';
    await runWithAI('script', ['-q', '-e', '-c', cmd, '/dev/null']);
    try {
      await run('php', ['artisan', 'package:discover', '--ansi']);
    } catch {
      log('⚠ package:discover had warnings — continuing', 'warn');
    }
  };

  // Hard timeout — kill entire setup after 20 minutes
  const setupTimeout = setTimeout(async () => {
    log('❌ Setup timed out after 20 minutes', 'error');
    await sequelize.query(
      "UPDATE projects SET status = 'setup_failed', setup_error = 'Setup timed out after 20 minutes', updated_at = NOW() WHERE id = $1",
      { bind: [project.id] }
    );
  }, 20 * 60 * 1000);

  try {
    log(`▶ Starting setup for ${project.display_name}`, 'success');

    // ── 1. Create database (skip for env_only) ─────────────────────────────
    if (setup_action !== 'env_only') {
      log('📦 Creating database on this server...', 'info');
      if (isPostgres) {
        const adminClient = new PgClient({
          host: 'localhost', port: 5432,
          database: 'postgres',
          user: process.env.POSTGRES_SUPERUSER || 'postgres',
          password: process.env.POSTGRES_SUPERUSER_PASSWORD || ''
        });
        await adminClient.connect();
        await adminClient.query(`DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${dbUser}') THEN
            CREATE ROLE "${dbUser}" LOGIN PASSWORD '${dbPass}';
          END IF;
        END $$`);
        await adminClient.query(`CREATE DATABASE "${dbName}" OWNER "${dbUser}"`).catch(() => {});
        await adminClient.query(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${dbUser}"`);
        await adminClient.end();
      } else {
        if (!mysql_root_password) throw new Error('MYSQL_ROOT_PASSWORD not set in backend .env');
        await mysqlExec(mysql_root_password, `CREATE DATABASE IF NOT EXISTS ${dbName}`);
        await mysqlExec(mysql_root_password, `CREATE USER IF NOT EXISTS '${dbUser}'@'%' IDENTIFIED BY '${dbPass}'`);
        await mysqlExec(mysql_root_password, `GRANT ALL PRIVILEGES ON ${dbName}.* TO '${dbUser}'@'%'`);
        await mysqlExec(mysql_root_password, `FLUSH PRIVILEGES`);
      }
      log(`✓ Database "${dbName}" created`, 'success');

      // ── 2. Save DB config ───────────────────────────────────────────────
      await sequelize.query(
        `UPDATE projects SET db_host = 'localhost', db_port = $1, db_name = $2,
           db_user = $3, db_password = $4, updated_at = NOW() WHERE id = $5`,
        { bind: [dbPort, dbName, dbUser, dbPass, project.id] }
      );
    } else {
      log('⏭ Skipping DB creation — using existing database from .env', 'info');
    }

    // ── 3. Write Laravel .env ─────────────────────────────────────────────
    let laravelEnv;
    if (env_content) {
      // User provided their own .env — use it directly, only inject DB_DATABASE if missing
      laravelEnv = env_content;
      if (!laravelEnv.match(/^DB_DATABASE=/m)) {
        laravelEnv += `\nDB_DATABASE=${dbName}`;
      }
      log('✓ Using provided .env file', 'success');
    } else {
      const appKey = `base64:${crypto.randomBytes(32).toString('base64')}`;
      laravelEnv = `APP_NAME=Laravel
APP_ENV=local
APP_KEY=${appKey}
APP_DEBUG=true
APP_URL=http://localhost

DB_CONNECTION=${isPostgres ? 'pgsql' : 'mysql'}
DB_HOST=127.0.0.1
DB_PORT=${dbPort}
DB_DATABASE=${dbName}
DB_USERNAME=${dbUser}
DB_PASSWORD=${dbPass}

CACHE_DRIVER=file
QUEUE_CONNECTION=sync
SESSION_DRIVER=file
MAIL_MAILER=log
`;
    }
    await fs.writeFile(path.join(project.local_path, '.env'), laravelEnv, 'utf-8');
    log('✓ Laravel .env written', 'success');

    // ── 4. Composer install ───────────────────────────────────────────────
    const autoRun = setup_action === 'env_only'; // skip confirms for env_only
    if (autoRun || await confirm('Install PHP dependencies via Composer?', 'composer install')) {
      log('📦 Running composer install...', 'info');
      await runComposer();
      log('✓ Composer install complete', 'success');
    }

    // ── 4b. npm install (if package.json exists) ──────────────────────────
    try {
      await fs.access(path.join(project.local_path, 'package.json'));
      if (autoRun || await confirm('package.json found — install JS dependencies?', 'npm install --legacy-peer-deps')) {
        log('📦 Running npm install...', 'info');
        await runWithAI('script', ['-q', '-e', '-c', 'npm install --legacy-peer-deps', '/dev/null']);
        log('✓ npm install complete', 'success');
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }

    // ── 5. Migrate or import ──────────────────────────────────────────────
    if (setup_action === 'migrate') {
      if (await confirm('Run database migrations?', 'php artisan migrate --force')) {
        await runWithAI('php', ['artisan', 'migrate', '--force']);
        log('✓ Migrations complete', 'success');
      }
    } else if (setup_action === 'env_only') {
      log('⏭ Skipping migration — using existing database', 'info');
    } else if (setup_action === 'import' && db_file_path) {
      if (await confirm('Import SQL dump into database?', `mysql ... < ${path.basename(db_file_path)}`)) {
        if (isPostgres) {
          await runWithAI('psql', ['-h', '127.0.0.1', '-p', String(dbPort), '-U', dbUser, '-d', dbName, '-f', db_file_path],
            { env: { PGPASSWORD: dbPass } });
        } else {
          await new Promise((resolve, reject) => {
            log(`$ mysql -h 127.0.0.1 -u ${dbUser} ${dbName} < ${path.basename(db_file_path)}`, 'cmd');
            const child = spawn('mysql', ['-h', '127.0.0.1', '-P', String(dbPort), `-u${dbUser}`, `-p${dbPass}`, dbName],
              { stdio: ['pipe', 'pipe', 'pipe'] });
            let err = '';
            child.stderr.on('data', d => { err += d; });
            child.on('error', e => reject(e.code === 'ENOENT' ? new Error('mysql binary not found on server') : e));
            child.on('close', code => code === 0 ? resolve() : reject(new Error(err.replace(/^mysql: \[Warning\][^\n]*\n/m, '').trim())));
            require('fs').createReadStream(db_file_path).pipe(child.stdin);
          });
        }
        await fs.rm(db_file_path).catch(() => {});
        log('✓ Database import complete', 'success');
      }
    }

    // ── 6. Ensure Laravel storage dirs exist and are writable ────────────
    const storageDirs = [
      'storage/framework/cache', 'storage/framework/sessions',
      'storage/framework/views', 'storage/logs', 'bootstrap/cache'
    ];
    for (const dir of storageDirs) {
      await fs.mkdir(path.join(project.local_path, dir), { recursive: true }).catch(() => {});
    }

    // ── 7. Start php artisan serve via pm2 (keeps it alive) ──────────────
    const port = await _findFreePort(8100, 8999);
    const projectUrl = `http://localhost:${port}`;
    const pm2Name = `project-${project.name}`;
    log(`🚀 Starting server on port ${port} via pm2...`, 'info');

    const PM2 = require('path').join(require('path').dirname(process.execPath), 'npx');
    // Stop old instance if exists
    await new Promise(resolve => {
      const stop = spawn(PM2, ['pm2', 'delete', pm2Name], { stdio: 'ignore' });
      stop.on('error', () => resolve());
      stop.on('close', resolve);
    });
    // Start fresh
    await new Promise((resolve, reject) => {
      const start = spawn(PM2, [
        'pm2', 'start', 'php',
        '--name', pm2Name,
        '--cwd', project.local_path,
        '--',
        'artisan', 'serve', `--port=${port}`, '--host=0.0.0.0'
      ], { env: childEnv, stdio: 'ignore' });
      start.on('error', err => reject(err.code === 'ENOENT' ? new Error('npx/pm2 not found on server') : err));
      start.on('close', code => code === 0 ? resolve() : reject(new Error(`pm2 start failed (code ${code})`)));
    });
    log(`✓ Server started with pm2 as "${pm2Name}"`, 'success');

    // ── 7. Save URL ───────────────────────────────────────────────────────
    await sequelize.query(
      'UPDATE projects SET status = $1, project_url = $2, updated_at = NOW() WHERE id = $3',
      { bind: ['active', projectUrl, project.id] }
    );

    clearTimeout(setupTimeout);
    log(`✅ Setup complete! Running at ${projectUrl}`, 'success');
    setTimeout(() => logBuffer.clear(project.id), 30000);

  } catch (error) {
    clearTimeout(setupTimeout);
    log(`❌ Setup failed: ${error.message}`, 'error');
    await sequelize.query(
      "UPDATE projects SET status = 'setup_failed', setup_error = $1, updated_at = NOW() WHERE id = $2",
      { bind: [error.message, project.id] }
    );
  }
}

async function _findFreePort(from, to) {
  const net = require('net');
  for (let port = from; port <= to; port++) {
    const free = await new Promise(resolve => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(port);
    });
    if (free) return port;
  }
  throw new Error(`No free port found between ${from} and ${to}`);
}


// POST /api/projects/:id/sync - Pull latest from remote
router.post('/:id/sync', authenticateToken, requireRole('admin'), async (req, res, next) => {
  try {
    const [projects] = await sequelize.query(
      'SELECT * FROM projects WHERE id = $1',
      { bind: [req.params.id] }
    );

    if (projects.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const project = projects[0];
    const { git_token } = req.body;

    const git = simpleGit(project.local_path);

    if (git_token) {
      const remoteUrl = project.repo_url.replace('https://', `https://oauth2:${git_token}@`);
      await git.remote(['set-url', 'origin', remoteUrl]);
    }

    await git.pull('origin', project.repo_branch);

    await sequelize.query(
      'UPDATE projects SET last_synced_at = NOW(), updated_at = NOW() WHERE id = $1',
      { bind: [project.id] }
    );

    logger.info('Project synced', { projectId: project.id, name: project.name });
    res.json({ message: 'Project synced successfully', synced_at: new Date() });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/projects/:id
router.delete('/:id', authenticateToken, requireRole('admin'), async (req, res, next) => {
  try {
    const [projects] = await sequelize.query(
      'SELECT * FROM projects WHERE id = $1',
      { bind: [req.params.id] }
    );

    if (projects.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    await sequelize.query('DELETE FROM projects WHERE id = $1', { bind: [req.params.id] });
    res.json({ message: 'Project deleted' });
  } catch (error) {
    next(error);
  }
});

// POST /api/projects/:id/push - Git add, commit, pull, push
// Always pushes to the dedicated `ai_scope` branch — never to the project's main
// branch — so AI-generated edits land in a review/staging branch the user
// promotes to dev/main on their own. If `ai_scope` doesn't exist locally yet, we
// create it from the current HEAD; if it doesn't exist on the remote yet, we
// skip the rebase-pull and push with -u to publish it.
const PUSH_BRANCH = 'ai_scope';
router.post('/:id/push', authenticateToken, requireRole('admin'), async (req, res, next) => {
  try {
    const [projects] = await sequelize.query('SELECT * FROM projects WHERE id = $1', { bind: [req.params.id] });
    if (!projects.length) return res.status(404).json({ error: 'Project not found' });
    const project = projects[0];
    const { commit_message, git_token } = req.body;

    const git = simpleGit(project.local_path);

    if (git_token) {
      const remoteUrl = project.repo_url.replace('https://', `https://oauth2:${git_token}@`);
      await git.remote(['set-url', 'origin', remoteUrl]);
    }

    // Make sure we're on `ai_scope` locally — checkout if it exists, branch from
    // current HEAD if it doesn't. Stash uncommitted changes first so checkout
    // doesn't fail.
    const branches = await git.branchLocal();
    if (branches.current !== PUSH_BRANCH) {
      // Save in-progress edits, switch branches, restore.
      const status = await git.status();
      const dirty = status.files.length > 0;
      if (dirty) await git.stash(['push', '-u', '-m', 'ai-sdlc-autoswitch']);
      if (branches.all.includes(PUSH_BRANCH)) {
        await git.checkout(PUSH_BRANCH);
      } else {
        await git.checkoutLocalBranch(PUSH_BRANCH);
      }
      if (dirty) {
        try { await git.stash(['pop']); } catch { /* nothing to pop / merge handled below */ }
      }
    }

    await git.add('.');
    // Allow commit to no-op if there's nothing to commit (e.g. retry after a network blip)
    try { await git.commit(commit_message || 'AI SDLC: push changes'); } catch (e) {
      if (!/nothing to commit/i.test(e.message || '')) throw e;
    }

    // Rebase against remote ai_scope only if it already exists — first push
    // is allowed to skip this since there's nothing to rebase against.
    await git.fetch('origin');
    const remoteBranches = (await git.branch(['-r'])).all;
    const remoteRef = `origin/${PUSH_BRANCH}`;
    if (remoteBranches.includes(remoteRef)) {
      await git.pull('origin', PUSH_BRANCH, { '--rebase': 'true' });
      await git.push('origin', PUSH_BRANCH);
    } else {
      await git.push(['-u', 'origin', PUSH_BRANCH]);
    }

    logger.info('Project pushed', { projectId: project.id, branch: PUSH_BRANCH });
    res.json({ message: `Pushed to ${PUSH_BRANCH}` });
  } catch (error) {
    logger.error('Push failed', { error: error.message });
    next(error);
  }
});

// POST /api/projects/:id/reset - Remove all uncommitted changes (git checkout .)
router.post('/:id/reset', authenticateToken, requireRole('admin'), async (req, res, next) => {
  try {
    const [projects] = await sequelize.query('SELECT * FROM projects WHERE id = $1', { bind: [req.params.id] });
    if (!projects.length) return res.status(404).json({ error: 'Project not found' });
    const project = projects[0];

    const fs = require('fs');
    if (!fs.existsSync(require('path').join(project.local_path, '.git'))) {
      return res.status(400).json({ error: 'Not a git repo — cannot reset. Use git init first or re-clone the project.' });
    }

    const git = simpleGit(project.local_path);
    await git.checkout(['.']);
    await git.clean('f', ['-d']);

    // Clear view cache
    const { exec: execChild } = require('child_process');
    await new Promise(resolve => execChild('php artisan view:clear', { cwd: project.local_path }, () => resolve()));

    logger.info('Project reset', { projectId: project.id });
    res.json({ message: 'All changes removed' });
  } catch (error) {
    logger.error('Reset failed', { error: error.message });
    next(error);
  }
});

// ── Chat persistence ──────────────────────────────────────────────────────
// One persistent thread per (user, project). Newest at the bottom; client
// loads the last N on mount and paginates upward via `?before=<id>`.

// POST /api/projects/:id/chat-messages
// Body: { role: 'user'|'ai', text, type?, data?, change_request_id? }
router.post('/:id/chat-messages', authenticateToken, async (req, res, next) => {
  try {
    const { role, text, type, data, change_request_id } = req.body || {};
    if (role !== 'user' && role !== 'ai') return res.status(400).json({ error: 'role must be user or ai' });
    const [rows] = await sequelize.query(
      `INSERT INTO chat_messages (user_id, project_id, role, text, type, data, change_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, project_id, role, text, type, data, change_request_id, created_at`,
      { bind: [req.user.id, req.params.id, role, text || null, type || 'text', data ? JSON.stringify(data) : null, change_request_id || null] }
    );
    res.json(rows[0]);
  } catch (error) { next(error); }
});

// GET /api/projects/:id/chat-messages?before=<id>&limit=100
// Returns the newest `limit` messages older than `before` (or absolute newest
// when `before` is omitted), ordered ASC for direct rendering.
//
// Each user has their OWN per-project thread — never shared. Admins do NOT
// see editors' messages here, because acting as another user requires
// impersonation (which swaps the JWT to that user's identity, so the same
// filter naturally returns the impersonated user's thread).
router.get('/:id/chat-messages', authenticateToken, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const before = req.query.before ? parseInt(req.query.before, 10) : null;

    const params = [req.params.id, req.user.id];
    const where = ['project_id = $1', 'user_id = $2'];
    if (Number.isFinite(before) && before > 0) {
      params.push(before);
      where.push(`id < $${params.length}`);
    }
    params.push(limit);

    // Pull newest-first by id (created_at can collide on bulk inserts), then
    // reverse to oldest-first for client rendering. `has_more` = whether the
    // next page exists, so the client knows when to stop loading older.
    const [rows] = await sequelize.query(
      `SELECT id, user_id, project_id, role, text, type, data, change_request_id, created_at
         FROM chat_messages
        WHERE ${where.join(' AND ')}
        ORDER BY id DESC
        LIMIT $${params.length}`,
      { bind: params }
    );
    res.json({
      messages: rows.slice().reverse(),
      has_more: rows.length === limit,
      oldest_id: rows.length ? rows[rows.length - 1].id : null,
    });
  } catch (error) { next(error); }
});

module.exports = router;
