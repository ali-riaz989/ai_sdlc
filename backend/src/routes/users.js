// Users CRUD — admin-only. The frontend's "Users" tab consumes these endpoints
// to manage editor/admin accounts. Self-edits are restricted to non-role fields
// (admins can demote themselves only via another admin).

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { sequelize } = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const auditLogger = require('../utils/auditLogger');

const router = express.Router();

const ROLES = new Set(['admin', 'editor']);

// GET /api/users — list (admin only)
// Includes basic activity counters so the table can show last_active_at without
// a per-row N+1. Order: most-recently-active first.
router.get('/', authenticateToken, requireRole('admin'), async (req, res, next) => {
  try {
    const [rows] = await sequelize.query(`
      SELECT u.id, u.email, u.name, u.role, u.created_at,
             COALESCE(MAX(c.created_at), u.created_at) AS last_active_at,
             COUNT(c.id) AS change_request_count
        FROM users u
        LEFT JOIN change_requests c ON c.user_id = u.id
       GROUP BY u.id
       ORDER BY last_active_at DESC
    `);
    res.json(rows);
  } catch (error) { next(error); }
});

// POST /api/users — create (admin only)
// Body: { name, email, password, role }
router.post('/', authenticateToken, requireRole('admin'), async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    const finalRole = ROLES.has(role) ? role : 'editor';

    const [existing] = await sequelize.query('SELECT id FROM users WHERE email = $1', { bind: [email.toLowerCase().trim()] });
    if (existing.length) return res.status(409).json({ error: 'email already in use' });

    const hash = await bcrypt.hash(password, 10);
    const [rows] = await sequelize.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, role, created_at`,
      { bind: [email.toLowerCase().trim(), hash, name.trim(), finalRole] }
    );
    res.status(201).json(rows[0]);
  } catch (error) { next(error); }
});

// PATCH /api/users/:id — update (admin only)
// Body: any of { name, email, role, password } — only the present fields change.
// Guardrails:
//   • can't demote yourself if you're the only remaining admin
//   • can't delete yourself
//   • email collisions surface as 409
router.patch('/:id', authenticateToken, requireRole('admin'), async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'invalid id' });

    const { name, email, role, password } = req.body || {};
    const updates = [];
    const params = [];

    if (typeof name === 'string' && name.trim()) {
      params.push(name.trim());
      updates.push(`name = $${params.length}`);
    }
    if (typeof email === 'string' && email.trim()) {
      const cleanEmail = email.toLowerCase().trim();
      const [collide] = await sequelize.query('SELECT id FROM users WHERE email = $1 AND id <> $2', { bind: [cleanEmail, targetId] });
      if (collide.length) return res.status(409).json({ error: 'email already in use' });
      params.push(cleanEmail);
      updates.push(`email = $${params.length}`);
    }
    if (typeof role === 'string' && ROLES.has(role)) {
      // Block demoting the last remaining admin
      if (role !== 'admin' && req.user.id === targetId) {
        const [admins] = await sequelize.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'");
        if ((admins[0]?.n || 0) <= 1) return res.status(400).json({ error: 'cannot demote the last admin' });
      }
      params.push(role);
      updates.push(`role = $${params.length}`);
    }
    if (typeof password === 'string' && password.length > 0) {
      if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
      const hash = await bcrypt.hash(password, 10);
      params.push(hash);
      updates.push(`password_hash = $${params.length}`);
    }

    if (!updates.length) return res.status(400).json({ error: 'no fields to update' });

    params.push(targetId);
    const [rows] = await sequelize.query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length}
       RETURNING id, email, name, role, created_at, updated_at`,
      { bind: params }
    );
    if (!rows.length) return res.status(404).json({ error: 'user not found' });
    res.json(rows[0]);
  } catch (error) { next(error); }
});

