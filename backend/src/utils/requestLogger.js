// Per-change-request structured telemetry aggregator.
//
// Holds an in-memory ctx for each in-flight change_request, accumulates events
// and counters as the pipeline progresses, then performs a SINGLE upsert into
// the `request_logs` table at commit() time. The admin "/admin/logs" UI reads
// from that table.
//
// Design constraints:
//   • Never throw out — telemetry must never break the AI pipeline.
//   • Single DB write per request (commit) so we don't multiply IO load.
//   • Soft cap on event count so a runaway loop can't OOM the process.
//   • Winston logging stays unchanged — this is an ADDITIONAL store, not a
//     replacement.

const { sequelize } = require('../config/database');
const logger = require('./logger');

const MAX_EVENTS = 5000;
const ctxs = new Map();      // requestId → ctx

function getCtx(requestId) {
  return requestId ? ctxs.get(requestId) : null;
}

function pushEvent(ctx, event) {
  if (!ctx) return;
  if (ctx.events.length >= MAX_EVENTS) return;       // cap; drop further events silently
  event.t_offset_ms = Date.now() - ctx.t_start;
  ctx.events.push(event);
}

// Map a free-form failure message to one of the structured error_category
// buckets. Mirrors the strings the SDK / AI service / controller already emit.
function categoriseError(messageOrErr) {
  const m = String(messageOrErr?.message || messageOrErr || '').toLowerCase();
  if (!m) return 'unknown';
  if (m.includes('rate_limit') || m.includes('429') || m.includes('rate limit')) return 'rate_limit';
  if (m.includes('econn') || m.includes('enotfound') || m.includes('socket hang up') || m.includes('connection') || m.includes('timeout') || m.includes('etimedout')) return 'connection';
  if (m.includes('invalid json') || m.includes('unexpected token') || m.includes('json.parse')) return 'invalid_json';
  if (m.includes('could not find the laravel route') || m.includes('route_unresolved') || m.includes('route not found')) return 'route_unresolved';
  if (m.includes('ambiguous') || m.includes('clarif') || m.includes("couldn't pinpoint") || m.includes('appears more than once')) return 'ambiguous';
  if (m.includes('uniqueness') || m.includes('matched') && m.includes('locations')) return 'uniqueness_failed';
  return 'unknown';
}

