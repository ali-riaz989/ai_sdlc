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
  // Per-URL cache of the resolved blade file. Populated once when the iframe navigates to a
  // new URL, then passed to every subsequent change-request so the backend skips resolution.
  const [bladeByUrl, setBladeByUrl] = useState({}); // { [url]: { blade_file, abs_path } }
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pendingDiff, setPendingDiff] = useState(null);
  const [lastAppliedId, setLastAppliedId] = useState(null); // change request id of last applied change
  const [streamingTokens, setStreamingTokens] = useState('');
  const [pushModalOpen, setPushModalOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [pushing, setPushing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [activePrompt, setActivePrompt] = useState(null);
  const [chatMessages, setChatMessages] = useState([]); // session chat — destroyed on tab close
  const [highlightRect, setHighlightRect] = useState(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedElement, setSelectedElement] = useState(null); // { tag, text, section, classes }
  const iframeRef = useRef(null);
  const fileInputRef = useRef(null);
  const chatEndRef = useRef(null);

  const [imageLoading, setImageLoading] = useState(false);


  function clearHighlight() {
    setHighlightRect(null);
    try {
      const el = iframeRef.current?._highlightedEl;
      const styles = iframeRef.current?._highlightStyles;
      if (el && styles) {
        for (const key of Object.keys(styles)) {
          el.style[key] = '';
        }
        iframeRef.current._highlightedEl = null;
        iframeRef.current._highlightStyles = null;
      }
    } catch {}
  }

  // Chat helpers
  function addChat(role, text, type = 'text', data = null) {
    setChatMessages(prev => [...prev, { role, text, type, data, id: Date.now() + Math.random() }]);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
  }
  function clearChat() { setChatMessages([]); }

  // Mirror `files` into a ref so socket/poll handlers (which capture stale state via closure)
  // can read the latest file list when snapshotting into chat history.
  const filesRef = useRef([]);
  useEffect(() => { filesRef.current = files; }, [files]);

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

  // Resolve the current page's blade file once per URL and cache it, so every
  // subsequent chat submit can skip the backend resolver step.
  useEffect(() => {
    if (!id || !currentPageUrl) return;
    if (bladeByUrl[currentPageUrl]) return; // already cached
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.resolveRoute(id, currentPageUrl);
        if (cancelled) return;
        if (res.data?.blade_file) {
          setBladeByUrl(prev => ({ ...prev, [currentPageUrl]: { blade_file: res.data.blade_file, abs_path: res.data.abs_path } }));
        }
      } catch { /* silent — backend will fall back to running the resolver on submit */ }
    })();
    return () => { cancelled = true; };
  }, [id, currentPageUrl, bladeByUrl]);

  // ── Click-to-select mode: hover highlight + click to identify element ──
  useEffect(() => {
    if (!selectMode || !iframeRef.current) return;
    let hoveredEl = null;

    const getDoc = () => {
      try { return iframeRef.current?.contentDocument; } catch { return null; }
    };

    const onMouseOver = (e) => {
      const el = e.target;
      if (el === hoveredEl) return;
      // Remove previous hover
      if (hoveredEl) {
        hoveredEl.style.outline = '';
        hoveredEl.style.outlineOffset = '';
        hoveredEl.style.cursor = '';
      }
      // Don't highlight tiny inline elements — find a meaningful parent
      let target = el;
      const smallTags = new Set(['SPAN', 'A', 'STRONG', 'EM', 'B', 'I', 'BR', 'IMG']);
      while (target && smallTags.has(target.tagName) && target.parentElement) {
        target = target.parentElement;
      }
      target.style.outline = '3px dotted #dc2626';
      target.style.outlineOffset = '3px';
      target.style.boxShadow = '0 0 0 6px rgba(220, 38, 38, 0.25)';
      target.style.cursor = 'pointer';
      hoveredEl = target;
    };

    const onMouseOut = (e) => {
      if (hoveredEl) {
        hoveredEl.style.outline = '';
        hoveredEl.style.outlineOffset = '';
        hoveredEl.style.boxShadow = '';
        hoveredEl.style.cursor = '';
        hoveredEl = null;
      }
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      let el = hoveredEl || e.target;

      // If the user actually clicked on pixels belonging to an <img> inside a wrapper
      // (e.g. <div class="img-box"><img …></div>, <a><img></a>), promote the target
      // to that <img> so backend matches by filename. Don't promote when the click
      // lands on the wrapper's background/padding — a big header with a small logo
      // should stay a header click, not an image click.
      if (el.tagName !== 'IMG') {
        const imgs = el.querySelectorAll?.('img') || [];
        const cx = e.clientX, cy = e.clientY;
        const hitImgs = [];
        for (const img of imgs) {
          const r = img.getBoundingClientRect();
          if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) hitImgs.push(img);
        }
        if (hitImgs.length === 1) {
          el = hitImgs[0];
        } else if (hitImgs.length > 1) {
          // Nested imgs at the click point — pick the innermost
          el = hitImgs[hitImgs.length - 1];
        }
      }

      // Find the parent landmark. Prefer semantic containers so Claude gets
      // "header" / "footer" / "nav" instead of "unknown section" when the page
      // uses plain <header> / <footer> / <nav> without classes.
      const section = el.closest('section')
        || el.closest('[class*="section"]')
        || el.closest('[class*="area"]')
        || el.closest('header')
        || el.closest('footer')
        || el.closest('nav')
        || el.closest('aside')
        || el.closest('main');

      const isSemantic = section && ['HEADER','FOOTER','NAV','ASIDE','MAIN'].includes(section.tagName);

      // Strip animation / utility library classes (aos-*, wow-*, animate*, data-* helpers, visibility
      // flags) so the human-facing section label reflects the real structural class, not the runtime
      // state added by whatever scroll-animation library the template uses.
      const cleanClassName = (raw) => {
        if (!raw) return '';
        const noise = /^(aos|aos-init|aos-animate|wow|animated|animate__|data-|fade|show|hide|hidden|visible|active|in-view|scrolled)/i;
        return raw.split(/\s+/)
          .filter(c => c && !noise.test(c))
          .slice(0, 4)
          .join(' ')
          .substring(0, 60);
      };

      // Find the heading most likely to label the clicked element:
      // 1) the heading inside the nearest "card / tile / item" sub-container,
      // 2) else the nearest heading that precedes the clicked element in DOM order,
      // 3) else the section's first heading (fallback for simple sections).
      const findLocalHeading = (element, sectionRoot) => {
        if (!element || !sectionRoot) return null;
        const cardSelector = 'article, li, figure, [class*="card"], [class*="item"], [class*="tile"], [class*="box"], [class*="panel"], [class*="block"]';
        const card = element.closest(cardSelector);
        if (card && sectionRoot.contains(card)) {
          const h = card.querySelector('h1,h2,h3,h4');
          if (h) return h.innerText?.trim();
        }
        // Walk the DOM backward from the element and return the nearest preceding heading
        const allHeadings = Array.from(sectionRoot.querySelectorAll('h1,h2,h3,h4'));
        if (!allHeadings.length) return null;
        // Use compareDocumentPosition to find the last heading that precedes `element`
        let best = null;
        for (const h of allHeadings) {
          const pos = h.compareDocumentPosition(element);
          // Node.DOCUMENT_POSITION_FOLLOWING (0x04) means element is after h in doc order
          if (pos & 0x04) best = h;
          else break;
        }
        return (best || allHeadings[0])?.innerText?.trim() || null;
      };

      // Use a local (per-card or preceding) heading for content sections.
      // Headers/footers/navs skip heading lookup — their unrelated inner headings
      // (weather widget, badges) would mislabel the pick.
      let sectionLabel = null;
      if (section) {
        const cleanedClasses = cleanClassName(section.className);
        if (isSemantic) {
          sectionLabel = cleanedClasses || section.tagName.toLowerCase();
        } else {
          const heading = findLocalHeading(el, section);
          const looksLikeHeading = heading && heading.length >= 3 && /[a-z]/i.test(heading) && heading.length <= 80;
          sectionLabel = (looksLikeHeading ? heading : null) || cleanedClasses || null;
        }
      }

      // Get element info
      const info = {
        tag: el.tagName.toLowerCase(),
        text: el.innerText?.trim().substring(0, 100) || '',
        classes: el.className?.substring(0, 80) || '',
        section: sectionLabel || 'unknown section',
        isImage: el.tagName === 'IMG',
        src: el.tagName === 'IMG' ? el.src?.substring(0, 200) : null
      };

      setSelectedElement(info);
      setSelectMode(false);

      // Don't auto-fill prompt — let user describe what they want to do
      const elDesc = info.isImage
        ? `an image in "${info.section}"`
        : info.tag.match(/^h[1-6]$/)
        ? `the "${info.text}" heading in "${info.section}"`
        : info.text
        ? `"${info.text.substring(0, 50)}${info.text.length > 50 ? '...' : ''}" in "${info.section}"`
        : `a ${info.tag} element in "${info.section}"`;
      addChat('ai', `Selected: ${elDesc}. What would you like to do? (change text, update style, replace image, etc.)`, 'text');

      // Highlight the selected element — bold red to stand out
      const selectedStyles = {
        outline: '4px dotted #dc2626',
        outlineOffset: '4px',
        boxShadow: '0 0 0 8px rgba(220, 38, 38, 0.3), 0 0 24px rgba(220, 38, 38, 0.4)',
        background: 'rgba(220, 38, 38, 0.08)'
      };
      Object.assign(el.style, selectedStyles);
      iframeRef.current._highlightedEl = el;
      iframeRef.current._highlightStyles = selectedStyles;

      // Clean hover listeners
      const doc = getDoc();
      if (doc) {
        doc.removeEventListener('mouseover', onMouseOver);
        doc.removeEventListener('mouseout', onMouseOut);
        doc.removeEventListener('click', onClick, true);
      }
    };

    const doc = getDoc();
    if (doc) {
      doc.addEventListener('mouseover', onMouseOver);
      doc.addEventListener('mouseout', onMouseOut);
      doc.addEventListener('click', onClick, true);

      // Change cursor for the whole iframe
      doc.body.style.cursor = 'crosshair';
    }

    return () => {
      const doc = getDoc();
      if (doc) {
        doc.removeEventListener('mouseover', onMouseOver);
        doc.removeEventListener('mouseout', onMouseOut);
        doc.removeEventListener('click', onClick, true);
        doc.body.style.cursor = '';
      }
      if (hoveredEl) {
        hoveredEl.style.outline = '';
        hoveredEl.style.outlineOffset = '';
        hoveredEl.style.boxShadow = '';
        hoveredEl.style.cursor = '';
      }
    };
  }, [selectMode]);

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
    apiClient.getProject(id).then(res => {
      setProject(res.data);
      // Tell the /preview proxy which Laravel URL to forward to (per-project).
      if (res.data?.project_url) {
        document.cookie = `preview_target=${encodeURIComponent(res.data.project_url)}; path=/; SameSite=Lax`;
      }
    }).catch(() => router.replace('/'));

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
    if (!iframeRef.current) return;
    // Prefer the actual current URL (same-origin via /preview proxy) so we stay on the page the user navigated to.
    // Fallbacks: tracked currentPageUrl state, then the iframe's initial src.
    let target = null;
    try {
      const href = iframeRef.current.contentWindow?.location?.href;
      if (href && !href.startsWith('about:')) target = href;
    } catch { /* cross-origin — shouldn't happen with proxy, but be safe */ }
    if (!target) target = currentPageUrl || iframeRef.current.src;
    const base = target.split('?')[0];
    iframeRef.current.src = base + '?_t=' + Date.now();
  }

  async function applyChange() {
    if (!result?.id) return;
    addChat('user', 'Accept changes');
    try {
      await apiClient.applyChangeRequest(result.id);
      setPendingDiff(null);
      setStreamingTokens('');
      setResult(prev => ({ ...prev, status: 'review', message: 'Changes accepted' }));
      setLastAppliedId(result.id);
      setActivePrompt(null);
      addChat('ai', 'Changes accepted! You can continue editing or push to your branch.', 'success');
    } catch (err) {
      setResult(prev => ({ ...prev, status: 'failed', message: err.response?.data?.error || 'Apply failed' }));
      addChat('ai', 'Failed to apply: ' + (err.response?.data?.error || 'Unknown error'), 'error');
    }
  }

  async function rejectChange() {
    if (!result?.id) return;
    addChat('user', 'Reject changes');
    try {
      await apiClient.rejectChangeRequest(result.id);
      setPendingDiff(null);
      setStreamingTokens('');
      setActivePrompt(null);
      setResult({ status: 'rejected', message: 'Reverted to original' });
      reloadIframe();
      addChat('ai', 'Reverted to original. Tell me what to change instead.', 'text');
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
    addChat('user', submittedPrompt);

    try {
      // ── Auto-accept any pending review before submitting new prompt ────
      // If the user was happy enough to keep iterating, treat the previous
      // preview as accepted rather than throwing it away.
      if (result?.id && result?.status === 'pending_review') {
        try {
          await apiClient.applyChangeRequest(result.id);
          setLastAppliedId(result.id);
          setPendingDiff(null);
        } catch {}
      }

      // ── Intercept undo/revert prompts — use DB restore / git reset instead of AI ────
      const trimmed = submittedPrompt.trim();
      const revertAllPattern = /^(undo|revert|rollback|restore|reset|remove|discard|clear|drop)\b.*\b(all|everything|every(?:\s+single)?\s+change|all\s+changes)\b/i;
      const revertLastPattern = /^(undo|revert|rollback|restore|go back|cancel)\b/i;

      // "revert all changes" / "undo everything" → full project reset (git checkout .)
      if (revertAllPattern.test(trimmed)) {
        if (!confirm('This will discard EVERY uncommitted change in the project. Continue?')) {
          addChat('ai', 'Reset cancelled.', 'text');
          setActivePrompt(null);
          setSubmitting(false);
          return;
        }
        try {
          await apiClient.resetProject(id);
          setLastAppliedId(null);
          setPendingDiff(null);
          setResult({ status: 'rejected', message: 'All changes removed' });
          reloadIframe();
          addChat('ai', 'All uncommitted changes removed. Project reset to its last committed state.', 'success');
          setActivePrompt(null);
          setTimeout(() => setResult(null), 3000);
        } catch (err) {
          const reason = err.response?.data?.error || 'Reset failed';
          setResult({ status: 'failed', message: reason });
          addChat('ai', reason, 'error');
        }
        setSubmitting(false);
        return;
      }

      // "undo" / "revert" alone → restore only the last applied change
      if (revertLastPattern.test(trimmed) && lastAppliedId) {
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

      // ── All prompts go through 2-step AI flow (identify section → confirm → edit) ──
      setResult({ status: 'analyzing', message: 'Finding the right section…' });
      // Pass full chat history to AI for complete context
      const conversationContext = chatMessages.map(m => ({ role: m.role, text: m.text }));

      const res = await apiClient.createChangeRequest({
        project_id: id,
        title: submittedPrompt.substring(0, 100),
        prompt: submittedPrompt,
        category: 'content',
        current_page_url: livePageUrl,
        page_context: pageContext,
        conversation: conversationContext,
        selected_element: selectedElement || null,
        resolved_blade_file: bladeByUrl[livePageUrl] || null,
        ...(submittedImage && {
          image_base64: submittedImage.base64,
          image_media_type: submittedImage.mediaType
        })
      });
      // Keep selectedElement across follow-up prompts so the user can refine the
      // edit without re-clicking Select. Cleared only when they pick a new element
      // or when the change is accepted (status='review').
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
          let parsed = null;
          try { parsed = JSON.parse(update.message); } catch {}
          if (parsed) setPendingDiff(parsed);
          // Snapshot the in-flight file list + diffs into chat history so the bubble
          // sticks in the thread even after accept/reject or a follow-up prompt.
          const snapshot = filesRef.current.map(f => ({ ...f, status: f.status === 'generating' ? 'done' : f.status }));
          if (snapshot.length) {
            addChat('ai', '', 'file_change', { files: snapshot, diffs: parsed?.diff || [] });
            setFiles([]);
          }
          reloadIframe(); // show the live preview immediately
          setStreamingTokens('');
        }
        if (update.status === 'rejected' || update.status === 'failed') {
          setPendingDiff(null);
          setStreamingTokens('');
          reloadIframe(); // reload to show restored original
          if (update.status === 'failed') {
            const reason = update.message || 'The change failed. Try again.';
            addChat('ai', reason, 'error');
            setActivePrompt(null);
          }
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
          if (!s || ['pending', 'analyzing', 'staging'].includes(s)) return;
          // generating_code: keep polling
          if (s === 'generating_code') return;
          clearInterval(pollInterval);
          if (s === 'pending_review') {
            setResult(prev => ({ ...prev, id: cr.id, status: s, message: 'Preview ready' }));
            setPendingDiff({ diff: [] });
            // Fallback snapshot via polling path, in case the socket update didn't fire
            const snap = filesRef.current.map(f => ({ ...f, status: f.status === 'generating' ? 'done' : f.status }));
            if (snap.length) {
              addChat('ai', '', 'file_change', { files: snap, diffs: [] });
              setFiles([]);
            }
            reloadIframe();
            setStreamingTokens('');
          } else if (s === 'review') {
            setResult(prev => ({ ...prev, id: cr.id, status: s, message: 'Done' }));
            reloadIframe();
            setPendingDiff(null);
            setStreamingTokens('');
            setLastAppliedId(cr.id);
            // Change accepted — clear selection so the next unrelated prompt requires a fresh pick
            setSelectedElement(null);
            clearHighlight();
          } else if (s === 'failed') {
            setResult(prev => ({ ...prev, id: cr.id, status: 'failed', message: 'Change failed' }));
            setPendingDiff(null);
            setStreamingTokens('');
            setActivePrompt(null);
            // Fetch actual error reason
            try {
              const detail = await apiClient.getChangeRequest(cr.id);
              const reason = detail.data?.error_message || detail.data?.message || 'The change failed. Try again.';
              setResult(prev => ({ ...prev, status: 'failed', message: reason }));
              addChat('ai', reason, 'error');
            } catch { addChat('ai', 'The change failed. Try again.', 'error'); }
            setTimeout(() => setResult(null), 8000);
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

      <div className="flex flex-1 overflow-hidden">

        <aside className="w-[420px] flex-shrink-0 flex flex-col border-r-2 border-stone-300" style={{ background: 'linear-gradient(180deg, #f0ece7 0%, #e8e4df 100%)' }}>

          {/* Sidebar header — scoped to the chat column only */}
          <header className="bg-white border-b border-stone-200 px-3 py-2 flex-shrink-0 space-y-1.5">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <button onClick={() => router.push('/')} title="Back" className="text-gray-400 hover:text-gray-700 text-base leading-none flex-shrink-0">←</button>
                <span className="font-semibold text-gray-900 truncate">{project.display_name}</span>
                <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium flex-shrink-0">Live</span>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button onClick={() => { if (iframeRef.current) { const base = iframeRef.current.src.split('?')[0]; iframeRef.current.src = base + '?_t=' + Date.now(); } }}
                  title="Refresh preview"
                  className="text-[11px] px-2 py-1 bg-gray-100 rounded hover:bg-gray-200 text-gray-600">↻</button>
                <button onClick={() => { clearHighlight(); setSelectMode(v => !v); }}
                  className={`text-[11px] px-2 py-1 rounded transition-colors ${selectMode ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                  {selectMode ? '✓ Selecting' : '⊹ Select'}
                </button>
                {result?.status === 'review' && lastAppliedId && (
                  <button onClick={handleRestore} title="Undo last change" className="text-[11px] px-2 py-1 bg-orange-100 text-orange-700 rounded hover:bg-orange-200">↩</button>
                )}
              </div>
            </div>
            {project.project_url && (
              <a href={project.project_url} target="_blank" rel="noopener noreferrer"
                className="block text-[10px] text-blue-600 hover:underline font-mono truncate" title={project.project_url}>
                {project.project_url}
              </a>
            )}
          </header>


          <div className={`flex-1 px-4 py-4 space-y-2 ${chatMessages.length > 0 || submitting || files.length > 0 ? 'overflow-y-auto' : 'overflow-hidden'}`} style={{ scrollbarWidth: 'thin' }}>
            {chatMessages.length === 0 && !submitting && (
              <div className="h-full flex items-center justify-center text-center">
                <div className="text-stone-500 text-xs max-w-[240px] leading-relaxed">
                  Click <span className="font-semibold text-stone-700">Select</span> on the top bar, pick an element in the preview, then describe the change below.
                </div>
              </div>
            )}
            {chatMessages.map(msg => {
              if (msg.type === 'file_change' && msg.data) {
                return (
                  <div key={msg.id} className="flex items-start gap-2">
                    <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-white text-[10px] font-bold mt-0.5" style={{ background: '#2d6a4f' }}>AI</div>
                    <div className="flex-1 min-w-0 bg-white text-stone-800 rounded-2xl rounded-tl-sm px-3 py-2 space-y-2 shadow-sm border border-stone-200">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">Files changed</div>
                      {msg.data.files.map(f => {
                        const diff = (msg.data.diffs || []).find(d => d.file_path === f.file);
                        return (
                          <div key={f.file} className="space-y-1.5">
                            <div className="flex items-center gap-2 min-w-0">
                              {f.status === 'failed'
                                ? <div className="w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0" />
                                : <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 flex-shrink-0" />}
                              <span className="text-[11px] font-mono text-stone-700 truncate flex-1" title={f.file}>{f.file}</span>
                              <span className={`text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold flex-shrink-0 ${
                                f.change_type === 'create' ? 'bg-emerald-100 text-emerald-700 border border-emerald-200' :
                                f.change_type === 'delete' ? 'bg-red-100 text-red-700 border border-red-200' :
                                'bg-blue-100 text-blue-700 border border-blue-200'
                              }`}>{f.change_type}</span>
                            </div>
                            {diff && (diff.old_block || diff.new_block) && (
                              <div className="rounded-lg overflow-hidden border border-stone-200 bg-stone-50 text-[10.5px] font-mono leading-relaxed">
                                {diff.old_block && (
                                  <pre className="px-2 py-1 bg-red-50 text-red-700 whitespace-pre-wrap break-all max-h-24 overflow-auto">
{diff.old_block.split('\n').slice(0, 8).map(l => '- ' + l).join('\n')}{diff.old_block.split('\n').length > 8 ? '\n…' : ''}
                                  </pre>
                                )}
                                {diff.new_block && (
                                  <pre className="px-2 py-1 bg-emerald-50 text-emerald-800 whitespace-pre-wrap break-all max-h-24 overflow-auto">
{diff.new_block.split('\n').slice(0, 8).map(l => '+ ' + l).join('\n')}{diff.new_block.split('\n').length > 8 ? '\n…' : ''}
                                  </pre>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              }
              return (
                <div key={msg.id} className={`flex items-start gap-2 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                  {msg.role === 'ai' && (
                    <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-white text-[10px] font-bold mt-0.5" style={{ background: '#2d6a4f' }}>AI</div>
                  )}
                  <div className={`max-w-[80%] text-sm px-3 py-2 rounded-2xl ${
                    msg.role === 'user'
                      ? 'rounded-br-sm text-white shadow-sm'
                      : msg.type === 'error'
                      ? 'bg-red-50 text-red-700 border border-red-200'
                      : msg.type === 'success'
                      ? 'bg-green-50 text-green-700 border border-green-200'
                      : msg.type === 'confirm'
                      ? 'bg-amber-50 text-amber-800 border border-amber-200'
                      : 'bg-white text-black border border-stone-200'
                  }`} style={msg.role === 'user' ? { background: 'linear-gradient(135deg, #2d6a4f, #40916c)' } : {}}>
                    {msg.text}
                  </div>
                </div>
              );
            })}
            {files.length > 0 && (
              <div className="flex items-start gap-2">
                <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-white text-[10px] font-bold mt-0.5" style={{ background: '#2d6a4f' }}>AI</div>
                <div className="flex-1 min-w-0 bg-white text-stone-800 rounded-2xl rounded-tl-sm px-3 py-2 space-y-2 shadow-sm border border-stone-200">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">Files changed</div>
                  {files.map(f => {
                    const diff = pendingDiff?.diff?.find(d => d.file_path === f.file);
                    return (
                      <div key={f.file} className="space-y-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          {f.status === 'generating'
                            ? <div className="w-2.5 h-2.5 border border-amber-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                            : f.status === 'failed'
                            ? <div className="w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0" />
                            : <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 flex-shrink-0" />}
                          <span className="text-[11px] font-mono text-stone-700 truncate flex-1" title={f.file}>{f.file}</span>
                          <span className={`text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold flex-shrink-0 ${
                            f.change_type === 'create' ? 'bg-emerald-100 text-emerald-700 border border-emerald-200' :
                            f.change_type === 'delete' ? 'bg-red-100 text-red-700 border border-red-200' :
                            'bg-blue-100 text-blue-700 border border-blue-200'
                          }`}>{f.change_type}</span>
                        </div>
                        {diff && (diff.old_block || diff.new_block) && (
                          <div className="rounded-lg overflow-hidden border border-stone-200 bg-stone-50 text-[10.5px] font-mono leading-relaxed">
                            {diff.old_block && (
                              <pre className="px-2 py-1 bg-red-50 text-red-700 whitespace-pre-wrap break-all max-h-24 overflow-auto">
{diff.old_block.split('\n').slice(0, 8).map(l => '- ' + l).join('\n')}{diff.old_block.split('\n').length > 8 ? '\n…' : ''}
                              </pre>
                            )}
                            {diff.new_block && (
                              <pre className="px-2 py-1 bg-emerald-50 text-emerald-800 whitespace-pre-wrap break-all max-h-24 overflow-auto">
{diff.new_block.split('\n').slice(0, 8).map(l => '+ ' + l).join('\n')}{diff.new_block.split('\n').length > 8 ? '\n…' : ''}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {submitting && (
              <div className="flex items-start gap-2">
                <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-white text-[10px] font-bold" style={{ background: '#2d6a4f' }}>AI</div>
                <div className="flex items-center gap-1.5 px-3 py-2 bg-white border border-stone-200 rounded-2xl">
                  <div className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="border-t border-stone-300 px-3 pt-3 pb-3 space-y-2.5 relative" style={{ background: 'linear-gradient(135deg, #e8e4df 0%, #f0ece7 40%, #e8e4df 100%)' }}>

            {result && (
              <div className="flex items-center gap-2 text-xs bg-white border border-stone-200 rounded-xl px-3 py-1.5">
                {!['review', 'failed', 'rejected', 'pending_review'].includes(result.status) && (
                  <div className="w-2.5 h-2.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                )}
                <span className={`${STATUS_COLORS[result.status] || 'text-gray-500'} flex-shrink-0 font-medium`}>{STATUS_LABELS[result.status] || result.status}</span>
                {result.message && result.status !== 'review' && <span className="text-gray-400 truncate">{result.message}</span>}
              </div>
            )}

            {result?.status === 'generating_code' && streamingTokens && (
              <div className="bg-gray-50 border border-stone-200 rounded-xl px-2 py-1">
                <pre className="text-[10px] text-gray-500 font-mono whitespace-pre-wrap max-h-10 overflow-hidden">{streamingTokens.slice(-150)}</pre>
              </div>
            )}

            {pendingDiff && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 flex items-center gap-2">
                <span className="text-xs text-blue-700 flex-1">Preview applied. Accept or reject.</span>
                <button onClick={rejectChange} className="px-2.5 py-1 text-[11px] font-medium bg-white border border-red-200 text-red-600 rounded-lg hover:bg-red-50">Reject</button>
                <button onClick={applyChange} className="px-2.5 py-1 text-[11px] font-medium bg-green-600 text-white rounded-lg hover:bg-green-700">Accept</button>
              </div>
            )}

            {historyOpen && (
              <>
                <div className="fixed inset-0" style={{ zIndex: 25 }} onClick={() => setHistoryOpen(false)} />
                <div className="absolute bottom-full mb-2 left-3 right-3 bg-white border border-gray-200 rounded-xl shadow-2xl animate-slideUp" style={{ zIndex: 30 }}>
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
              </>
            )}

            {(imageLoading || image) && (
              <div className="flex items-center gap-2">
                {imageLoading && (
                  <div className="h-12 w-16 rounded-xl border-2 border-stone-300 bg-stone-100 flex items-center justify-center shadow">
                    <div className="w-4 h-4 border-2 border-stone-400 border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
                {image && !imageLoading && (
                  <div className="relative">
                    <img src={image.preview} alt="Screenshot" className="h-12 rounded-xl border-2 border-stone-300 object-cover shadow" />
                    <button type="button" onClick={() => setImage(null)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-stone-700 text-white rounded-full text-xs flex items-center justify-center hover:bg-red-500 shadow">×</button>
                  </div>
                )}
              </div>
            )}

            <form onSubmit={handleSubmit}>
              <input type="text" value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(e); } }}
                onPaste={handlePaste}
                placeholder="Describe your design change..."
                disabled={submitting}
                className="w-full px-4 py-3 bg-white border-2 border-stone-300 rounded-2xl text-sm text-black shadow-inner focus:ring-2 focus:ring-emerald-400 focus:border-emerald-400 disabled:opacity-50 transition-all placeholder:text-stone-400"
              />
            </form>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-px rounded-xl border-2 border-stone-300 flex-shrink-0 p-0.5" style={{ background: 'linear-gradient(180deg, #f5f0eb, #ebe5de)' }}>
                <button type="button" onClick={(e) => { e.stopPropagation(); setHistoryOpen(v => !v); }}
                  title="Prompt history"
                  className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${historyOpen ? 'bg-emerald-100 text-emerald-700' : 'text-stone-600 hover:bg-white/60'}`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                  {history.length > 0 && <span className="bg-stone-400 text-white text-[10px] px-1 rounded-full font-bold">{history.length}</span>}
                </button>
                <div className="w-px h-4 bg-stone-300" />
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
                  onChange={e => { loadImageFile(e.target.files[0]); e.target.value = ''; }} />
                <button type="button" onClick={() => fileInputRef.current?.click()}
                  title="Upload screenshot"
                  className="px-2 py-1.5 rounded-lg text-xs text-stone-600 hover:bg-white/60 transition-colors">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                </button>
              </div>

              {currentPageUrl && (
                <div className="flex-1 min-w-0 flex items-center gap-1.5 rounded-xl border-2 border-stone-300 px-2 py-1.5 overflow-hidden" style={{ background: 'linear-gradient(180deg, #f5f0eb, #ebe5de)' }} title={currentPageUrl}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-500 flex-shrink-0">
                    <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
                  </svg>
                  <span className="text-[10px] text-stone-600 truncate font-medium">{currentPageUrl.replace(project.project_url, '') || '/'}</span>
                </div>
              )}

              <button type="button" onClick={handleSubmit} disabled={submitting || imageLoading || prompt.trim().length < 3}
                className="h-9 px-4 text-white text-xs font-semibold rounded-xl disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-md hover:shadow-lg flex items-center gap-1.5 ml-auto flex-shrink-0"
                style={{ background: submitting ? '#5a8a7a' : 'linear-gradient(135deg, #1b4332, #2d6a4f)' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                {submitting ? '...' : 'Send'}
              </button>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-stone-300/50">
              <div className="flex items-center gap-1.5">
                {chatMessages.length > 0 && (
                  <button onClick={clearChat} className="text-[10px] px-2 py-1 text-stone-500 hover:text-stone-700 transition-colors">New chat</button>
                )}
                {result?.status === 'review' && lastAppliedId && (
                  <button onClick={handleRestore} className="text-[10px] px-2 py-1 text-amber-700 bg-amber-50 border border-amber-200 rounded-md hover:bg-amber-100 transition-colors font-medium">Undo last</button>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={handleReset} disabled={resetting}
                  className="text-[10px] px-2 py-1 border-2 border-stone-300 text-stone-600 rounded-lg hover:bg-white hover:border-red-300 hover:text-red-600 transition-colors disabled:opacity-50 font-medium" style={{ background: 'linear-gradient(180deg, #f5f0eb, #ebe5de)' }}>
                  {resetting ? '...' : 'Reset'}
                </button>
                <button type="button" onClick={() => { setCommitMsg(''); setPushModalOpen(true); }}
                  className="text-[10px] px-2 py-1 text-white rounded-lg transition-all font-semibold shadow-sm hover:shadow-md"
                  style={{ background: 'linear-gradient(135deg, #1b4332, #2d6a4f)' }}>
                  Push
                </button>
              </div>
            </div>
          </div>
        </aside>

        <div className="flex-1 flex flex-col overflow-hidden min-w-0">

          <div className="flex-1 overflow-hidden relative">
            <iframe
              ref={iframeRef}
              src="/preview/"
              className="w-full h-full border-0"
              title={project.display_name}
              onLoad={() => {
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
            {highlightRect && (
              <div className="absolute pointer-events-none transition-all duration-500 ease-out"
                style={{
                  top: highlightRect.top,
                  left: highlightRect.left,
                  width: highlightRect.width,
                  height: highlightRect.isText ? 'auto' : highlightRect.height,
                  border: highlightRect.isText ? 'none' : '3px solid #2d6a4f',
                  borderRadius: highlightRect.isText ? '4px' : '8px',
                  background: highlightRect.isText ? 'none' : 'rgba(45, 106, 79, 0.05)',
                  boxShadow: highlightRect.isText ? 'none' : '0 0 0 4000px rgba(0, 0, 0, 0.12)',
                  zIndex: 5
                }}>
                <div className={`absolute left-2 text-white text-xs px-2 py-1 rounded shadow font-medium ${highlightRect.isText ? '-top-6' : '-top-7'}`}
                  style={{ background: highlightRect.isText ? '#b45309' : '#2d6a4f' }}>
                  {highlightRect.isText ? 'Text: ' : 'Section: '}{selectedElement?.section || 'Selected'}
                </div>
              </div>
            )}
            {currentPageUrl && (
              <div className="absolute bottom-2 left-2 bg-black/50 text-white text-xs font-mono px-2 py-1 rounded pointer-events-none">
                {currentPageUrl.replace(project.project_url, '') || '/'}
              </div>
            )}
          </div>

        </div>
      </div>

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
    </div>
  );
}
