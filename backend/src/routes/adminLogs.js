// /api/admin/request-logs — admin-only telemetry browser endpoints.
//
// Three endpoints:
//   GET /                — paginated list with filters
//   GET /metrics         — aggregate stats over a time range
//   GET /:id             — full row including events timeline + per-call detail
//                          + the generated_code rows for that change request
//
// All endpoints require role='admin'. Cursor pagination uses (created_at, id)
// to match the existing chat / change-history pattern.

const express = require('express');
const { sequelize } = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticateToken, requireRole('admin'));

// GET /api/admin/request-logs
//
// Query params (all optional):
//   status            comma-separated list, e.g. "review,failed"
//   user_id           filter to one user
//   project_id        filter to one project
//   min_duration_ms   only rows whose duration is >= this
//   errors_only       1/true → only rows with error_category populated
//   before            ISO timestamp cursor; return rows older than this
//   limit             1..200 (default 50)
//
// Returns: { logs: [...], has_more, oldest_created_at }
router.get('/', async (req, res, next) => {
  try {
    const params = [];
    const where = ['1=1'];

    if (req.query.status) {
      const list = String(req.query.status).split(',').map(s => s.trim()).filter(Boolean);
      if (list.length) {
        params.push(list);
        where.push(`rl.status = ANY($${params.length})`);
      }
    }
    if (req.query.user_id) {
      params.push(parseInt(req.query.user_id, 10));
      where.push(`rl.user_id = $${params.length}`);
    }
    if (req.query.project_id) {
      params.push(req.query.project_id);
      where.push(`rl.project_id = $${params.length}`);
    }
    if (req.query.min_duration_ms) {
      params.push(parseInt(req.query.min_duration_ms, 10));
      where.push(`rl.duration_ms >= $${params.length}`);
    }
    if (req.query.errors_only === '1' || req.query.errors_only === 'true') {
      where.push(`rl.error_category IS NOT NULL`);
    }
    if (req.query.before) {
      params.push(req.query.before);
      where.push(`rl.created_at < $${params.length}`);
    }

    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    params.push(limit + 1);  // fetch one extra to detect has_more

    // No JSONB columns (events / phase_breakdown / ai_calls_detail) in the
    // list response — keeps the payload small. Detail endpoint serves them.
    const [rows] = await sequelize.query(
      `SELECT rl.id, rl.change_request_id, rl.user_id, rl.project_id, rl.status,
              rl.pipeline, rl.duration_ms, rl.ai_calls, rl.retries,
              rl.input_tokens, rl.output_tokens, rl.cache_read_tokens, rl.cache_create_tokens,
              rl.files_touched, rl.error_category, rl.error_message, rl.created_at,
              cr.title AS change_title, cr.prompt AS change_prompt,
              u.email AS user_email, u.name AS user_name,
              p.display_name AS project_name
         FROM request_logs rl
    LEFT JOIN change_requests cr ON cr.id = rl.change_request_id
    LEFT JOIN users u ON u.id = rl.user_id
    LEFT JOIN projects p ON p.id = rl.project_id
        WHERE ${where.join(' AND ')}
     ORDER BY rl.created_at DESC, rl.id DESC
        LIMIT $${params.length}`,
      { bind: params }
    );

    const hasMore = rows.length > limit;
    const logs = hasMore ? rows.slice(0, limit) : rows;
    res.json({
      logs,
      has_more: hasMore,
      oldest_created_at: logs.length ? logs[logs.length - 1].created_at : null,
    });
  } catch (e) { next(e); }
});

// GET /api/admin/request-logs/metrics?range=24h|7d
// Single SQL aggregating success rate, percentiles, totals, and the top 5
// error categories. NOTE: must be defined BEFORE the /:id route so the
// "metrics" string isn't captured as an :id.
router.get('/metrics', async (req, res, next) => {
  try {
    const range = req.query.range === '7d' ? '7 days' : '24 hours';
    const [agg] = await sequelize.query(
      `SELECT
         COUNT(*)::int AS total,
         SUM(CASE WHEN status IN ('review','pending_review') THEN 1 ELSE 0 END)::int AS successes,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failures,
         COALESCE(percentile_cont(0.5)  WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p50_ms,
         COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms,
         COALESCE(SUM(input_tokens), 0)::bigint        AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0)::bigint       AS total_output_tokens,
         COALESCE(SUM(cache_read_tokens), 0)::bigint   AS total_cache_read_tokens,
         COALESCE(SUM(cache_create_tokens), 0)::bigint AS total_cache_create_tokens
       FROM request_logs
      WHERE created_at >= NOW() - INTERVAL '${range}'`
    );
    const [topErrors] = await sequelize.query(
      `SELECT error_category, COUNT(*)::int AS count
         FROM request_logs
        WHERE created_at >= NOW() - INTERVAL '${range}' AND error_category IS NOT NULL
     GROUP BY error_category
     ORDER BY count DESC
        LIMIT 5`
    );
    const a = agg[0] || {};
    const total = a.total || 0;
    res.json({
      range,
      total,
      successes: a.successes || 0,
      failures: a.failures || 0,
      success_rate: total > 0 ? +((a.successes || 0) / total * 100).toFixed(1) : null,
      p50_ms: a.p50_ms || 0,
      p95_ms: a.p95_ms || 0,
      total_input_tokens: Number(a.total_input_tokens || 0),
      total_output_tokens: Number(a.total_output_tokens || 0),
      total_cache_read_tokens: Number(a.total_cache_read_tokens || 0),
      total_cache_create_tokens: Number(a.total_cache_create_tokens || 0),
      top_errors: topErrors,
    });
  } catch (e) { next(e); }
});

// GET /api/admin/request-logs/:id
// Full record including the JSONB timeline, phase breakdown, per-call detail,
// and the joined generated_code rows so the detail page can render the file
// changes without a second round trip.
router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT rl.*, cr.title AS change_title, cr.prompt AS change_prompt,
              cr.category AS change_category,
              u.email AS user_email, u.name AS user_name, u.role AS user_role,
              p.display_name AS project_name
         FROM request_logs rl
    LEFT JOIN change_requests cr ON cr.id = rl.change_request_id
    LEFT JOIN users u ON u.id = rl.user_id
    LEFT JOIN projects p ON p.id = rl.project_id
        WHERE rl.id = $1`,
      { bind: [req.params.id] }
    );
    if (!rows.length) return res.status(404).json({ error: 'request log not found' });

    const log = rows[0];
    const [files] = await sequelize.query(
      `SELECT file_path, change_type, diff
         FROM generated_code
        WHERE change_request_id = $1
     ORDER BY id ASC`,
      { bind: [log.change_request_id] }
    );
    log.generated_code = files;
    res.json(log);
  } catch (e) { next(e); }
});

module.exports = router;