const requestLogger = {
  // Open a new ctx. Idempotent — calling start() twice for the same id resets
  // the timer so a retry of the request doesn't accumulate stale events.
  start(requestId, { user_id = null, project_id = null } = {}) {
    if (!requestId) return;
    const ctx = {
      requestId,
      user_id,
      project_id,
      pipeline: null,
      t_start: Date.now(),
      ai_calls: 0,
      retries: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      files_touched: 0,
      error_category: null,
      error_message: null,
      reasoning: null,
      events: [],
      phase_breakdown: {},
      ai_calls_detail: [],
      _phase_starts: {},
    };
    ctxs.set(requestId, ctx);
    pushEvent(ctx, { kind: 'start' });
  },

  setPipeline(requestId, name) {
    const ctx = getCtx(requestId);
    if (!ctx) return;
    ctx.pipeline = name;
    pushEvent(ctx, { kind: 'pipeline', pipeline: name });
  },

  phaseBegin(requestId, phase) {
    const ctx = getCtx(requestId);
    if (!ctx) return;
    ctx._phase_starts[phase] = Date.now();
    pushEvent(ctx, { kind: 'phase_begin', phase });
  },

  phaseEnd(requestId, phase) {
    const ctx = getCtx(requestId);
    if (!ctx) return;
    const t0 = ctx._phase_starts[phase];
    if (t0 == null) return;
    const ms = Date.now() - t0;
    delete ctx._phase_starts[phase];
    ctx.phase_breakdown[phase] = (ctx.phase_breakdown[phase] || 0) + ms;
    pushEvent(ctx, { kind: 'phase_end', phase, ms });
  },

  // response is the raw Anthropic SDK response object — we read response.usage
  // for token counters. Safe if response is missing or shaped unexpectedly.
  recordAiCall(requestId, { fn, model, ms, response, attempt = 1 } = {}) {
    const ctx = getCtx(requestId);
    if (!ctx) return;
    const u = (response && response.usage) || {};
    const input = u.input_tokens || 0;
    const output = u.output_tokens || 0;
    const cache_read = u.cache_read_input_tokens || 0;
    const cache_create = u.cache_creation_input_tokens || 0;
    ctx.ai_calls += 1;
    ctx.input_tokens += input;
    ctx.output_tokens += output;
    ctx.cache_read_tokens += cache_read;
    ctx.cache_create_tokens += cache_create;
    ctx.ai_calls_detail.push({ fn, model, ms, input, output, cache_read, cache_create, attempt });
    pushEvent(ctx, { kind: 'ai_call', fn, model, ms, input, output, cache_read, cache_create, attempt });
  },

  recordReasoning(requestId, text) {
    const ctx = getCtx(requestId);
    if (!ctx || !text) return;
    ctx.reasoning = String(text);
    pushEvent(ctx, { kind: 'reasoning', text: String(text).substring(0, 500) });
  },

  recordFileChange(requestId, { path: filePath, op, bytes } = {}) {
    const ctx = getCtx(requestId);
    if (!ctx) return;
    ctx.files_touched += 1;
    pushEvent(ctx, { kind: 'file_change', path: filePath, op, bytes });
  },

  recordRetry(requestId, reason) {
    const ctx = getCtx(requestId);
    if (!ctx) return;
    ctx.retries += 1;
    pushEvent(ctx, { kind: 'retry', reason });
  },

  // err can be an Error, a string, or anything stringifiable. category
  // overrides the auto-detected one when caller knows better.
  recordError(requestId, err, category = null) {
    const ctx = getCtx(requestId);
    if (!ctx) return;
    const message = String(err?.message || err || 'unknown error');
    ctx.error_category = category || categoriseError(err) || 'unknown';
    ctx.error_message = message;
    pushEvent(ctx, { kind: 'error', category: ctx.error_category, message });
  },

  // Single upsert into request_logs, then drop the ctx. Wrapped in try/catch
  // so a DB hiccup never breaks the pipeline.
  async commit(requestId, { status } = {}) {
    const ctx = getCtx(requestId);
    if (!ctx) return;
    ctxs.delete(requestId);
    const duration_ms = Date.now() - ctx.t_start;
    pushEvent(ctx, { kind: 'end', status });
    try {
      await sequelize.query(
        `INSERT INTO request_logs (
           change_request_id, user_id, project_id, status, pipeline,
           duration_ms, ai_calls, retries,
           input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
           files_touched, error_category, error_message, reasoning,
           events, phase_breakdown, ai_calls_detail
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8,
           $9, $10, $11, $12,
           $13, $14, $15, $16,
           $17::jsonb, $18::jsonb, $19::jsonb
         )
         ON CONFLICT (change_request_id) DO UPDATE SET
           status = EXCLUDED.status,
           pipeline = EXCLUDED.pipeline,
           duration_ms = EXCLUDED.duration_ms,
           ai_calls = EXCLUDED.ai_calls,
           retries = EXCLUDED.retries,
           input_tokens = EXCLUDED.input_tokens,
           output_tokens = EXCLUDED.output_tokens,
           cache_read_tokens = EXCLUDED.cache_read_tokens,
           cache_create_tokens = EXCLUDED.cache_create_tokens,
           files_touched = EXCLUDED.files_touched,
           error_category = EXCLUDED.error_category,
           error_message = EXCLUDED.error_message,
           reasoning = EXCLUDED.reasoning,
           events = EXCLUDED.events,
           phase_breakdown = EXCLUDED.phase_breakdown,
           ai_calls_detail = EXCLUDED.ai_calls_detail`,
        { bind: [
          requestId, ctx.user_id, ctx.project_id, status || 'unknown', ctx.pipeline,
          duration_ms, ctx.ai_calls, ctx.retries,
          ctx.input_tokens, ctx.output_tokens, ctx.cache_read_tokens, ctx.cache_create_tokens,
          ctx.files_touched, ctx.error_category, ctx.error_message, ctx.reasoning,
          JSON.stringify(ctx.events), JSON.stringify(ctx.phase_breakdown), JSON.stringify(ctx.ai_calls_detail),
        ]}
      );
    } catch (e) {
      // Never bubble — we already lost the request ctx in memory; surface to
      // winston so we can spot persistence drops without breaking the user-facing flow.
      logger.warn('requestLogger.commit failed', { error: e.message, requestId });
    }
  },

  // Hard drop — used when the request was cancelled/timed-out and we don't
  // want a half-complete row.
  discard(requestId) {
    if (!requestId) return;
    ctxs.delete(requestId);
  },

  // Exposed for tests and ad-hoc inspection
  _ctxs: ctxs,
  _categoriseError: categoriseError,
};

module.exports = requestLogger;