// DELETE /api/users/:id — admin only, can't delete yourself
router.delete('/:id', authenticateToken, requireRole('admin'), async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'invalid id' });
    if (targetId === req.user.id) return res.status(400).json({ error: 'cannot delete yourself' });
    const [result] = await sequelize.query('DELETE FROM users WHERE id = $1 RETURNING id', { bind: [targetId] });
    if (!result.length) return res.status(404).json({ error: 'user not found' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// POST /api/users/:id/impersonate — admin only
// Returns a JWT scoped to the target user (so every existing endpoint that
// reads req.user gets the editor's identity for free — chat persistence,
// change-request attribution, restore ownership all "just work"). The token
// also carries `impersonated_by` so audit logs can see both identities.
//
// Frontend stores the admin's original token under `original_token` and
// swaps `token` → the new impersonation JWT. Stop = restore original.
router.post('/:id/impersonate', authenticateToken, requireRole('admin'), async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'invalid id' });
    if (targetId === req.user.id) return res.status(400).json({ error: 'cannot impersonate yourself' });

    const [rows] = await sequelize.query('SELECT id, email, name, role FROM users WHERE id = $1', { bind: [targetId] });
    if (!rows.length) return res.status(404).json({ error: 'user not found' });
    const target = rows[0];

    // Token mirrors the target user's identity; impersonated_by lets backend code
    // (and audit logs) tell apart "real editor X did this" vs "admin Y acting as X".
    // Shorter expiry than a normal login (4h) so a stale impersonation can't linger.
    const token = jwt.sign(
      { id: target.id, email: target.email, role: target.role, name: target.name, impersonated_by: req.user.id },
      process.env.JWT_SECRET,
      { expiresIn: '4h' }
    );

    await auditLogger.log({
      user_id: req.user.id,
      action: 'IMPERSONATE_START',
      entity_type: 'User',
      entity_id: target.id,
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
    }).catch(() => {});

    res.json({
      token,
      user: { id: target.id, email: target.email, name: target.name, role: target.role },
      impersonated_by: { id: req.user.id, name: req.user.name },
    });
  } catch (error) { next(error); }
});

// GET /api/users/:id/change-requests
// Per-user activity feed for the user-detail page.
//   • admin can read any user's history
//   • editor can read only their OWN history (used when an editor opens
//     /users/<self> from a future "my activity" link)
// Pagination: cursor-based via ?before=<created_at iso>&limit=N (default 100,
// max 500). Returns newest-first plus per-row file diffs (joined from
// generated_code) so the page can render expandable diff cards in one round-trip.
router.get('/:id/change-requests', authenticateToken, async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'invalid id' });
    if (req.user.role !== 'admin' && req.user.id !== targetId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const before = req.query.before || null;

    const params = [targetId];
    const where = ['cr.user_id = $1'];
    if (before) {
      params.push(before);
      where.push(`cr.created_at < $${params.length}`);
    }
    params.push(limit);

    const [rows] = await sequelize.query(
      `SELECT cr.id, cr.request_number, cr.project_id, cr.user_id, cr.title, cr.prompt,
              cr.category, cr.status, cr.priority, cr.error_message, cr.created_at, cr.updated_at,
              p.name AS project_name,
              COALESCE(json_agg(
                json_build_object(
                  'file_path',   gc.file_path,
                  'change_type', gc.change_type,
                  'diff',        gc.diff
                ) ORDER BY gc.id
              ) FILTER (WHERE gc.id IS NOT NULL), '[]'::json) AS files
         FROM change_requests cr
    LEFT JOIN projects p ON cr.project_id = p.id
    LEFT JOIN generated_code gc ON gc.change_request_id = cr.id
        WHERE ${where.join(' AND ')}
     GROUP BY cr.id, p.name
     ORDER BY cr.created_at DESC
        LIMIT $${params.length}`,
      { bind: params }
    );

    res.json({
      requests: rows,
      has_more: rows.length === limit,
      oldest_created_at: rows.length ? rows[rows.length - 1].created_at : null,
    });
  } catch (error) { next(error); }
});

module.exports = router;
