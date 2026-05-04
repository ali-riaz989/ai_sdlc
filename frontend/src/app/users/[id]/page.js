'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

// Per-user activity feed.
//   - Admin can open any user's page; sees Restore on every change.
//   - Editor can open only their own page (server enforces 403 otherwise);
//     sees Restore only on their own changes (which is all of them, since
//     this page only lists requests they made).
// Pagination: scroll-to-bottom loads the next 100 older changes.
export default function UserDetailPage() {
  const { user: viewer, loading: authLoading, logout } = useAuth();
  const router = useRouter();
  const { id } = useParams();
  const targetId = parseInt(id, 10);

  const [target, setTarget] = useState(null);
  const [requests, setRequests] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [oldest, setOldest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [restoring, setRestoring] = useState(null); // requestId being restored
  const [restored, setRestored] = useState(() => new Set());
  const [expanded, setExpanded] = useState(() => new Set());
  const [error, setError] = useState(null);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, reqRes] = await Promise.all([
        apiClient.listUsers().catch(() => ({ data: [] })),
        apiClient.listUserChangeRequests(targetId, { limit: 100 }),
      ]);
      const found = (usersRes.data || []).find(u => u.id === targetId);
      setTarget(found || { id: targetId, name: `User #${targetId}`, email: '', role: '' });
      setRequests(reqRes.data?.requests || []);
      setHasMore(!!reqRes.data?.has_more);
      setOldest(reqRes.data?.oldest_created_at || null);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, [targetId]);

  useEffect(() => {
    if (authLoading) return;
    if (!viewer) { router.replace('/login'); return; }
    // Editors may only view their own page; server enforces this too.
    if (viewer.role !== 'admin' && viewer.id !== targetId) { router.replace('/'); return; }
    loadFirstPage();
  }, [authLoading, viewer, targetId, router, loadFirstPage]);

  async function loadMore() {
    if (loadingMore || !hasMore || !oldest) return;
    setLoadingMore(true);
    try {
      const res = await apiClient.listUserChangeRequests(targetId, { before: oldest, limit: 100 });
      const more = res.data?.requests || [];
      setRequests(prev => [...prev, ...more]);
      setHasMore(!!res.data?.has_more);
      setOldest(res.data?.oldest_created_at || oldest);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleRestore(reqId) {
    if (restored.has(reqId) || restoring) return;
    if (!confirm('Restore the files this change modified to their pre-edit state?')) return;
    setRestoring(reqId);
    try {
      await apiClient.restoreChangeRequest(reqId);
      setRestored(prev => { const n = new Set(prev); n.add(reqId); return n; });
    } catch (err) {
      alert(err.response?.data?.error || err.message);
    } finally {
      setRestoring(null);
    }
  }

  function toggleExpand(reqId) {
    setExpanded(prev => { const n = new Set(prev); n.has(reqId) ? n.delete(reqId) : n.add(reqId); return n; });
  }

  if (authLoading || !viewer) return null;

  // Restore button visible if viewer is admin OR this is their own change.
  // Since this page only ever shows the target user's changes, the per-row
  // ownership check simplifies to "viewer is target or viewer is admin".
  const canRestore = (cr) => viewer.role === 'admin' || cr.user_id === viewer.id;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-900">AI SDLC Platform</h1>
          <div className="flex items-center gap-4">
            <a href="/" className="text-sm text-gray-600 hover:text-gray-900">Dashboard</a>
            {viewer.role === 'admin' && (
              <a href="/users" className="text-sm text-gray-600 hover:text-gray-900">Users</a>
            )}
            <span className="text-sm text-gray-500">{viewer.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 hover:text-gray-900">Logout</button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        <div className="mb-2 text-sm">
          {viewer.role === 'admin' && <a href="/users" className="text-blue-600 hover:underline">← All users</a>}
        </div>

        <div className="mb-6">
          <h2 className="text-2xl font-bold text-gray-900">{target?.name || '…'}</h2>
          <p className="text-gray-500 text-sm mt-1">
            {target?.email}{' '}
            {target?.role && (
              <span className={`ml-2 text-[11px] px-2 py-0.5 rounded-full font-medium ${
                target.role === 'admin' ? 'bg-purple-100 text-purple-800' : 'bg-gray-100 text-gray-700'
              }`}>{target.role}</span>
            )}
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>
        )}

        {loading ? (
          <div className="text-center text-gray-500 py-12 text-sm">Loading…</div>
        ) : requests.length === 0 ? (
          <div className="text-center text-gray-500 py-12 text-sm">No change requests yet.</div>
        ) : (
          <div className="space-y-3">
            {requests.map(cr => {
              const isExpanded = expanded.has(cr.id);
              const isRestored = restored.has(cr.id);
              const isThisRestoring = restoring === cr.id;
              const hasFiles = (cr.files || []).length > 0;
              return (
                <div key={cr.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                          cr.status === 'review' ? 'bg-emerald-100 text-emerald-700' :
                          cr.status === 'rejected' ? 'bg-gray-200 text-gray-600' :
                          cr.status === 'failed' ? 'bg-red-100 text-red-700' :
                          'bg-blue-100 text-blue-700'
                        }`}>{cr.status}</span>
                        <a href={`/projects/${cr.project_id}`} className="text-[11px] text-gray-500 hover:text-blue-600 font-mono truncate">
                          {cr.project_name || cr.project_id}
                        </a>
                        <span className="text-[11px] text-gray-400">·</span>
                        <span className="text-[11px] text-gray-500">{new Date(cr.created_at).toLocaleString()}</span>
                      </div>
                      <div className="text-sm text-gray-900 truncate">{cr.title || cr.prompt}</div>
                      {cr.title && cr.prompt && cr.title !== cr.prompt && (
                        <div className="text-xs text-gray-500 truncate mt-0.5">{cr.prompt}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {hasFiles && (
                        <button onClick={() => toggleExpand(cr.id)}
                          className="text-[11px] text-gray-600 hover:text-gray-900 px-2 py-1 rounded-md border border-gray-200 hover:bg-gray-50">
                          {isExpanded ? 'Hide' : `Files (${cr.files.length})`}
                        </button>
                      )}
                      {canRestore(cr) && cr.status === 'review' && !isRestored && (
                        <button onClick={() => handleRestore(cr.id)}
                          disabled={isThisRestoring}
                          className="text-[11px] text-gray-700 hover:text-red-600 px-2 py-1 rounded-md border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
                          {isThisRestoring ? 'Restoring…' : 'Restore'}
                        </button>
                      )}
                      {isRestored && (
                        <span className="text-[11px] text-emerald-600 px-2 py-1">Restored ✓</span>
                      )}
                    </div>
                  </div>

                  {isExpanded && hasFiles && (
                    <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 space-y-2">
                      {cr.files.map((f, idx) => (
                        <div key={`${cr.id}-${idx}`} className="text-xs">
                          <div className="font-mono text-gray-800 mb-1 break-all">{f.file_path}</div>
                          {f.diff?.old_block && (
                            <pre className="bg-red-50/60 text-red-800 px-2 py-1 rounded whitespace-pre-wrap break-all max-h-32 overflow-auto leading-relaxed">
{f.diff.old_block.split('\n').slice(0, 8).map(l => '- ' + l).join('\n')}{f.diff.old_block.split('\n').length > 8 ? '\n…' : ''}
                            </pre>
                          )}
                          {f.diff?.new_block && (
                            <pre className="bg-emerald-50/60 text-emerald-800 px-2 py-1 rounded whitespace-pre-wrap break-all max-h-32 overflow-auto leading-relaxed mt-1">
{f.diff.new_block.split('\n').slice(0, 8).map(l => '+ ' + l).join('\n')}{f.diff.new_block.split('\n').length > 8 ? '\n…' : ''}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {hasMore && (
              <div className="text-center pt-2">
                <button onClick={loadMore} disabled={loadingMore}
                  className="text-sm text-blue-600 hover:text-blue-800 disabled:opacity-50">
                  {loadingMore ? 'Loading…' : 'Load older'}
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
