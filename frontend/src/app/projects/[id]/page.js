'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import socketClient from '@/lib/socket';
import { extractPageContext, applyDomUpdate } from '@/lib/domExtractor';
import { formatDistanceToNow } from 'date-fns';

const STATUS_LABELS = {
  pending:         'Queued',
  analyzing:       'Analyzing…',
  generating_code: 'Generating code…',
  staging:         'Deploying…',
  review:          'Ready for review',
  pending_review:  'Awaiting review',
  rejected:        'Rejected',
  failed:          'Failed'
};

const STATUS_COLORS = {
  pending:         'text-gray-500',
  analyzing:       'text-blue-600',
  generating_code: 'text-purple-600',
  staging:         'text-orange-500',
  review:          'text-green-600',
  pending_review:  'text-yellow-600',
  rejected:        'text-gray-500',
  failed:          'text-red-600'
};

export default function ProjectPreview() {
  const { id } = useParams();
  const router = useRouter();
  const { user, loading } = useAuth();

  const [project, setProject] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [image, setImage] = useState(null); // { base64, mediaType, preview }
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [files, setFiles] = useState([]); // { file, change_type, status }
  const [currentPageUrl, setCurrentPageUrl] = useState(null); // tracks which page is loaded in iframe
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pendingDiff, setPendingDiff] = useState(null);
  const [lastAppliedId, setLastAppliedId] = useState(null); // change request id of last applied change
  const [streamingTokens, setStreamingTokens] = useState('');
  const iframeRef = useRef(null);
  const fileInputRef = useRef(null);

  function loadImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target.result.split(',')[1];
      setImage({ base64, mediaType: file.type, preview: e.target.result });
    };
    reader.readAsDataURL(file);
  }

  function handlePaste(e) {
    const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'));
    if (item) loadImageFile(item.getAsFile());
  }

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [user, loading, router]);

  useEffect(() => {
    if (!id || !user) return;
    apiClient.getProject(id).then(res => setProject(res.data)).catch(() => router.replace('/'));

    // Restore Accept/Reject UI if a recent pending_review request exists (e.g. after page refresh)
    apiClient.listChangeRequests({ project_id: id, status: 'pending_review', limit: 1 })
      .then(res => {
        if (res.data.length > 0) {
          const cr = res.data[0];
          const ageMs = Date.now() - new Date(cr.updated_at || cr.created_at).getTime();
          if (ageMs < 10 * 60 * 1000) { // only if less than 10 min old
            setResult({ id: cr.id, status: 'pending_review', message: 'Preview applied — accept or reject' });
            setPendingDiff({ diff: [] });
          }
        }
      })
      .catch(() => {});
  }, [id, user]);

  // Load change history for this project
  useEffect(() => {
    if (!id || !user) return;
    apiClient.listChangeRequests({ project_id: id, status: 'review', limit: 20 })
      .then(res => setHistory(res.data))
      .catch(() => {});
  }, [id, user]);

  // Re-fetch history after a successful change
  useEffect(() => {
    if (result?.status === 'review' && id) {
      apiClient.listChangeRequests({ project_id: id, status: 'review', limit: 20 })
        .then(res => setHistory(res.data))
        .catch(() => {});
    }
  }, [result?.status]);


  function reloadIframe() {
    if (iframeRef.current) {
      const base = iframeRef.current.src.split('?')[0];
      iframeRef.current.src = base + '?_t=' + Date.now();
    }
  }

  async function applyChange() {
    if (!result?.id) return;
    try {
      await apiClient.applyChangeRequest(result.id);
      setPendingDiff(null);
      setStreamingTokens('');
      setResult(prev => ({ ...prev, status: 'review', message: 'Changes accepted' }));
      setLastAppliedId(result.id);
    } catch (err) {
      setResult(prev => ({ ...prev, status: 'failed', message: err.response?.data?.error || 'Apply failed' }));
    }
  }

  async function rejectChange() {
    if (!result?.id) return;
    try {
      await apiClient.rejectChangeRequest(result.id);
      setPendingDiff(null);
      setStreamingTokens('');
      setResult({ status: 'rejected', message: 'Reverted to original' });
      reloadIframe();
      setTimeout(() => setResult(null), 3000);
    } catch (err) {
      alert(err.response?.data?.error || 'Reject failed');
    }
  }

  async function handleRestore() {
    if (!lastAppliedId) return;
    try {
      await apiClient.restoreChangeRequest(lastAppliedId);
      reloadIframe();
      setLastAppliedId(null);
      setResult(null);
    } catch (err) {
      alert(err.response?.data?.error || 'Restore failed');
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    setResult(null);
    setFiles([]);
    const submittedPrompt = prompt;
    setPrompt('');

    try {
      // ── Intercept undo/revert prompts — use DB restore instead of AI ────
      const revertPattern = /^(undo|revert|rollback|restore|go back|cancel)\b/i;
      if (revertPattern.test(submittedPrompt.trim()) && lastAppliedId) {
        try {
          await apiClient.restoreChangeRequest(lastAppliedId);
          setResult({ status: 'rejected', message: 'Reverted to original' });
          setLastAppliedId(null);
          reloadIframe();
          setTimeout(() => setResult(null), 3000);
        } catch (err) {
          setResult({ status: 'failed', message: err.response?.data?.error || 'Revert failed' });
        }
        setSubmitting(false);
        return;
      }

      // ── Read iframe URL at submit-time (always fresh, not stale state) ──
      const livePageUrl = (() => {
        try {
          const src = iframeRef.current?.src;
          if (!src) return currentPageUrl;
          return src.split('?')[0]; // strip cache-bust param
        } catch { return currentPageUrl; }
      })();

      // ── Extract DOM context from iframe (0ms) ──────────────────────────
      const pageContext = iframeRef.current ? extractPageContext(iframeRef.current) : null;

      // ── Try quick path first (Tier 1 or Tier 2) — no image ────────────
      if (!image) {
        setResult({ status: 'analyzing', message: 'Applying change…' });
        try {
          const qRes = await apiClient.quickChangeRequest({
            project: { local_path: project.local_path, project_url: project.project_url },
            prompt: submittedPrompt,
            current_page_url: livePageUrl,
            page_context: pageContext
          });
          const q = qRes.data;

          if (!q.fallback) {
            // Tier 1 or 2 succeeded
            const tierLabel = q.tier === 1 ? 'Instant' : 'Fast';
            setResult({ status: 'review', message: `${tierLabel} change applied` });
            setFiles([{ file: q.file, change_type: 'modify', status: 'done' }]);

            // Try DOM update first (no reload), fall back to iframe reload
            const domApplied = q.dom_update && iframeRef.current
              ? applyDomUpdate(iframeRef.current, q.dom_update)
              : false;
            if (!domApplied) reloadIframe();
            setImage(null);
            setSubmitting(false);
            return;
          }
          // q.fallback === true → fall through to full pipeline
          setResult({ status: 'analyzing', message: 'Running full analysis…' });
        } catch {
          // quick endpoint failed → fall through
        }
      }

      // ── Full pipeline (Tier 3) ─────────────────────────────────────────
      const res = await apiClient.createChangeRequest({
        project_id: id,
        title: submittedPrompt.substring(0, 100),
        prompt: submittedPrompt,
        category: 'content',
        current_page_url: livePageUrl,
        page_context: pageContext,
        ...(image && { image_base64: image.base64, image_media_type: image.mediaType })
      });
      const cr = res.data;
      setImage(null);
      setResult({ id: cr.id, status: cr.status, message: 'Processing…', stagingUrl: null });

      socketClient.subscribeToChangeRequest(cr.id, (update) => {
        setResult(prev => ({
          ...prev,
          id: cr.id,
          status: update.status,
          message: update.message,
          stagingUrl: update.status === 'review' ? update.message?.split(': ')[1] : prev?.stagingUrl
        }));
        if (update.status === 'review') {
          reloadIframe();
          setPendingDiff(null);
          setStreamingTokens('');
          setLastAppliedId(cr.id);
        }
        if (update.status === 'pending_review') {
          try {
            const parsed = JSON.parse(update.message);
            setPendingDiff(parsed);
          } catch {}
          reloadIframe(); // show the live preview immediately
          setStreamingTokens('');
        }
        if (update.status === 'rejected' || update.status === 'failed') {
          setPendingDiff(null);
          setStreamingTokens('');
          reloadIframe(); // reload to show restored original
        }
      }, (fileUpdate) => {
        setFiles(prev => {
          const idx = prev.findIndex(f => f.file === fileUpdate.file);
          if (idx >= 0) { const next = [...prev]; next[idx] = fileUpdate; return next; }
          return [...prev, fileUpdate];
        });
      });

      // Subscribe to streaming tokens
      socketClient.onToken(cr.id, (tokenData) => {
        setStreamingTokens(prev => prev + (tokenData.token || ''));
      });
    } catch (err) {
      setResult({ status: 'failed', message: err.response?.data?.error || 'Failed to submit' });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading || !user || !project) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-500">Loading…</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-100">

      {/* Top bar */}
      <header className="bg-white border-b border-gray-200 px-4 h-12 flex items-center justify-between flex-shrink-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push('/')} className="text-gray-400 hover:text-gray-700 text-lg leading-none">←</button>
          <span className="font-semibold text-gray-900">{project.display_name}</span>
          <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Live</span>
        </div>
        <div className="flex items-center gap-2">
          <a href={project.project_url} target="_blank" rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:underline font-mono">{project.project_url}</a>
          <button onClick={() => { if (iframeRef.current) { const base = iframeRef.current.src.split('?')[0]; iframeRef.current.src = base + '?_t=' + Date.now(); } }}
            className="text-xs px-2 py-1 bg-gray-100 rounded hover:bg-gray-200 text-gray-600">
            ↻ Refresh
          </button>
          {result?.status === 'review' && lastAppliedId && (
            <button onClick={handleRestore} className="text-xs px-2 py-1 bg-orange-100 text-orange-700 rounded hover:bg-orange-200">
              ↩ Undo
            </button>
          )}
        </div>
      </header>

      {/* Iframe */}
      <div className="flex-1 overflow-hidden relative">
        <iframe
          ref={iframeRef}
          src={project.project_url}
          className="w-full h-full border-0"
          title={project.display_name}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
          onLoad={() => {
            try {
              const src = iframeRef.current?.src;
              if (src) setCurrentPageUrl(src.split('?')[0]);
            } catch {}
          }}
        />
        {/* Current page indicator */}
        {currentPageUrl && (
          <div className="absolute bottom-2 left-2 bg-black/50 text-white text-xs font-mono px-2 py-1 rounded pointer-events-none">
            {currentPageUrl.replace(project.project_url, '') || '/'}
          </div>
        )}
      </div>

      {/* File viewer — only visible when files are being generated */}
      {files.length > 0 && (
        <div className="bg-gray-950 border-t border-gray-800 flex-shrink-0 px-4 py-2 flex items-center gap-3 overflow-x-auto">
          <span className="text-gray-500 text-xs flex-shrink-0">Files:</span>
          {files.map(f => (
            <div key={f.file} className="flex items-center gap-1.5 flex-shrink-0">
              {f.status === 'generating'
                ? <div className="w-2.5 h-2.5 border border-yellow-400 border-t-transparent rounded-full animate-spin" />
                : <div className="w-2.5 h-2.5 rounded-full bg-green-400" />}
              <span className="text-xs font-mono text-gray-300">{f.file}</span>
              <span className={`text-xs px-1 rounded ${
                f.change_type === 'create' ? 'bg-green-900 text-green-400' :
                f.change_type === 'delete' ? 'bg-red-900 text-red-400' :
                'bg-blue-900 text-blue-400'
              }`}>{f.change_type}</span>
            </div>
          ))}
        </div>
      )}

      {/* Prompt bar */}
      <div className="bg-white border-t border-gray-200 flex-shrink-0 relative">

        {/* History overlay — slides up from prompt bar, hidden by default */}
        {historyOpen && (
          <div className="absolute bottom-full left-0 right-0 bg-white border border-gray-200 rounded-t-xl shadow-2xl animate-slideUp"
            style={{ maxHeight: '50vh', zIndex: 30 }}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 sticky top-0 bg-white rounded-t-xl">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Prompt History</span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setHistoryOpen(false); }}
                className="w-6 h-6 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-800 text-sm">
                ×
              </button>
            </div>
            <div className="overflow-y-auto" style={{ maxHeight: 'calc(50vh - 44px)' }}>
              {history.length === 0 ? (
                <p className="text-center text-gray-400 text-sm py-8">No changes yet</p>
              ) : (
                <ul className="divide-y divide-gray-50">
                  {history.map(cr => (
                    <li key={cr.id}
                      className="px-4 py-3 hover:bg-blue-50 cursor-pointer transition-colors"
                      onClick={() => { setPrompt(cr.prompt); setHistoryOpen(false); }}>
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm text-gray-800 leading-snug flex-1 line-clamp-2">{cr.prompt}</p>
                        <span className="text-xs text-gray-400 flex-shrink-0 whitespace-nowrap">
                          {formatDistanceToNow(new Date(cr.created_at), { addSuffix: true })}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        {/* Click-outside backdrop to close history */}
        {historyOpen && (
          <div className="fixed inset-0" style={{ zIndex: 25 }} onClick={() => setHistoryOpen(false)} />
        )}
        {/* Result status */}
        {result && (
          <div className={`px-4 py-2 border-b border-gray-100 flex items-center justify-between gap-4 text-sm`}>
            <div className="flex items-center gap-2">
              {!['review', 'failed', 'rejected', 'pending_review'].includes(result.status) && (
                <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              )}
              <span className={STATUS_COLORS[result.status] || 'text-gray-600'}>
                {STATUS_LABELS[result.status] || result.status}
              </span>
              {result.message && result.status !== 'review' && (
                <span className="text-gray-400 text-xs">{result.message}</span>
              )}
            </div>
            {result.stagingUrl && (
              <a href={result.stagingUrl} target="_blank" rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline">View staging →</a>
            )}
          </div>
        )}

        {/* Streaming token display — visible while generating */}
        {result?.status === 'generating_code' && streamingTokens && (
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-100">
            <pre className="text-xs text-gray-500 font-mono whitespace-pre-wrap max-h-16 overflow-hidden">{streamingTokens.slice(-200)}</pre>
          </div>
        )}

        {/* Diff preview panel — visible when pending_review */}
        {pendingDiff && (
          <div className="border-b border-blue-200 bg-blue-50 px-4 py-3">
            <p className="text-xs text-blue-600 mb-3">Preview applied — check the page above, then accept or reject.</p>
            <div className="flex gap-3">
              <button onClick={rejectChange} className="flex-1 py-2.5 text-sm font-medium bg-white border-2 border-red-300 text-red-700 rounded-lg hover:bg-red-50 transition-colors">
                Reject &amp; Revert
              </button>
              <button onClick={applyChange} className="flex-1 py-2.5 text-sm font-medium bg-green-600 border-2 border-green-600 text-white rounded-lg hover:bg-green-700 transition-colors">
                Accept Changes
              </button>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="px-4 py-3 flex flex-col gap-2">
          {/* Image preview */}
          {image && (
            <div className="relative inline-block self-start">
              <img src={image.preview} alt="Attached screenshot" className="h-20 rounded border border-gray-300 object-cover" />
              <button type="button" onClick={() => setImage(null)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-800 text-white rounded-full text-xs flex items-center justify-center hover:bg-red-600">
                ×
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            {/* History + image buttons on the left */}
            <div className="flex flex-col gap-1.5 flex-shrink-0">
              <button type="button"
                onClick={(e) => { e.stopPropagation(); setHistoryOpen(v => !v); }}
                title="Prompt history"
                className={`px-2.5 py-2 text-sm rounded-lg transition-colors ${historyOpen ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                ↑
                {history.length > 0 && (
                  <span className="ml-0.5 text-xs">{history.length}</span>
                )}
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
                onChange={e => { loadImageFile(e.target.files[0]); e.target.value = ''; }} />
              <button type="button" onClick={() => fileInputRef.current?.click()}
                title="Upload screenshot"
                className="px-2.5 py-2 bg-gray-100 text-gray-500 text-sm rounded-lg hover:bg-gray-200 transition-colors">
                +
              </button>
            </div>
            {/* Textarea */}
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(e); } }}
              onPaste={handlePaste}
              placeholder="Describe a change..."
              rows={2}
              disabled={submitting}
              className="flex-1 resize-none px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
              style={{ maxHeight: '120px', overflowY: 'auto' }}
            />
            {/* Send button */}
            <button type="submit" disabled={submitting || prompt.trim().length < 5}
              className="flex-shrink-0 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors self-end">
              {submitting ? '...' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
