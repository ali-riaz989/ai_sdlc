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
  const [sectionConfirm, setSectionConfirm] = useState(null);
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

  // Highlight the target in the iframe — text element or full section
  function highlightSection(sectionInfo, userPrompt = '') {
    if (!iframeRef.current || !sectionInfo) { setHighlightRect(null); return; }

    try {
      const doc = iframeRef.current.contentDocument;
      if (!doc) throw new Error('cross-origin');

      const heading = sectionInfo?.target_section;
      if (!heading) { setHighlightRect(null); return; }

      const keywords = heading.toLowerCase().split(/\W+/).filter(w => w.length > 2);
      const prompt = (userPrompt || '').toLowerCase();

      // Determine if user wants a text-level or section-level change
      const isTextChange = /chang|replac|updat|set|rename|heading|title|text|h1|h2|h3|h4/.test(prompt)
        && !/section|image|background|layout|style|block|area/.test(prompt);

      // Find the matching heading element first
      let headingEl = null;
      const headings = doc.querySelectorAll('h1,h2,h3,h4,h5,h6');
      for (const h of headings) {
        const hText = h.innerText?.toLowerCase() || '';
        const matchCount = keywords.filter(k => hText.includes(k)).length;
        if (matchCount >= Math.min(2, keywords.length)) {
          headingEl = h;
          break;
        }
      }

      // Choose what to highlight
      let targetEl;
      let highlightStyle;

      if (isTextChange && headingEl) {
        // Text change → highlight just the heading element
        targetEl = headingEl;
        highlightStyle = {
          outline: 'none',
          background: 'rgba(45, 106, 79, 0.15)',
          boxShadow: '0 0 0 4px rgba(45, 106, 79, 0.3)',
          borderRadius: '4px',
          transition: 'all 0.3s ease'
        };
      } else {
        // Section change → highlight the whole section with a rectangle
        targetEl = headingEl?.closest('section') || headingEl?.parentElement || null;
        highlightStyle = {
          outline: '3px solid #2d6a4f',
          outlineOffset: '4px',
          borderRadius: '8px',
          transition: 'outline 0.3s ease'
        };
      }

      if (!targetEl) { setHighlightRect(null); return; }

      // Scroll into view
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Apply highlight styles
      Object.assign(targetEl.style, highlightStyle);
      iframeRef.current._highlightedEl = targetEl;
      iframeRef.current._highlightStyles = highlightStyle;

      // Set overlay rect for the label
      setTimeout(() => {
        try {
          const containerRect = iframeRef.current.parentElement.getBoundingClientRect();
          const iframeRect = iframeRef.current.getBoundingClientRect();
          const elRect = targetEl.getBoundingClientRect();
          setHighlightRect({
            top: elRect.top + (iframeRect.top - containerRect.top),
            left: elRect.left,
            width: elRect.width,
            height: Math.min(elRect.height, 400),
            isText: isTextChange
          });
        } catch {}
      }, 500); // wait for scroll to finish
    } catch {
      setHighlightRect(null);
    }
  }

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
  function addChat(role, text, type = 'text') {
    setChatMessages(prev => [...prev, { role, text, type, id: Date.now() + Math.random() }]);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
  }
  function clearChat() { setChatMessages([]); }

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
      target.style.outline = '3px solid #dc2626';
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
      const el = hoveredEl || e.target;

      // Find the parent section
      const section = el.closest('section') || el.closest('[class*="section"]') || el.closest('[class*="area"]');
      const heading = section?.querySelector('h1,h2,h3,h4')?.innerText?.trim() || '';

      // Get element info
      const info = {
        tag: el.tagName.toLowerCase(),
        text: el.innerText?.trim().substring(0, 100) || '',
        classes: el.className?.substring(0, 80) || '',
        section: heading || section?.className?.substring(0, 60) || 'unknown section',
        isImage: el.tagName === 'IMG',
        src: el.tagName === 'IMG' ? el.src?.substring(0, 100) : null
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
        outline: '4px solid #dc2626',
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

  async function confirmSection() {
    if (!result?.id) return;
    addChat('user', 'Yes, edit this section');
    clearHighlight();
    try {
      setSectionConfirm(null);
      setResult(prev => ({ ...prev, status: 'generating_code', message: 'Applying change…' }));
      addChat('ai', 'Making the change...', 'status');
      await apiClient.confirmSection(result.id);
    } catch (err) {
      setResult(prev => ({ ...prev, status: 'failed', message: err.response?.data?.error || 'Confirm failed' }));
      addChat('ai', 'Failed: ' + (err.response?.data?.error || 'Unknown error'), 'error');
      setSectionConfirm(null);
    }
  }

  async function declineSection() {
    if (!result?.id) return;
    addChat('user', 'No, wrong section');
    addChat('ai', 'Got it. Tell me which section you meant, or describe the change differently.', 'text');
    clearHighlight();
    try { await apiClient.rejectChangeRequest(result.id); } catch {}
    setSectionConfirm(null);
    setActivePrompt(null);
    setResult(null);
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
        // If user clicked on a specific element, pass it so backend skips Phase 1
        selected_element: selectedElement || null,
        ...(submittedImage && {
          image_base64: submittedImage.base64,
          image_media_type: submittedImage.mediaType
        })
      });
      // Clear selection after submit
      setSelectedElement(null);
      clearHighlight();
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
          // confirm_section: show the section confirmation UI
          if (s === 'confirm_section') {
            clearInterval(pollInterval);
            setResult(prev => ({ ...prev, id: cr.id, status: s }));
            setStreamingTokens('');
            // Fetch section info from the change request
            try {
              const detail = await apiClient.getChangeRequest(cr.id);
              console.log('confirm_section detail:', JSON.stringify(detail.data?.generated_code));
              if (detail.data?.generated_code?.length) {
                const info = JSON.parse(detail.data.generated_code[0].diff || '{}');
                console.log('sectionConfirm set:', info.target_section);
                setSectionConfirm(info);
                highlightSection(info, detail.data?.prompt || '');
                addChat('ai', `I found the "${info.target_section}" section. ${info.reasoning || ''} Should I edit this?`, 'confirm');
              } else {
                console.log('No generated_code in response');
              }
            } catch (e) { console.error('confirm fetch error:', e); }
            // Start polling for post-confirm status
            const cp = setInterval(async () => {
              try {
                const p = await apiClient.getChangeRequest(cr.id);
                const st = p.data?.status;
                if (st === 'pending_review') { clearInterval(cp); setResult(prev => ({ ...prev, status: st, message: 'Preview ready' })); setPendingDiff({ diff: [] }); setSectionConfirm(null); reloadIframe(); addChat('ai', 'Done! Check the preview above. Accept or reject the change.', 'success'); }
                else if (st === 'failed') { clearInterval(cp); const reason = p.data?.error_message || p.data?.message || 'The change failed. Try describing it differently.'; setResult(prev => ({ ...prev, status: 'failed', message: reason })); setSectionConfirm(null); setActivePrompt(null); addChat('ai', reason, 'error'); setTimeout(() => setResult(null), 8000); }
              } catch {}
            }, 2000);
            setTimeout(() => clearInterval(cp), 120000);
            return;
          }
          // generating_code: keep polling
          if (s === 'generating_code') return;
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
            setSectionConfirm(null);
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
          <button onClick={() => { clearHighlight(); setSelectMode(v => !v); }}
            className={`text-xs px-2 py-1 rounded transition-colors ${selectMode ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {selectMode ? '✓ Selecting...' : '⊹ Select'}
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
          src="/preview/"
          className="w-full h-full border-0"
          title={project.display_name}
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
        {/* Highlight overlay label */}
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
              {highlightRect.isText ? 'Text: ' : 'Section: '}{sectionConfirm?.target_section || 'Selected'}
            </div>
          </div>
        )}

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
        {result && result.status !== 'confirm_section' && (
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
        {/* AI asks: "Is this the right section?" — chat style */}
        {sectionConfirm && result?.status === 'confirm_section' && (
          <div className="border-t border-stone-200 px-4 py-3" style={{ background: 'linear-gradient(135deg, #f5f0eb, #ebe5de)' }}>
            <div className="w-[65%] mx-auto">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-white text-xs font-bold" style={{ background: '#2d6a4f' }}>AI</div>
                <div className="flex-1">
                  <p className="text-sm text-gray-800 leading-relaxed">
                    I think you want to edit the <strong>&ldquo;{sectionConfirm.target_section || 'this section'}&rdquo;</strong> section.
                    {sectionConfirm.reasoning && <span className="text-gray-500"> {sectionConfirm.reasoning}</span>}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    {sectionConfirm.confidence === 'high' ? "I'm quite sure about this." : sectionConfirm.confidence === 'medium' ? "I'm fairly sure, but please confirm." : "I'm not very sure — please check."}
                  </p>
                </div>
              </div>
              <div className="flex gap-2 ml-10">
                <button onClick={declineSection} className="px-4 py-2 text-sm font-medium bg-white border-2 border-stone-300 text-stone-600 rounded-xl hover:bg-stone-50 transition-colors">No, wrong section</button>
                <button onClick={confirmSection} className="px-4 py-2 text-sm font-medium text-white rounded-xl hover:opacity-90 transition-colors" style={{ background: 'linear-gradient(135deg, #1b4332, #2d6a4f)' }}>Yes, edit this</button>
              </div>
            </div>
          </div>
        )}

        {/* Accept / Reject after preview */}
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

            {/* ── Chat thread ── */}
            {chatMessages.length > 0 && (
              <div className="mb-3 max-h-48 overflow-y-auto space-y-2 pr-1" style={{ scrollbarWidth: 'thin' }}>
                {chatMessages.map(msg => (
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
                        : 'bg-white text-gray-700 border border-stone-200'
                    }`} style={msg.role === 'user' ? { background: 'linear-gradient(135deg, #2d6a4f, #40916c)' } : {}}>
                      {msg.text}
                    </div>
                  </div>
                ))}
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
                {chatMessages.length > 0 && (
                  <button onClick={clearChat} className="text-[11px] px-2.5 py-1 text-stone-500 hover:text-stone-700 transition-colors">New chat</button>
                )}
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
