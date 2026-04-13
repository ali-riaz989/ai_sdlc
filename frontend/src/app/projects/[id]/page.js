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
  const [pushModalOpen, setPushModalOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [pushing, setPushing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [activePrompt, setActivePrompt] = useState(null); // shows submitted prompt above input
  const iframeRef = useRef(null);
  const fileInputRef = useRef(null);

  const [imageLoading, setImageLoading] = useState(false);

  function loadImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    setImageLoading(true);

    // Resize large images (max 1200px wide, JPEG quality 0.8) to keep requests fast
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const MAX_WIDTH = 1200;
      const MAX_HEIGHT = 1200;
      let { width, height } = img;

      if (width > MAX_WIDTH || height > MAX_HEIGHT) {
        const ratio = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      const base64 = dataUrl.split(',')[1];

      // Also read the original full-res for saving to disk
      const origReader = new FileReader();
      origReader.onload = (oe) => {
        const origDataUrl = oe.target.result;
        const origBase64 = origDataUrl.split(',')[1];
        let origType = file.type;
        if (origBase64.startsWith('/9j/')) origType = 'image/jpeg';
        else if (origBase64.startsWith('iVBOR')) origType = 'image/png';

        setImage({
          base64,             // compressed — sent to AI for understanding
          mediaType: 'image/jpeg',
          preview: dataUrl,
          origBase64,         // full-res — saved to disk
          origMediaType: origType
        });
        setImageLoading(false);
      };
      origReader.readAsDataURL(file);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setImageLoading(false);
      // Fallback: read as-is without resize
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target.result;
        const base64 = dataUrl.split(',')[1];
        let mediaType = file.type;
        if (base64.startsWith('/9j/')) mediaType = 'image/jpeg';
        else if (base64.startsWith('iVBOR')) mediaType = 'image/png';
        setImage({ base64, mediaType, preview: dataUrl });
      };
      reader.readAsDataURL(file);
    };
    img.src = objectUrl;
  }

  function handlePaste(e) {
    const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'));
    if (item) loadImageFile(item.getAsFile());
  }

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [user, loading, router]);

  // Listen for postMessage from iframe (cross-origin URL tracking)
  useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === 'iframe-navigation' && e.data?.url) {
        setCurrentPageUrl(e.data.url.split('?')[0]);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Poll iframe URL — catches navigation on same-origin, onLoad handles cross-origin
  useEffect(() => {
    const interval = setInterval(() => {
      try {
        const href = iframeRef.current?.contentWindow?.location?.href;
        if (href && !href.startsWith('about:')) {
          const clean = href.split('?')[0];
          setCurrentPageUrl(prev => prev !== clean ? clean : prev);
        }
      } catch {} // cross-origin — ignore
    }, 1000);
    return () => clearInterval(interval);
  }, []);

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
      setActivePrompt(null);
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
      setActivePrompt(null);
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

  async function handlePush() {
    if (!commitMsg.trim()) return;
    setPushing(true);
    try {
      await apiClient.pushProject(id, commitMsg);
      setPushModalOpen(false);
      setCommitMsg('');
      setResult({ status: 'review', message: `Pushed to ${project.repo_branch}` });
      setTimeout(() => setResult(null), 4000);
    } catch (err) {
      alert(err.response?.data?.error || 'Push failed');
    } finally {
      setPushing(false);
    }
  }

  async function handleReset() {
    if (!confirm('Remove ALL uncommitted changes? This cannot be undone.')) return;
    setResetting(true);
    try {
      await apiClient.resetProject(id);
      reloadIframe();
      setResult({ status: 'rejected', message: 'All changes removed' });
      setLastAppliedId(null);
      setPendingDiff(null);
      setTimeout(() => setResult(null), 3000);
    } catch (err) {
      alert(err.response?.data?.error || 'Reset failed');
    } finally {
      setResetting(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    setResult(null);
    setFiles([]);
    const submittedPrompt = prompt;
    const submittedImage = image; // capture image before state changes
    setPrompt('');
    setActivePrompt(submittedPrompt);

    try {
      // ── Auto-reject any pending review before submitting new prompt ────
      if (result?.id && result?.status === 'pending_review') {
        try {
          await apiClient.rejectChangeRequest(result.id);
          setPendingDiff(null);
        } catch {}
      }

      // ── Intercept undo/revert prompts — use DB restore instead of AI ────
      const revertPattern = /^(undo|revert|rollback|restore|go back|cancel)\b/i;
      if (revertPattern.test(submittedPrompt.trim()) && lastAppliedId) {
        try {
          await apiClient.restoreChangeRequest(lastAppliedId);
          setResult({ status: 'rejected', message: 'Reverted to original' });
          setLastAppliedId(null);
          setActivePrompt(null);
          reloadIframe();
          setTimeout(() => setResult(null), 3000);
        } catch (err) {
          setResult({ status: 'failed', message: err.response?.data?.error || 'Revert failed' });
        }
        setSubmitting(false);
        return;
      }

      // ── Read iframe URL at submit-time ──
      const livePageUrl = (() => {
        try {
          const href = iframeRef.current?.contentWindow?.location?.href;
          if (href && !href.startsWith('about:')) return href.split('?')[0];
        } catch { /* cross-origin */ }
        // Fallback: use the src attribute or tracked URL
        // Convert preview domain URL to project_url for route resolution
        const fallback = currentPageUrl || iframeRef.current?.src?.split('?')[0] || project.project_url;
        return fallback;
      })();

      // ── Extract DOM context from iframe (0ms) ──────────────────────────
      const pageContext = iframeRef.current ? extractPageContext(iframeRef.current) : null;

      // ── Try quick path first (Tier 1 or Tier 2) — no image ────────────
      if (!submittedImage) {
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
        ...(submittedImage && {
          image_base64: submittedImage.base64,
          image_media_type: submittedImage.mediaType
        })
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

      // Poll for status updates (Socket.io may not work through Nginx)
      const pollInterval = setInterval(async () => {
        try {
          const pollRes = await apiClient.getChangeRequest(cr.id);
          const s = pollRes.data?.status;
          if (!s || ['pending', 'analyzing', 'generating_code', 'staging'].includes(s)) return;
          clearInterval(pollInterval);
          if (s === 'pending_review') {
            setResult(prev => ({ ...prev, id: cr.id, status: s, message: 'Preview ready' }));
            setPendingDiff({ diff: [] });
            reloadIframe();
            setStreamingTokens('');
          } else if (s === 'review') {
            setResult(prev => ({ ...prev, id: cr.id, status: s, message: 'Done' }));
            reloadIframe();
            setPendingDiff(null);
            setStreamingTokens('');
            setLastAppliedId(cr.id);
          } else if (s === 'failed') {
            setResult(prev => ({ ...prev, id: cr.id, status: 'failed', message: 'Change failed' }));
            setPendingDiff(null);
            setStreamingTokens('');
            setActivePrompt(null);
            setTimeout(() => setResult(null), 5000);
          }
        } catch {}
      }, 2000);
      setTimeout(() => clearInterval(pollInterval), 120000);

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
            // Read the actual URL from the iframe on every navigation
            const readUrl = () => {
              try {
                const href = iframeRef.current?.contentWindow?.location?.href;
                if (href && !href.startsWith('about:')) { setCurrentPageUrl(href.split('?')[0]); return; }
              } catch {}
              try {
                const src = iframeRef.current?.src;
                if (src) setCurrentPageUrl(src.split('?')[0]);
              } catch {}
            };
            readUrl();
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

      {/* ═══ Bottom Workspace Bar ═══ */}
      <div className="flex-shrink-0 relative" style={{ zIndex: 20 }}>

        {/* History overlay */}
        {historyOpen && (
          <div className="absolute bottom-full left-0 bg-white border border-gray-200 rounded-t-xl shadow-2xl animate-slideUp w-72"
            style={{ zIndex: 30 }}>
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 bg-gray-50 rounded-t-xl">
              <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Prompt History</span>
              <button type="button" onClick={(e) => { e.stopPropagation(); setHistoryOpen(false); }}
                className="w-5 h-5 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-200 hover:text-gray-700 text-xs">×</button>
            </div>
            <div className="overflow-y-auto" style={{ maxHeight: '280px' }}>
              {history.length === 0 ? (
                <p className="text-center text-gray-400 text-xs py-6">No changes yet</p>
              ) : (
                <ul className="divide-y divide-gray-50">
                  {history.map(cr => (
                    <li key={cr.id} className="px-3 py-2.5 hover:bg-blue-50 cursor-pointer transition-colors"
                      onClick={() => { setPrompt(cr.prompt); setHistoryOpen(false); }}>
                      <p className="text-xs text-gray-700 leading-snug line-clamp-2">{cr.prompt}</p>
                      <span className="text-[10px] text-gray-400 mt-0.5 block">
                        {formatDistanceToNow(new Date(cr.created_at), { addSuffix: true })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        {historyOpen && <div className="fixed inset-0" style={{ zIndex: 25 }} onClick={() => setHistoryOpen(false)} />}

        {/* Push commit modal */}
        {pushModalOpen && (
          <>
            <div className="fixed inset-0 bg-black/40" style={{ zIndex: 50 }} onClick={() => setPushModalOpen(false)} />
            <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm" style={{ zIndex: 51 }}>
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Push to <span className="font-mono text-blue-600">{project.repo_branch}</span></h3>
              <input value={commitMsg} onChange={e => setCommitMsg(e.target.value)}
                placeholder="Commit message..." autoFocus
                onKeyDown={e => { if (e.key === 'Enter') handlePush(); }}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent mb-3" />
              <div className="flex gap-2">
                <button onClick={() => setPushModalOpen(false)}
                  className="flex-1 py-2 border border-gray-200 rounded-xl text-sm text-gray-500 hover:bg-gray-50">Cancel</button>
                <button onClick={handlePush} disabled={pushing || !commitMsg.trim()}
                  className="flex-1 py-2 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                  {pushing ? 'Pushing...' : 'Push'}</button>
              </div>
            </div>
          </>
        )}

        {/* Status / streaming / accept-reject bar */}
        {result && (
          <div className="bg-white px-4 py-1.5 border-t border-gray-100 flex items-center gap-2 text-xs">
            {!['review', 'failed', 'rejected', 'pending_review'].includes(result.status) && (
              <div className="w-2.5 h-2.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            )}
            <span className={STATUS_COLORS[result.status] || 'text-gray-500'}>{STATUS_LABELS[result.status] || result.status}</span>
            {result.message && result.status !== 'review' && <span className="text-gray-400">{result.message}</span>}
          </div>
        )}
        {result?.status === 'generating_code' && streamingTokens && (
          <div className="bg-gray-50 px-4 py-1 border-t border-gray-100">
            <pre className="text-[10px] text-gray-400 font-mono whitespace-pre-wrap max-h-10 overflow-hidden">{streamingTokens.slice(-150)}</pre>
          </div>
        )}
        {pendingDiff && (
          <div className="bg-blue-50 px-4 py-2 border-t border-blue-100 flex items-center gap-3">
            <span className="text-xs text-blue-600 flex-1">Preview applied — accept or reject</span>
            <button onClick={rejectChange} className="px-3 py-1.5 text-xs font-medium bg-white border border-red-200 text-red-600 rounded-lg hover:bg-red-50">Reject</button>
            <button onClick={applyChange} className="px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-700">Accept</button>
          </div>
        )}

        {/* ═══ Main bar ═══ */}
        <div className="border-t-2 border-stone-300 py-3" style={{ background: 'linear-gradient(135deg, #e8e4df 0%, #f0ece7 40%, #e8e4df 100%)' }}>
          <div className="w-[65%] mx-auto">

            {/* Active prompt bubble */}
            {activePrompt && (
              <div className="mb-3 flex items-start gap-2">
                <div className="flex-1 text-sm px-4 py-2.5 rounded-2xl rounded-bl-sm shadow-md text-white" style={{ background: 'linear-gradient(135deg, #2d6a4f, #40916c)' }}>
                  {activePrompt}
                </div>
                {!['review', 'failed', 'rejected', 'pending_review'].includes(result?.status) && (
                  <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin flex-shrink-0 mt-1.5" />
                )}
              </div>
            )}

            {/* Input row */}
            <div className="flex items-center gap-2.5">

              {/* Left: History & Upload */}
              <div className="flex items-center gap-px rounded-2xl border-2 border-stone-300 flex-shrink-0 p-1" style={{ background: 'linear-gradient(180deg, #f5f0eb, #ebe5de)' }}>
                <button type="button" onClick={(e) => { e.stopPropagation(); setHistoryOpen(v => !v); }}
                  title="Prompt history"
                  className={`flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-medium transition-colors ${historyOpen ? 'bg-emerald-100 text-emerald-700' : 'text-stone-600 hover:bg-white/60'}`}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                  {history.length > 0 && <span className="bg-stone-400 text-white text-[10px] px-1.5 rounded-full font-bold">{history.length}</span>}
                </button>
                <div className="w-px h-5 bg-stone-300" />
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
                  onChange={e => { loadImageFile(e.target.files[0]); e.target.value = ''; }} />
                <button type="button" onClick={() => fileInputRef.current?.click()}
                  title="Upload screenshot"
                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-xs text-stone-600 hover:bg-white/60 transition-colors font-medium">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                </button>
              </div>

              {/* Center: Input */}
              <form onSubmit={handleSubmit} className="flex-1 flex items-center gap-2">
                <div className="flex-1 relative">
                  {imageLoading && (
                    <div className="absolute -top-14 left-0 h-12 w-16 rounded-xl border-2 border-stone-300 bg-stone-100 flex items-center justify-center shadow">
                      <div className="w-4 h-4 border-2 border-stone-400 border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                  {image && !imageLoading && (
                    <div className="absolute -top-14 left-0">
                      <div className="relative">
                        <img src={image.preview} alt="Screenshot" className="h-12 rounded-xl border-2 border-stone-300 object-cover shadow" />
                        <button type="button" onClick={() => setImage(null)}
                          className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-stone-700 text-white rounded-full text-xs flex items-center justify-center hover:bg-red-500 shadow">×</button>
                      </div>
                    </div>
                  )}
                  <input type="text" value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(e); } }}
                    onPaste={handlePaste}
                    placeholder="Describe your design change..."
                    disabled={submitting}
                    className="w-full pl-4 pr-4 py-3 bg-white border-2 border-stone-300 rounded-2xl text-sm shadow-inner focus:ring-2 focus:ring-emerald-400 focus:border-emerald-400 disabled:opacity-50 transition-all placeholder:text-stone-400"
                  />
                </div>
              </form>

              {/* Right: Preview + Send */}
              <div className="flex items-center gap-2.5 flex-shrink-0">
                {currentPageUrl && (
                  <div className="hidden lg:flex items-center gap-2 rounded-2xl border-2 border-stone-300 px-2.5 py-2 max-w-[130px]" style={{ background: 'linear-gradient(180deg, #f5f0eb, #ebe5de)' }} title={currentPageUrl}>
                    <div className="w-8 h-6 bg-white rounded-lg border border-stone-300 flex items-center justify-center flex-shrink-0">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-500">
                        <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
                      </svg>
                    </div>
                    <span className="text-[10px] text-stone-600 truncate font-medium">{currentPageUrl.replace(project.project_url, '') || '/'}</span>
                  </div>
                )}
                <button type="button" onClick={handleSubmit} disabled={submitting || imageLoading || prompt.trim().length < 3}
                  className="h-11 px-5 text-white text-sm font-semibold rounded-2xl disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-md hover:shadow-lg flex items-center gap-2"
                  style={{ background: submitting ? '#5a8a7a' : 'linear-gradient(135deg, #1b4332, #2d6a4f)' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                  {submitting ? '...' : 'Send'}
                </button>
              </div>
            </div>

            {/* Bottom controls */}
            <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-stone-300/50">
              <div className="flex items-center gap-2">
                {result?.status === 'review' && lastAppliedId && (
                  <button onClick={handleRestore} className="text-[11px] px-2.5 py-1 text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors font-medium">Undo last</button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={handleReset} disabled={resetting}
                  className="text-[11px] px-3 py-1.5 border-2 border-stone-300 text-stone-600 rounded-xl hover:bg-white hover:border-red-300 hover:text-red-600 transition-colors disabled:opacity-50 font-medium" style={{ background: 'linear-gradient(180deg, #f5f0eb, #ebe5de)' }}>
                  {resetting ? 'Removing...' : 'Remove All Changes'}
                </button>
                <button type="button" onClick={() => { setCommitMsg(''); setPushModalOpen(true); }}
                  className="text-[11px] px-3 py-1.5 text-white rounded-xl transition-all font-semibold shadow-sm hover:shadow-md"
                  style={{ background: 'linear-gradient(135deg, #1b4332, #2d6a4f)' }}>
                  Push to {project.repo_branch}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
