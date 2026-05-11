'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

// Admin-only telemetry browser. Mirrors the chrome + table styling from
// /users so admins have a consistent UX across the management area.
//
// Layout:
//   - 24-hour metrics strip (4 cards) at the top
//   - Filters bar (status, errors-only, min duration, user, project, range)
//   - Table of request_logs rows; row click → /admin/logs/[id]
//   - Cursor pagination ("Load older" footer)

const STATUS_PILL = {
  review:        'bg-emerald-100 text-emerald-700',
  pending_review:'bg-emerald-100 text-emerald-700',
  failed:        'bg-red-100 text-red-700',
  rejected:      'bg-gray-200 text-gray-600',
  pending:       'bg-amber-100 text-amber-700',
  analyzing:     'bg-blue-100 text-blue-700',
  generating_code:'bg-blue-100 text-blue-700',
};

function relTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60)     return `${Math.floor(s)}s ago`;
  if (s < 3600)   return `${Math.floor(s/60)}m ago`;
  if (s < 86400)  return `${Math.floor(s/3600)}h ago`;
  if (s < 86400*7)return `${Math.floor(s/86400)}d ago`;
  return d.toLocaleDateString();
}

function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n/1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n/1000).toFixed(1) + 'k';
  return String(n);
}

export default function AdminLogsPage() {
  const { user, loading: authLoading, logout } = useAuth();
  const router = useRouter();

  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [oldest, setOldest] = useState(null);
  const [error, setError] = useState(null);
  const [metrics, setMetrics] = useState(null);

  // Filters
  const [fStatus, setFStatus] = useState('all');     // all | review | failed | rejected
  const [fErrorsOnly, setFErrorsOnly] = useState(false);
  const [fMinDuration, setFMinDuration] = useState(''); // ms (string for input)
  const [fUserId, setFUserId] = useState('');
  const [fProjectId, setFProjectId] = useState('');
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);

  const buildParams = useCallback((extra = {}) => {
    const p = {};
    if (fStatus !== 'all') p.status = fStatus;
    if (fErrorsOnly) p.errors_only = 1;
    if (fMinDuration) p.min_duration_ms = parseInt(fMinDuration, 10) || 0;
    if (fUserId) p.user_id = fUserId;
    if (fProjectId) p.project_id = fProjectId;
    return { ...p, ...extra };
  }, [fStatus, fErrorsOnly, fMinDuration, fUserId, fProjectId]);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    try {
      const [logsRes, metricsRes] = await Promise.all([
        apiClient.listRequestLogs({ ...buildParams(), limit: 50 }),
        apiClient.getAdminMetrics('24h').catch(() => ({ data: null })),
      ]);
      setLogs(logsRes.data?.logs || []);
      setHasMore(!!logsRes.data?.has_more);
      setOldest(logsRes.data?.oldest_created_at || null);
      setMetrics(metricsRes.data || null);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  // Auth gate + initial load
  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.replace('/login'); return; }
    if (user.role !== 'admin') { router.replace('/'); return; }

    // Lazily fetch the user/project filter dropdown content; failures just
    // leave them empty (the user can still type IDs manually if needed).
    apiClient.listUsers().then(r => setUsers(r.data || [])).catch(() => {});
    // No /api/projects/list-all here — we reuse what we have. The list view
    // comes from the projects table via the existing endpoint.
    apiClient.getProjects?.().then(r => setProjects(r.data || [])).catch(() => {});

    loadFirstPage();
  }, [authLoading, user, router, loadFirstPage]);

  async function loadMore() {
    if (loadingMore || !hasMore || !oldest) return;
    setLoadingMore(true);
    try {
      const res = await apiClient.listRequestLogs({ ...buildParams(), before: oldest, limit: 50 });
      const more = res.data?.logs || [];
      setLogs(prev => [...prev, ...more]);
      setHasMore(!!res.data?.has_more);
      setOldest(res.data?.oldest_created_at || oldest);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoadingMore(false);
    }
  }

  if (authLoading || !user) return null;
  if (user.role !== 'admin') return null;

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

      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Request logs</h2>
          <p className="text-gray-500 text-sm mt-1">Every change-request from the AI editor — timings, tokens, retries, errors. Click any row for the full event timeline.</p>
        </div>

        {/* 24h metrics strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <MetricCard label="Success rate (24h)" value={metrics ? (metrics.success_rate == null ? '—' : metrics.success_rate + '%') : '…'} sub={metrics ? `${metrics.successes}/${metrics.total}` : ''} />
          <MetricCard label="p95 duration (24h)" value={metrics ? `${(metrics.p95_ms / 1000).toFixed(1)}s` : '…'} sub={metrics ? `p50 ${(metrics.p50_ms / 1000).toFixed(1)}s` : ''} />
          <MetricCard label="Tokens (24h)" value={metrics ? fmtNum(metrics.total_input_tokens + metrics.total_output_tokens) : '…'} sub={metrics ? `cache hit ${fmtNum(metrics.total_cache_read_tokens)}` : ''} />
          <MetricCard label="Top error (24h)" value={metrics?.top_errors?.[0]?.error_category || (metrics ? '—' : '…')} sub={metrics?.top_errors?.[0] ? `${metrics.top_errors[0].count} times` : ''} />
        </div>

        {/* Filters */}
        <div className="bg-white border border-gray-200 rounded-xl p-3 mb-4 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-gray-700">
            Status
            <select value={fStatus} onChange={e => setFStatus(e.target.value)}
              className="px-2 py-1 border border-gray-300 rounded text-sm text-gray-900 bg-white">
              <option value="all">All</option>
              <option value="review,pending_review">Successful</option>
              <option value="failed">Failed</option>
              <option value="rejected">Rejected</option>
              <option value="pending,analyzing,generating_code">In flight</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-700">
            <input type="checkbox" checked={fErrorsOnly} onChange={e => setFErrorsOnly(e.target.checked)} />
            Errors only
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-700">
            Min duration (ms)
            <input type="number" value={fMinDuration} onChange={e => setFMinDuration(e.target.value)}
              placeholder="e.g. 5000"
              className="w-24 px-2 py-1 border border-gray-300 rounded text-sm text-gray-900 placeholder:text-gray-400 bg-white" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-700">
            User
            <select value={fUserId} onChange={e => setFUserId(e.target.value)}
              className="px-2 py-1 border border-gray-300 rounded text-sm text-gray-900 bg-white max-w-[180px]">
              <option value="">All</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.email}</option>)}
            </select>
          </label>
          {projects.length > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-gray-700">
              Project
              <select value={fProjectId} onChange={e => setFProjectId(e.target.value)}
                className="px-2 py-1 border border-gray-300 rounded text-sm text-gray-900 bg-white max-w-[200px]">
                <option value="">All</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.display_name || p.name}</option>)}
              </select>
            </label>
          )}
          <button onClick={loadFirstPage}
            className="ml-auto px-3 py-1 bg-gray-900 text-white rounded text-xs hover:opacity-90">
            Apply filters
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>
        )}

        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2 font-medium">When</th>
                <th className="text-left px-3 py-2 font-medium">User</th>
                <th className="text-left px-3 py-2 font-medium">Project</th>
                <th className="text-left px-3 py-2 font-medium">Prompt</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium">Pipeline</th>
                <th className="text-right px-3 py-2 font-medium">Dur</th>
                <th className="text-right px-3 py-2 font-medium">Calls</th>
                <th className="text-right px-3 py-2 font-medium">Tokens</th>
                <th className="text-right px-3 py-2 font-medium">Cache</th>
                <th className="text-right px-3 py-2 font-medium">Files</th>
                <th className="text-left px-3 py-2 font-medium">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan="12" className="text-center text-gray-500 py-12 text-sm">Loading…</td></tr>
              ) : logs.length === 0 ? (
                <tr><td colSpan="12" className="text-center text-gray-500 py-12 text-sm">No logs match these filters.</td></tr>
              ) : logs.map(l => {
                const total = (l.input_tokens || 0) + (l.output_tokens || 0);
                const cacheTotal = (l.cache_read_tokens || 0) + (l.cache_create_tokens || 0);
                const cacheHit = cacheTotal > 0 ? Math.round((l.cache_read_tokens || 0) / cacheTotal * 100) : null;
                const slow = (l.duration_ms || 0) > 5000;
                return (
                  <tr key={l.id} onClick={() => router.push(`/admin/logs/${l.id}`)}
                    className="hover:bg-gray-50 cursor-pointer">
                    <td className="px-3 py-2 text-xs text-gray-700 whitespace-nowrap" title={new Date(l.created_at).toLocaleString()}>{relTime(l.created_at)}</td>
                    <td className="px-3 py-2 text-xs text-gray-700 truncate max-w-[140px]" title={l.user_email}>{l.user_email || `User #${l.user_id || '?'}`}</td>
                    <td className="px-3 py-2 text-xs text-gray-700 truncate max-w-[120px]" title={l.project_name}>{l.project_name || '—'}</td>
                    <td className="px-3 py-2 text-xs text-gray-900 truncate max-w-[260px]" title={l.change_prompt || ''}>{l.change_title || l.change_prompt || '—'}</td>
                    <td className="px-3 py-2"><span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${STATUS_PILL[l.status] || 'bg-gray-100 text-gray-700'}`}>{l.status}</span></td>
                    <td className="px-3 py-2 text-xs text-gray-600 font-mono">{l.pipeline || '—'}</td>
                    <td className={`px-3 py-2 text-xs text-right tabular-nums ${slow ? 'text-red-600 font-semibold' : 'text-gray-700'}`}>{l.duration_ms != null ? `${(l.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                    <td className="px-3 py-2 text-xs text-right text-gray-700 tabular-nums">{l.ai_calls || 0}{l.retries ? <span className="text-amber-600 ml-0.5" title={`${l.retries} retries`}>+{l.retries}</span> : null}</td>
                    <td className="px-3 py-2 text-xs text-right text-gray-700 tabular-nums">{fmtNum(total)}</td>
                    <td className="px-3 py-2 text-xs text-right text-gray-600 tabular-nums">{cacheHit != null ? `${cacheHit}%` : '—'}</td>
                    <td className="px-3 py-2 text-xs text-right text-gray-700 tabular-nums">{l.files_touched || 0}</td>
                    <td className="px-3 py-2 text-xs">
                      {l.error_category ? <span className="text-red-700" title={l.error_message}>{l.error_category}</span> : <span className="text-gray-300">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {hasMore && (
          <div className="text-center pt-3">
            <button onClick={loadMore} disabled={loadingMore}
              className="text-sm text-blue-600 hover:text-blue-800 disabled:opacity-50">
              {loadingMore ? 'Loading…' : 'Load older'}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function MetricCard({ label, value, sub }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3">
      <div className="text-[11px] text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-xl font-semibold text-gray-900 mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}
