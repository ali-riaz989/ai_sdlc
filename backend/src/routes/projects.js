const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const simpleGit = require('simple-git');
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
    res.json(projects[0]);
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
    child.on('close', code => {
      clearInterval(heartbeat);
      code === 0 ? resolve() : reject(new Error(errBuf.trim()));
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

    await git.add('.');
    await git.commit(commit_message || 'AI SDLC: push changes');
    await git.pull('origin', project.repo_branch, { '--rebase': 'true' });
    await git.push('origin', project.repo_branch);

    logger.info('Project pushed', { projectId: project.id, branch: project.repo_branch });
    res.json({ message: `Pushed to ${project.repo_branch}` });
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

module.exports = router;
