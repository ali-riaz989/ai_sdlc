'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { apiClient } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

// Per-request detail view: header summary, phase breakdown bar chart, full
// event timeline, and the list of files touched. All data loaded in one
// round-trip from GET /api/admin/request-logs/:id.

function fmtMs(ms)   { return ms == null ? '—' : (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`); }
function fmtNum(n)   { return n == null ? '—' : (n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n)); }
function fmtDate(s)  { return s ? new Date(s).toLocaleString() : '—'; }

const KIND_ICON = {
  start: '▶',
  pipeline: '⚙',
  phase_begin: '⏵',
  phase_end: '⏸',
  ai_call: '🤖',
  reasoning: '💭',
  file_change: '📄',
  retry: '↻',
  error: '⚠',
  end: '⏹',
};

export default function LogDetailPage() {
  const { user, loading: authLoading, logout } = useAuth();
  const router = useRouter();
  const { id } = useParams();
  const [log, setLog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedEvents, setExpandedEvents] = useState(() => new Set());

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiClient.getRequestLog(id);
      setLog(res.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.replace('/login'); return; }
    if (user.role !== 'admin') { router.replace('/'); return; }
    load();
  }, [authLoading, user, router, load]);

  function toggleEvent(idx) {
    setExpandedEvents(prev => { const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n; });
  }

  if (authLoading || !user) return null;
  if (loading) return <Shell user={user} logout={logout}><div className="text-center text-gray-500 py-12 text-sm">Loading…</div></Shell>;
  if (error)   return <Shell user={user} logout={logout}><div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div></Shell>;
  if (!log)    return null;

  // Phase breakdown — sort longest first so eyes go to slow ones
  const phaseEntries = Object.entries(log.phase_breakdown || {}).sort((a, b) => b[1] - a[1]);
  const phaseTotal = phaseEntries.reduce((s, [, ms]) => s + ms, 0);

  const events = Array.isArray(log.events) ? log.events : [];
  const cacheTotal = (log.cache_read_tokens || 0) + (log.cache_create_tokens || 0);
  const cacheHit = cacheTotal > 0 ? Math.round((log.cache_read_tokens || 0) / cacheTotal * 100) : null;
  const totalTokens = (log.input_tokens || 0) + (log.output_tokens || 0);

  return (
    <Shell user={user} logout={logout}>
      <div className="mb-3 text-sm">
        <a href="/admin/logs" className="text-blue-600 hover:underline">← All logs</a>
      </div>

      {/* Header */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${STATUS_PILL[log.status] || 'bg-gray-100 text-gray-700'}`}>{log.status}</span>
              {log.error_category && <span className="text-[11px] text-red-700">{log.error_category}</span>}
              <span className="text-[11px] text-gray-500 font-mono">{log.pipeline || '—'}</span>
            </div>
            <h2 className="text-lg font-semibold text-gray-900 break-words">{log.change_title || log.change_prompt || 'Untitled'}</h2>
            {log.change_prompt && log.change_prompt !== log.change_title && (
              <p className="text-sm text-gray-700 mt-1 break-words whitespace-pre-wrap">{log.change_prompt}</p>
            )}
            <p className="text-xs text-gray-500 mt-2">
              <span title={log.user_email}>{log.user_email || `User #${log.user_id || '?'}`}</span> · {log.project_name || log.project_id || '—'} · {fmtDate(log.created_at)}
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <Stat label="Duration"  value={fmtMs(log.duration_ms)} />
            <Stat label="AI calls"  value={log.ai_calls || 0} sub={log.retries ? `+${log.retries} retries` : null} />
            <Stat label="Tokens"    value={fmtNum(totalTokens)} sub={log.output_tokens ? `out ${fmtNum(log.output_tokens)}` : null} />
            <Stat label="Cache hit" value={cacheHit != null ? `${cacheHit}%` : '—'} sub={cacheHit != null ? `${fmtNum(log.cache_read_tokens)} read` : null} />
          </div>
        </div>
        {log.error_message && (
          <div className="mt-3 p-3 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{log.error_message}</div>
        )}
        {log.reasoning && !log.error_message && (
          <div className="mt-3 p-3 bg-amber-50 border border-amber-200 text-amber-900 rounded text-sm">
            <div className="text-[10px] text-amber-700 uppercase tracking-wide mb-0.5">AI reasoning</div>
            <div className="whitespace-pre-wrap">{log.reasoning}</div>
          </div>
        )}
      </div>

      {/* Phase breakdown */}
      {phaseEntries.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
          <div className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">Phase breakdown</div>
          <div className="space-y-1.5">
            {phaseEntries.map(([phase, ms]) => {
              const pct = phaseTotal > 0 ? (ms / phaseTotal) * 100 : 0;
              return (
                <div key={phase} className="flex items-center gap-2 text-xs">
                  <div className="w-28 text-gray-700 font-mono truncate">{phase}</div>
                  <div className="flex-1 bg-gray-100 rounded h-3 overflow-hidden">
                    <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="w-20 text-right text-gray-700 tabular-nums">{fmtMs(ms)}</div>
                </div>
              );
            })}
          </div>
          <div className="text-[10px] text-gray-500 mt-2">Sum of timed phases: {fmtMs(phaseTotal)} (of {fmtMs(log.duration_ms)} total)</div>
        </div>
      )}

      {/* Timeline */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">Timeline ({events.length} events)</div>
        {events.length === 0 ? (
          <div className="text-xs text-gray-500">No events recorded.</div>
        ) : (
          <div className="space-y-0.5 font-mono text-[11.5px]">
            {events.map((e, idx) => {
              const expandable = e.kind === 'ai_call' || e.kind === 'reasoning' || e.kind === 'error';
              const expanded = expandedEvents.has(idx);
              return (
                <div key={idx}>
                  <div onClick={expandable ? () => toggleEvent(idx) : undefined}
                    className={`flex items-start gap-2 px-2 py-1 rounded ${expandable ? 'cursor-pointer hover:bg-gray-50' : ''} ${e.kind === 'error' ? 'bg-red-50/50' : ''}`}>
                    <span className="w-16 text-right tabular-nums text-gray-400">+{e.t_offset_ms}ms</span>
                    <span className="w-5 text-center">{KIND_ICON[e.kind] || '·'}</span>
                    <span className="flex-1 break-all">
                      <EventSummary event={e} />
                    </span>
                    {expandable && <span className="text-gray-400 text-[10px]">{expanded ? '▼' : '▶'}</span>}
                  </div>
                  {expanded && expandable && (
                    <pre className="ml-24 mr-2 my-1 p-2 bg-gray-50 border border-gray-200 rounded text-[10.5px] whitespace-pre-wrap break-all">
                      {JSON.stringify(e, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Files touched */}
      {Array.isArray(log.generated_code) && log.generated_code.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
          <div className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">
            Files touched ({log.generated_code.length})
          </div>
          <div className="space-y-1">
            {log.generated_code.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">{f.change_type}</span>
                <span className="font-mono text-gray-800 truncate flex-1">{f.file_path}</span>
                {f.diff?.reasoning && <span className="text-gray-500 truncate max-w-[40%]" title={f.diff.reasoning}>{f.diff.reasoning}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-AI-call detail */}
      {Array.isArray(log.ai_calls_detail) && log.ai_calls_detail.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">AI calls ({log.ai_calls_detail.length})</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase text-gray-500">
                <tr>
                  <th className="text-left py-1">Function</th>
                  <th className="text-left py-1">Model</th>
                  <th className="text-right py-1">Duration</th>
                  <th className="text-right py-1">Input</th>
                  <th className="text-right py-1">Output</th>
                  <th className="text-right py-1">Cache read</th>
                  <th className="text-right py-1">Cache create</th>
                  <th className="text-right py-1">Attempt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {log.ai_calls_detail.map((c, i) => (
                  <tr key={i}>
                    <td className="py-1 font-mono">{c.fn}</td>
                    <td className="py-1 font-mono text-gray-600">{c.model}</td>
                    <td className="py-1 text-right tabular-nums">{fmtMs(c.ms)}</td>
                    <td className="py-1 text-right tabular-nums">{fmtNum(c.input)}</td>
                    <td className="py-1 text-right tabular-nums">{fmtNum(c.output)}</td>
                    <td className="py-1 text-right tabular-nums text-emerald-700">{fmtNum(c.cache_read)}</td>
                    <td className="py-1 text-right tabular-nums text-amber-700">{fmtNum(c.cache_create)}</td>
                    <td className="py-1 text-right tabular-nums">{c.attempt || 1}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Shell>
  );
}

const STATUS_PILL = {
  review:        'bg-emerald-100 text-emerald-700',
  pending_review:'bg-emerald-100 text-emerald-700',
  failed:        'bg-red-100 text-red-700',
  rejected:      'bg-gray-200 text-gray-600',
  pending:       'bg-amber-100 text-amber-700',
  analyzing:     'bg-blue-100 text-blue-700',
  generating_code:'bg-blue-100 text-blue-700',
};

function Stat({ label, value, sub }) {
  return (
    <div className="text-left">
      <div className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-base font-semibold text-gray-900">{value}</div>
      {sub && <div className="text-[10px] text-gray-500">{sub}</div>}
    </div>
  );
}

function EventSummary({ event: e }) {
  switch (e.kind) {
    case 'start':       return <span>request started</span>;
    case 'pipeline':    return <span>pipeline: <strong>{e.pipeline}</strong></span>;
    case 'phase_begin': return <span>phase begin: <strong>{e.phase}</strong></span>;
    case 'phase_end':   return <span>phase end: <strong>{e.phase}</strong> ({fmtMs(e.ms)})</span>;
    case 'ai_call':     return (
      <span>
        <strong>{e.fn}</strong> · {e.model} · {fmtMs(e.ms)}
        <span className="text-gray-500 ml-1">in {fmtNum(e.input)} / out {fmtNum(e.output)}</span>
        {e.cache_read ? <span className="text-emerald-700 ml-1">cache {fmtNum(e.cache_read)}</span> : null}
      </span>
    );
    case 'reasoning':   return <span className="text-gray-700">reasoning: "{(e.text || '').slice(0, 140)}{(e.text || '').length > 140 ? '…' : ''}"</span>;
    case 'file_change': return <span>{e.op}: <span className="text-gray-800">{e.path}</span> ({fmtNum(e.bytes)}B)</span>;
    case 'retry':       return <span className="text-amber-700">retry: {e.reason}</span>;
    case 'error':       return <span className="text-red-700">error [{e.category}]: {(e.message || '').slice(0, 200)}</span>;
    case 'end':         return <span>request end · status {e.status}</span>;
    default:            return <span>{e.kind}</span>;
  }
}

function Shell({ children, user, logout }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-900">THE PARKLANE CANVAS</h1>
          <div className="flex items-center gap-4">
            <a href="/" className="text-sm text-gray-600 hover:text-gray-900">Dashboard</a>
            <a href="/users" className="text-sm text-gray-600 hover:text-gray-900">Users</a>
            <a href="/admin/logs" className="text-sm font-medium text-blue-600">Logs</a>
            <span className="text-sm text-gray-500">{user.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 hover:text-gray-900">Logout</button>
          </div>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
