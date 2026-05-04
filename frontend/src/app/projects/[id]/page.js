'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
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
  // New-page modal state
  const [newPageOpen, setNewPageOpen] = useState(false);
  const [newPageUrl, setNewPageUrl] = useState('');
  const [newPageError, setNewPageError] = useState('');
  const [newPageCreating, setNewPageCreating] = useState(false);
  const [availableSections, setAvailableSections] = useState([]); // [{ name, displayName }]
  const [chosenSections, setChosenSections] = useState([]); // [name, name, ...] in order
  const [dragIndex, setDragIndex] = useState(null); // index of chosen item currently being dragged
  const [dragOverIndex, setDragOverIndex] = useState(null); // index where drop indicator shows
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
      const doc = iframeRef.current?.contentDocument;
      const ovId = iframeRef.current?._selectionOverlayId || '__lgc_select_overlay__';
      const ov = doc?.getElementById(ovId);
      if (ov) ov.remove();
      iframeRef.current._highlightedEl = null;
      iframeRef.current._selectionOverlayId = null;
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

  // Rotating "thinking" status word, à la Claude Code. Cycles every ~2.4s while a
  // request is in flight; a small Claude-mark logo dances next to it.
  const STATUS_WORDS = useMemo(() => [
    'Thinking', 'Generating', 'Noodling', 'Cooking', 'Sussing', 'Pondering',
    'Booping', 'Mulling', 'Musing', 'Moseying', 'Deciphering', 'Churning',
    'Accomplishing', 'Incubating', 'Envisioning', 'Imagining', 'Determining',
    'Clauding', 'Brewing', 'Whirring', 'Meandering', 'Wrangling', 'Calculating',
    'Spinning', 'Synthesizing', 'Percolating', 'Contemplating', 'Creating',
    'Deliberating', 'Tinkering', 'Plotting', 'Reasoning', 'Hatching',
  ], []);
  const [statusWord, setStatusWord] = useState(STATUS_WORDS[0]);
  // "In flight" covers the whole edit lifecycle, not just the brief HTTP submit window.
  // While the backend is processing (pending → analyzing → generating_code → pending_review),
  // the dancing-Claude indicator keeps rotating through fun verbs.
  const isInFlight = submitting || (result && !['review', 'failed', 'rejected'].includes(result.status));
  useEffect(() => {
    if (!isInFlight) return;
    let lastIdx = -1;
    let timer;
    // Random interval per cycle — feels less mechanical than a metronome and gives
    // the impression of variable work being done (some thoughts come fast, some
    // take longer). Range: 0.8s – 3.2s.
    const tick = () => {
      let i = Math.floor(Math.random() * STATUS_WORDS.length);
      if (i === lastIdx) i = (i + 1) % STATUS_WORDS.length;
      lastIdx = i;
      setStatusWord(STATUS_WORDS[i]);
      const nextDelay = 800 + Math.floor(Math.random() * 2400);
      timer = setTimeout(tick, nextDelay);
    };
    tick();
    return () => clearTimeout(timer);
  }, [isInFlight, STATUS_WORDS]);

  // Per-message expand/collapse state for file_change diff bubbles + per-request
  // revert tracking so the button knows whether it was already used.
  const [expandedDiffs, setExpandedDiffs] = useState(() => new Set());
  const [revertedRequests, setRevertedRequests] = useState(() => new Set());
  function toggleDiffExpanded(msgId) {
    setExpandedDiffs(prev => { const next = new Set(prev); next.has(msgId) ? next.delete(msgId) : next.add(msgId); return next; });
  }
  async function revertChangeRequest(reqId) {
    if (!reqId || revertedRequests.has(reqId)) return;
    try {
      await apiClient.restoreChangeRequest(reqId);
      setRevertedRequests(prev => { const next = new Set(prev); next.add(reqId); return next; });
      reloadIframe();
      addChat('ai', `Reverted change ${reqId.substring(0, 8)} — files restored to their pre-edit state.`, 'success');
    } catch (err) {
      addChat('ai', `Couldn't revert: ${err.response?.data?.error || err.message}`, 'error');
    }
  }

  // Dedup failure messages: socket and polling can both fire 'failed' for the same request.
  const handledFailuresRef = useRef(new Set());

  // Heuristic: an AI "failure" message that asks for clarification (ambiguous element,
  // multiple matches, "did you mean…") is really a question, not an error. Render it
  // dark blue rather than alarming red.
  function classifyAiFailureMessage(s) {
    if (!s) return 'error';
    const t = s.toLowerCase();
    const looksLikeQuestion = t.includes('?')
      || /\b(ambiguous|clarify|please specify|please clarify|did you mean|do you want|do you mean|which (one|element|section)|please choose|which of)\b/.test(t);
    return looksLikeQuestion ? 'question' : 'error';
  }

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

  // Listen for postMessage from iframe (cross-origin URL tracking).
  // Filter to ONLY the main preview iframe — modal thumbnails also fire these beacons
  // and their preview-section URLs would otherwise pollute currentPageUrl + spam the
  // route resolver.
  useEffect(() => {
    const handler = (e) => {
      if (e.source && iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
      if (e.data?.type === 'iframe-navigation' && e.data?.url) {
        const url = e.data.url.split('?')[0];
        if (url.includes('/__preview_section/')) return; // belt-and-braces guard
        setCurrentPageUrl(url);
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

    // ── Overlay-based highlight ─────────────────────────────────────────────
    // Drawing rings on the element itself collides with host CSS and parent
    // overflow:hidden. Instead, paint a separate div positioned OVER the element.
    //
    // Implementation choices:
    //  - position: fixed + viewport coords from getBoundingClientRect — bulletproof
    //    against `transform` on any ancestor (which would break position:absolute).
    //  - Appended to documentElement, not body — dodges any body-level overflow:hidden
    //    or unusual sizing the host page set up.
    //  - z-index 2147483647 (max int) so host CSS can't paint over it.
    //  - One reused node; we track which element it's currently following in `pinnedEl`,
    //    and a scroll/resize listener keeps it glued to that element while it moves.
    const OVERLAY_ID = '__lgc_select_overlay__';
    let pinnedEl = null;          // the element the overlay is currently tracking

    const ensureOverlay = (color) => {
      const doc = getDoc();
      if (!doc || !doc.documentElement) return null;
      let ov = doc.getElementById(OVERLAY_ID);
      if (!ov) {
        ov = doc.createElement('div');
        ov.id = OVERLAY_ID;
        ov.style.cssText =
          'position:fixed;pointer-events:none;box-sizing:border-box;' +
          'z-index:2147483647;display:block;background:transparent;' +
          'transition:top 0.1s linear,left 0.1s linear,width 0.1s linear,height 0.1s linear;';
        doc.documentElement.appendChild(ov);
      }
      ov.style.border = `3px solid ${color}`;
      ov.style.display = 'block';
      return ov;
    };

    const positionOverlay = (ov, el) => {
      if (!ov || !el || !el.getBoundingClientRect) return;
      const rect = el.getBoundingClientRect();
      // position:fixed → viewport coords directly, no scroll math
      ov.style.top = rect.top + 'px';
      ov.style.left = rect.left + 'px';
      ov.style.width = rect.width + 'px';
      ov.style.height = rect.height + 'px';
      try {
        const cs = el.ownerDocument.defaultView.getComputedStyle(el);
        ov.style.borderRadius = cs.borderRadius || '0';
      } catch { ov.style.borderRadius = '0'; }
    };

    const removeOverlay = () => {
      const doc = getDoc();
      if (!doc) return;
      const ov = doc.getElementById(OVERLAY_ID);
      if (ov) ov.remove();
      pinnedEl = null;
    };

    // Keep the overlay glued to the pinned element as the iframe scrolls/resizes
    const reposition = () => {
      if (!pinnedEl) return;
      const doc = getDoc();
      const ov = doc?.getElementById(OVERLAY_ID);
      if (!ov) return;
      // If the element is gone or detached, drop the overlay
      if (!doc.contains(pinnedEl)) { removeOverlay(); return; }
      positionOverlay(ov, pinnedEl);
    };

    const onMouseOver = (e) => {
      const el = e.target;
      // Walk up from tiny inline tags to a meaningful parent
      let target = el;
      const smallTags = new Set(['SPAN', 'A', 'STRONG', 'EM', 'B', 'I', 'BR', 'IMG']);
      while (target && smallTags.has(target.tagName) && target.parentElement) {
        target = target.parentElement;
      }
      if (target === hoveredEl) return;
      target.style.cursor = 'pointer';
      hoveredEl = target;
      pinnedEl = target;
      const ov = ensureOverlay('#16a34a');  // green ring on hover
      positionOverlay(ov, target);
    };

    // Note: deliberately no mouseout hide — bubbling mouseout between child nodes
    // would flicker the overlay. The next mouseover repositions; on selectMode exit
    // (cleanup return) we tear down the overlay entirely.

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

      // Disambiguator for repeated identical-looking elements (e.g. 3 testimonial cards
      // with the same heading): walk every element on the page that matches our
      // tag + visible text and find which occurrence-in-DOM-order the clicked one is.
      // Backend uses this to skip past earlier matches when locating in source.
      let occurrenceIndex = 0;
      let occurrenceCount = 1;
      try {
        const doc = el.ownerDocument;
        const myKey = (el.innerText?.trim() || '').substring(0, 80);
        if (myKey.length > 2) {
          const tagMatches = doc.querySelectorAll(el.tagName);
          const peers = [];
          for (const c of tagMatches) {
            const k = (c.innerText?.trim() || '').substring(0, 80);
            if (k === myKey) peers.push(c);
          }
          occurrenceIndex = Math.max(0, peers.indexOf(el));
          occurrenceCount = peers.length;
        }
      } catch { /* cross-origin etc. */ }

      // Read the data-blade-src="<file>:<line>" attribute injected by the LGC project's
      // Blade compiler. This is the AUTHORITATIVE source location — no text matching needed.
      // Walk up if the clicked node itself doesn't carry one (rare; covers JS-injected nodes).
      let bladeSrc = null;
      {
        let cursor = el;
        const docRoot = el.ownerDocument?.documentElement;
        while (cursor && cursor !== docRoot) {
          const v = cursor.getAttribute && cursor.getAttribute('data-blade-src');
          if (v) { bladeSrc = v; break; }
          cursor = cursor.parentElement;
        }
      }

      // Get element info
      const info = {
        tag: el.tagName.toLowerCase(),
        text: el.innerText?.trim().substring(0, 100) || '',
        classes: el.className?.substring(0, 80) || '',
        section: sectionLabel || 'unknown section',
        isImage: el.tagName === 'IMG',
        src: el.tagName === 'IMG' ? el.src?.substring(0, 200) : null,
        occurrenceIndex, // 0-based: when N peers share the same tag+text, this is which one was clicked
        occurrenceCount,
        bladeSrc,        // "<relative path>:<line>" — set by Blade compiler attribute injection
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
      // Detect clicks that land in a shared LAYOUT file (header / footer / sidebar / etc.)
      // Editing those affects every page that extends the layout — warn explicitly.
      const isInLayout = bladeSrc && /\/(layouts|partials)\//.test(bladeSrc);
      const layoutFile = isInLayout ? bladeSrc.split(':')[0] : null;
      addChat('ai', `Selected: ${elDesc}. What would you like to do? (change text, update style, replace image, etc.)`, 'text');
      if (isInLayout) {
        addChat(
          'ai',
          `Heads up — this element is in the shared layout "${layoutFile}". Any edit will affect EVERY page that uses this layout, not just the current one. If you only want to change this page, click on a page-specific element (the page's main content area) instead.`,
          'question'
        );
      }

      // Selected state: swap the existing hover overlay from green to red and pin its
      // position over the SELECTED element (which may differ from hoveredEl after the
      // image-drill-down). Update pinnedEl so the scroll/resize listener tracks the
      // selected element, not the previously hovered wrapper.
      pinnedEl = el;
      const ov = ensureOverlay('#dc2626');
      positionOverlay(ov, el);
      iframeRef.current._highlightedEl = el;
      iframeRef.current._selectionOverlayId = OVERLAY_ID;

      // Clean hover listeners (selection complete — no more hover tracking needed).
      // Scroll/resize listeners stay attached until the useEffect cleanup; they'll keep
      // the red overlay pinned to the selected element if the iframe scrolls.
      const doc = getDoc();
      if (doc) {
        doc.removeEventListener('mouseover', onMouseOver);
        doc.removeEventListener('click', onClick, true);
      }
    };

    const doc = getDoc();
    const win = doc?.defaultView;
    if (doc) {
      doc.addEventListener('mouseover', onMouseOver);
      doc.addEventListener('click', onClick, true);
      win?.addEventListener('scroll', reposition, true);
      win?.addEventListener('resize', reposition);
      // Change cursor for the whole iframe
      doc.body.style.cursor = 'crosshair';
    }

    return () => {
      const doc = getDoc();
      const win = doc?.defaultView;
      if (doc) {
        doc.removeEventListener('mouseover', onMouseOver);
        doc.removeEventListener('click', onClick, true);
        doc.body.style.cursor = '';
      }
      win?.removeEventListener('scroll', reposition, true);
      win?.removeEventListener('resize', reposition);
      if (hoveredEl) hoveredEl.style.removeProperty('cursor');
      // If selection happened, the click handler stored _highlightedEl and pinned the
      // red overlay — leave that overlay in place so the red ring stays visible.
      // Otherwise (user toggled select-mode off without picking anything), tear it down.
      if (!iframeRef.current?._highlightedEl) removeOverlay();
    };
  }, [selectMode]);

  // Keep the red "selected" overlay glued to the chosen element while it exists.
  // Runs independently of selectMode — the moment a selection is committed (click
  // handler sets selectedElement + _highlightedEl), this effect attaches scroll
  // and resize listeners on the iframe window so the overlay tracks the element
  // as the user scrolls. Tears down when the selection clears.
  useEffect(() => {
    if (!selectedElement || !iframeRef.current) return;
    const doc = (() => { try { return iframeRef.current?.contentDocument; } catch { return null; } })();
    const win = doc?.defaultView;
    if (!doc || !win) return;

    const OVERLAY_ID = '__lgc_select_overlay__';
    const reposition = () => {
      const el = iframeRef.current?._highlightedEl;
      const ov = doc.getElementById(OVERLAY_ID);
      if (!el || !ov) return;
      // Element was detached from DOM (e.g. iframe re-rendered) — drop the overlay.
      if (!doc.contains(el)) { ov.remove(); return; }
      const rect = el.getBoundingClientRect();
      ov.style.top = rect.top + 'px';
      ov.style.left = rect.left + 'px';
      ov.style.width = rect.width + 'px';
      ov.style.height = rect.height + 'px';
    };
    // Initial reposition in case the iframe scrolled before this effect ran.
    reposition();
    win.addEventListener('scroll', reposition, true);
    win.addEventListener('resize', reposition);
    return () => {
      win.removeEventListener('scroll', reposition, true);
      win.removeEventListener('resize', reposition);
    };
  }, [selectedElement]);

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

  // applyChange / rejectChange were the manual Accept/Reject handlers — removed
  // because edits now auto-accept on pending_review and undo happens via the
  // per-message Revert button (see revertChangeRequest above).

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
      setResult({ status: 'review', message: `Pushed to ${project.push_branch || project.repo_branch}` });
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

  // ── New-page modal: load section list, manage choices, submit ─────────────
  async function openNewPage() {
    setNewPageError('');
    setNewPageUrl('');
    setChosenSections([]);
    setNewPageOpen(true);
    // Ensure the preview wrapper view + /__preview_section/{name} route exist in
    // the Laravel project, so the iframe thumbnails below have something to render.
    apiClient.ensureSectionPreviews(id).catch(() => {});
    if (availableSections.length === 0) {
      try {
        const res = await apiClient.listSections(id);
        setAvailableSections(res.data?.sections || []);
      } catch {
        setNewPageError('Failed to load sections');
      }
    }
  }

  function toggleSection(name) {
    setChosenSections(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);
  }

  function moveSection(name, dir) {
    setChosenSections(prev => {
      const i = prev.indexOf(name);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  // Drag-to-reorder for the chosen-sections list. Pure HTML5 drag/drop, no deps.
  function reorderChosenSections(fromIdx, toIdx) {
    if (fromIdx === toIdx || fromIdx == null || toIdx == null) return;
    setChosenSections(prev => {
      if (fromIdx < 0 || fromIdx >= prev.length || toIdx < 0 || toIdx > prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      // After splice, dropping at an index >= source shifts down by 1
      const adjusted = toIdx > fromIdx ? toIdx - 1 : toIdx;
      next.splice(adjusted, 0, moved);
      return next;
    });
  }

  async function submitNewPage() {
    setNewPageError('');
    if (!newPageUrl.trim()) { setNewPageError('Enter a URL like /play/coaching'); return; }
    if (chosenSections.length === 0) { setNewPageError('Pick at least one section'); return; }
    setNewPageCreating(true);
    try {
      const res = await apiClient.createPage(id, { url: newPageUrl.trim(), sections: chosenSections });
      const createdUrl = res.data?.url;
      setNewPageOpen(false);
      setChosenSections([]);
      setNewPageUrl('');
      // Navigate the iframe to the freshly-scaffolded page
      if (createdUrl && iframeRef.current) {
        iframeRef.current.src = '/preview' + createdUrl + '?_t=' + Date.now();
      }
      addChat('ai', `Page created at ${createdUrl} with ${chosenSections.length} section${chosenSections.length === 1 ? '' : 's'}.`, 'success');
    } catch (err) {
      setNewPageError(err.response?.data?.error || 'Failed to create page');
    } finally {
      setNewPageCreating(false);
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
      // Edits now auto-accept the moment they reach pending_review (see socket /
      // poll handlers). No need to nudge a stuck preview into review here — by
      // the time the next prompt arrives, the previous one is already at 'review'
      // OR has its file_change bubble in chat with a Revert button.

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

      // Capture iframe viewport so Claude can pick the right Bootstrap breakpoint when
      // the user says "3 per row" / "responsive" / etc. Cross-origin guard kept narrow.
      let iframeViewport = null;
      try {
        const cw = iframeRef.current?.contentWindow;
        const w = cw?.innerWidth;
        const h = cw?.innerHeight;
        if (typeof w === 'number' && typeof h === 'number') {
          // Map width to a Bootstrap-5 breakpoint label so the hint is concrete in the prompt
          let bp = 'xs';
          if (w >= 1400) bp = 'xxl';
          else if (w >= 1200) bp = 'xl';
          else if (w >= 992) bp = 'lg';
          else if (w >= 768) bp = 'md';
          else if (w >= 576) bp = 'sm';
          iframeViewport = { width: w, height: h, breakpoint: bp };
        }
      } catch { /* cross-origin — leave null */ }

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
        iframe_viewport: iframeViewport,
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
          // Snapshot the file list + diffs into chat history. Each bubble has its
          // own Revert button, which is now the only way to undo a change.
          const snapshot = filesRef.current.map(f => ({ ...f, status: f.status === 'generating' ? 'done' : f.status }));
          if (snapshot.length) {
            addChat('ai', '', 'file_change', { files: snapshot, diffs: parsed?.diff || [], requestId: cr.id });
            setFiles([]);
          }
          reloadIframe(); // show the live preview immediately
          setStreamingTokens('');
          // Auto-accept: skip the manual Accept/Reject step entirely. The change
          // moves straight to 'review'. If the user wants to undo, they click
          // Revert on the file_change bubble.
          setPendingDiff(null);
          apiClient.applyChangeRequest(cr.id).then(() => {
            setLastAppliedId(cr.id);
          }).catch(() => { /* still good — bubble's Revert remains usable */ });
        }
        if (update.status === 'rejected' || update.status === 'failed') {
          setPendingDiff(null);
          setStreamingTokens('');
          reloadIframe(); // reload to show restored original
          if (update.status === 'failed' && !handledFailuresRef.current.has(cr.id)) {
            handledFailuresRef.current.add(cr.id);
            const reason = update.message || 'The change failed. Try again.';
            addChat('ai', reason, classifyAiFailureMessage(reason));
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
            // Fallback snapshot via polling path, in case the socket update didn't fire
            const snap = filesRef.current.map(f => ({ ...f, status: f.status === 'generating' ? 'done' : f.status }));
            if (snap.length) {
              addChat('ai', '', 'file_change', { files: snap, diffs: [], requestId: cr.id });
              setFiles([]);
            }
            reloadIframe();
            setStreamingTokens('');
            // Auto-accept (mirror of the socket path)
            setPendingDiff(null);
            apiClient.applyChangeRequest(cr.id).then(() => {
              setLastAppliedId(cr.id);
            }).catch(() => {});
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
            // Fetch actual error reason. Skip the chat addition if the socket handler
            // already showed it for this requestId.
            try {
              const detail = await apiClient.getChangeRequest(cr.id);
              const reason = detail.data?.error_message || detail.data?.message || 'The change failed. Try again.';
              setResult(prev => ({ ...prev, status: 'failed', message: reason }));
              if (!handledFailuresRef.current.has(cr.id)) {
                handledFailuresRef.current.add(cr.id);
                addChat('ai', reason, classifyAiFailureMessage(reason));
              }
            } catch {
              if (!handledFailuresRef.current.has(cr.id)) {
                handledFailuresRef.current.add(cr.id);
                addChat('ai', 'The change failed. Try again.', 'error');
              }
            }
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

        <aside className="w-[420px] flex-shrink-0 flex flex-col bg-white border-r border-gray-200">

          {/* Sidebar header — scoped to the chat column only */}
          <header className="bg-white border-b border-gray-200 px-3 py-2 flex-shrink-0 space-y-1">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <button onClick={() => router.push('/')} title="Back" className="text-gray-400 hover:text-gray-700 text-base leading-none flex-shrink-0">←</button>
                <span className="font-medium text-gray-900 truncate text-[13px]">{project.display_name}</span>
                <span className="text-[10px] bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 border border-emerald-100">Live</span>
              </div>
              <div className="flex items-center gap-0.5 flex-shrink-0">
                <button onClick={openNewPage} title="Create a new page from sections"
                  className="text-[11px] px-2 py-1 text-gray-700 rounded-md hover:bg-gray-100 transition-colors font-medium">+ Page</button>
                <button onClick={() => { if (iframeRef.current) { const base = iframeRef.current.src.split('?')[0]; iframeRef.current.src = base + '?_t=' + Date.now(); } }}
                  title="Refresh preview"
                  className="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 transition-colors">↻</button>
                <button onClick={() => { clearHighlight(); setSelectMode(v => !v); }}
                  title={selectMode ? 'Cancel select' : 'Select an element'}
                  className={`text-[11px] px-2 py-1 rounded-md transition-colors ${selectMode ? 'bg-gray-900 text-white' : 'text-gray-700 hover:bg-gray-100'}`}>
                  {selectMode ? '✓ Selecting' : '⊹ Select'}
                </button>
                {result?.status === 'review' && lastAppliedId && (
                  <button onClick={handleRestore} title="Undo last change" className="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 transition-colors">↩</button>
                )}
              </div>
            </div>
            {/* Project URL display removed per request — title + Live badge are enough. */}
          </header>


          <div className={`flex-1 px-4 py-5 space-y-5 bg-white ${chatMessages.length > 0 || submitting || files.length > 0 ? 'overflow-y-auto' : 'overflow-hidden'}`} style={{ scrollbarWidth: 'thin' }}>
            {chatMessages.length === 0 && !submitting && (
              <div className="h-full flex items-center justify-center text-center">
                <div className="text-gray-500 text-xs max-w-[240px] leading-relaxed">
                  Click <span className="font-medium text-gray-700">Select</span> on the top bar, pick an element in the preview, then describe the change below.
                </div>
              </div>
            )}
            {chatMessages.map(msg => {
              if (msg.type === 'file_change' && msg.data) {
                const isExpanded = expandedDiffs.has(msg.id);
                const reqId = msg.data.requestId;
                const isReverted = reqId && revertedRequests.has(reqId);
                const hasAnyDiff = (msg.data.diffs || []).some(d => d.old_block || d.new_block);
                if (isReverted) {
                  // Compact "Restored" card — match Google AI Studio's restored-snapshot look,
                  // with darker borders + text so it reads as a definite state change.
                  return (
                    <div key={msg.id} className="rounded-xl border border-gray-400 bg-gray-50 px-3 py-2 text-xs text-gray-800">
                      <div className="flex items-center gap-1.5 font-semibold text-gray-900">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
                        Restored
                      </div>
                      <div className="mt-0.5 text-[11px] text-gray-700 font-mono">{msg.data.files.map(f => f.file).join(', ')}</div>
                    </div>
                  );
                }
                return (
                  <div key={msg.id} className="rounded-xl border border-gray-400 bg-white">
                    <div className="px-3 py-2 border-b border-gray-200 flex items-center gap-1.5">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      <span className="text-[12px] font-medium text-gray-800 flex-1">Edited {msg.data.files.length} file{msg.data.files.length === 1 ? '' : 's'}</span>
                      {hasAnyDiff && (
                        <button type="button" onClick={() => toggleDiffExpanded(msg.id)}
                          className="text-[11px] text-gray-500 hover:text-gray-800 px-1.5 py-0.5 rounded hover:bg-gray-100 transition-colors">
                          {isExpanded ? 'Hide diff' : 'Show diff'}
                        </button>
                      )}
                    </div>
                    <div className="px-3 py-2 space-y-1.5">
                      {msg.data.files.map(f => {
                        const diff = (msg.data.diffs || []).find(d => d.file_path === f.file);
                        return (
                          <div key={f.file} className="space-y-1.5">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-[12px] font-mono text-gray-800 truncate flex-1" title={f.file}>{f.file}</span>
                              {f.status === 'failed'
                                ? <span className="text-red-500 flex-shrink-0" title="Failed">✗</span>
                                : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-emerald-600 flex-shrink-0"><polyline points="20 6 9 17 4 12"/></svg>}
                            </div>
                            {isExpanded && diff && (diff.old_block || diff.new_block) && (
                              <div className="rounded-md overflow-hidden border border-gray-300 bg-gray-50 text-[10.5px] font-mono leading-relaxed">
                                {diff.old_block && (
                                  <pre className="px-2 py-1 bg-red-50/60 text-red-700 whitespace-pre-wrap break-all max-h-24 overflow-auto">
{diff.old_block.split('\n').slice(0, 8).map(l => '- ' + l).join('\n')}{diff.old_block.split('\n').length > 8 ? '\n…' : ''}
                                  </pre>
                                )}
                                {diff.new_block && (
                                  <pre className="px-2 py-1 bg-emerald-50/60 text-emerald-800 whitespace-pre-wrap break-all max-h-24 overflow-auto">
{diff.new_block.split('\n').slice(0, 8).map(l => '+ ' + l).join('\n')}{diff.new_block.split('\n').length > 8 ? '\n…' : ''}
                                  </pre>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {reqId && (
                      <div className="px-3 py-2 border-t border-gray-200 flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
                          Checkpoint
                        </div>
                        <button type="button" onClick={() => revertChangeRequest(reqId)}
                          title="Restore files to before this change"
                          className="flex items-center gap-1 text-[11px] text-gray-700 hover:text-gray-900 px-2 py-1 rounded-md border border-gray-400 hover:bg-gray-50 transition-colors">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
                          Restore
                        </button>
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : ''}`}>
                  <div className={`max-w-[88%] text-[13px] leading-relaxed ${
                    msg.role === 'user'
                      ? 'rounded-2xl rounded-br-sm bg-gray-200 text-gray-900 px-3.5 py-2'
                      : msg.type === 'error'
                      ? 'rounded-xl bg-red-50 text-red-800 border border-red-300 px-3 py-2 font-medium'
                      : msg.type === 'question'
                      ? 'rounded-xl bg-blue-50 text-blue-900 border border-blue-300 px-3 py-2 font-medium'
                      : msg.type === 'success'
                      ? 'rounded-xl bg-gray-50 text-gray-900 border border-gray-400 px-3 py-2 font-medium'
                      : msg.type === 'confirm'
                      ? 'rounded-xl bg-amber-50 text-amber-900 border border-amber-300 px-3 py-2 font-medium'
                      : 'text-gray-900 whitespace-pre-wrap'
                  }`}>
                    {msg.text}
                  </div>
                </div>
              );
            })}
            {files.length > 0 && (
              <div className="rounded-xl border border-gray-200 bg-white">
                <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-1.5">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  <span className="text-[12px] font-medium text-gray-800 flex-1">Editing {files.length} file{files.length === 1 ? '' : 's'}</span>
                </div>
                <div className="px-3 py-2 space-y-1">
                  {files.map(f => (
                    <div key={f.file} className="flex items-center gap-2 min-w-0">
                      <span className="text-[12px] font-mono text-gray-800 truncate flex-1" title={f.file}>{f.file}</span>
                      {f.status === 'generating'
                        ? <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                        : f.status === 'failed'
                        ? <span className="text-red-500 flex-shrink-0">✗</span>
                        : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-emerald-600 flex-shrink-0"><polyline points="20 6 9 17 4 12"/></svg>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {isInFlight && (
              <div className="flex items-center gap-2 text-gray-700 text-[13px]">
                {/* Claude-mark "dancing" while in flight. The 4-pointed star outline echoes
                    Anthropic's brand mark; rotation+pulse keyframes live in globals.css. */}
                <span className="animate-claude-dance" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-orange-500">
                    <path d="M12 1.5 L13.6 9.4 L21.5 11 L13.6 12.6 L12 20.5 L10.4 12.6 L2.5 11 L10.4 9.4 Z"/>
                  </svg>
                </span>
                {/* key forces re-mount on word change so the fade-in keyframe fires every cycle */}
                <span key={statusWord} className="animate-word-fade text-gray-700">{statusWord}…</span>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="border-t border-gray-200 px-3 pt-3 pb-3 space-y-2.5 relative bg-white">

            {/* In-flight statuses (Queued / Processing… / Editing… / Generating code) are
                represented by the dancing-Claude indicator INSIDE the chat thread —
                no separate pill above the input. Only failures/rejections need a pill
                here; the success "Ready for review" / "Preview ready" state is implicit
                (the file_change bubble in the thread already announces the change). */}
            {result && ['failed', 'rejected'].includes(result.status) && (
              <div className="flex items-center gap-2 text-xs bg-white border border-gray-200 rounded-xl px-3 py-1.5">
                <span className={`${STATUS_COLORS[result.status] || 'text-gray-500'} flex-shrink-0 font-medium`}>{STATUS_LABELS[result.status] || result.status}</span>
                {result.message && <span className="text-gray-400 truncate">{result.message}</span>}
              </div>
            )}

            {result?.status === 'generating_code' && streamingTokens && (
              <div className="bg-gray-50 border border-stone-200 rounded-xl px-2 py-1">
                <pre className="text-[10px] text-gray-500 font-mono whitespace-pre-wrap max-h-10 overflow-hidden">{streamingTokens.slice(-150)}</pre>
              </div>
            )}

            {/* Edits auto-accept now — manual Accept/Reject removed. Use the per-bubble Revert
                button on the file_change message to undo a specific change. */}

            {historyOpen && (
              <>
                <div className="fixed inset-0" style={{ zIndex: 25 }} onClick={() => setHistoryOpen(false)} />
                <div className="absolute bottom-full mb-2 left-3 right-3 bg-white border border-gray-200 rounded-xl shadow-lg" style={{ zIndex: 30 }}>
                  <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
                    <span className="text-[11px] font-medium text-gray-600">Prompt history</span>
                    <button type="button" onClick={(e) => { e.stopPropagation(); setHistoryOpen(false); }}
                      className="w-5 h-5 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700 text-xs">×</button>
                  </div>
                  <div className="overflow-y-auto" style={{ maxHeight: '280px' }}>
                    {history.length === 0 ? (
                      <p className="text-center text-gray-400 text-xs py-6">No changes yet</p>
                    ) : (
                      <ul className="divide-y divide-gray-100">
                        {history.map(cr => (
                          <li key={cr.id} className="px-3 py-2.5 hover:bg-gray-50 cursor-pointer transition-colors"
                            onClick={() => { setPrompt(cr.prompt); setHistoryOpen(false); }}>
                            <p className="text-xs text-gray-800 leading-snug line-clamp-2">{cr.prompt}</p>
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
                  <div className="h-12 w-16 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center">
                    <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
                {image && !imageLoading && (
                  <div className="relative">
                    <img src={image.preview} alt="Screenshot" className="h-12 rounded-lg border border-gray-200 object-cover" />
                    <button type="button" onClick={() => setImage(null)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-700 text-white rounded-full text-xs flex items-center justify-center hover:bg-red-500">×</button>
                  </div>
                )}
              </div>
            )}

            {/* Input — Google AI Studio style: clean white card with the textarea on top
                and a single icon row below (history, attach, current-page chip, send). */}
            {/* Prompt box — always rendered with the prominent "selected" treatment so
                it reads as the primary action target even before focus. Neutral gray, not jet-black. */}
            <div className="rounded-2xl border-2 border-gray-300 bg-white shadow-sm focus-within:border-gray-500 focus-within:shadow-md transition-all">
              <form onSubmit={handleSubmit}>
                <textarea value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                      e.preventDefault();
                      handleSubmit(e);
                    }
                  }}
                  onPaste={handlePaste}
                  placeholder="Make changes, add new features, ask for anything"
                  disabled={submitting}
                  rows={2}
                  className="w-full px-3.5 pt-3 pb-1 bg-transparent text-[13px] text-gray-900 placeholder:text-gray-400 focus:outline-none disabled:opacity-50 resize-none min-h-[44px] max-h-[200px] leading-snug"
                />
              </form>
              <div className="flex items-center gap-1 px-2 pb-2">
                <button type="button" onClick={(e) => { e.stopPropagation(); setHistoryOpen(v => !v); }}
                  title="Prompt history"
                  className={`w-8 h-8 flex items-center justify-center rounded-full transition-colors ${historyOpen ? 'bg-gray-100 text-gray-800' : 'text-gray-500 hover:bg-gray-100'}`}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
                  onChange={e => { loadImageFile(e.target.files[0]); e.target.value = ''; }} />
                <button type="button" onClick={() => fileInputRef.current?.click()}
                  title="Attach screenshot"
                  className="w-8 h-8 flex items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 transition-colors">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                  </svg>
                </button>
                {/* Current-page chip removed — the URL was visual noise inside the input. */}
                <div className="flex-1" />
                <button type="button" onClick={handleSubmit} disabled={submitting || imageLoading || prompt.trim().length < 3}
                  title="Send"
                  className={`w-8 h-8 flex items-center justify-center rounded-full transition-all ${submitting || imageLoading || prompt.trim().length < 3 ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-gray-900 text-white hover:bg-gray-700'}`}>
                  {submitting
                    ? <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>}
                </button>
              </div>
            </div>

            {/* Bottom controls — minimal, no borders */}
            <div className="flex items-center justify-between pt-1.5">
              <div className="flex items-center gap-2">
                {chatMessages.length > 0 && (
                  <button onClick={clearChat} className="text-[11px] text-gray-500 hover:text-gray-800 transition-colors">New chat</button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={handleReset} disabled={resetting}
                  className="text-[11px] text-gray-500 hover:text-red-600 transition-colors disabled:opacity-50">
                  {resetting ? 'Resetting…' : 'Reset all'}
                </button>
                <span className="text-gray-300">·</span>
                <button type="button" onClick={() => { setCommitMsg(''); setPushModalOpen(true); }}
                  className="text-[11px] font-medium text-gray-700 hover:text-gray-900 transition-colors">
                  Push to {project.push_branch || project.repo_branch}
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

      {newPageOpen && (
        <>
          <div className="fixed inset-0 bg-black/40" style={{ zIndex: 50 }} onClick={() => !newPageCreating && setNewPageOpen(false)} />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl shadow-2xl w-[min(96vw,1200px)] flex flex-col" style={{ zIndex: 51, maxHeight: '92vh' }}>
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Create new page</h3>
              <button onClick={() => !newPageCreating && setNewPageOpen(false)}
                className="text-gray-400 hover:text-gray-700 text-lg leading-none">×</button>
            </div>

            <div className="px-5 py-4 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
              <label className="block text-[11px] font-semibold text-gray-600 uppercase tracking-wider mb-1.5">URL</label>
              <input value={newPageUrl} onChange={e => { setNewPageUrl(e.target.value); setNewPageError(''); }}
                placeholder="/play/coaching" autoFocus
                onKeyDown={e => { if (e.key === 'Enter') submitNewPage(); }}
                className="w-full px-3 py-2.5 border-2 border-stone-200 rounded-xl text-sm text-black focus:ring-2 focus:ring-emerald-400 focus:border-emerald-400 mb-1 placeholder:text-stone-400" />
              <p className="text-[10px] text-stone-500 mb-4">The last segment becomes the blade filename. Letters, digits, dashes, underscores only.</p>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-[11px] font-semibold text-gray-600 uppercase tracking-wider mb-1.5">
                    Available sections — click a thumbnail to add
                    {availableSections.length > 0 && (
                      <span className="ml-1 text-stone-400 font-normal normal-case">({availableSections.length - chosenSections.length})</span>
                    )}
                  </label>
                  <div className="border-2 border-stone-200 rounded-xl overflow-y-auto p-2" style={{ maxHeight: '60vh' }}>
                    {availableSections.length === 0 ? (
                      <p className="text-center text-stone-400 text-xs py-6">Loading…</p>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        {availableSections.filter(s => !chosenSections.includes(s.name)).map(s => (
                          <button key={s.name} type="button" onClick={() => toggleSection(s.name)}
                            className="group block text-left rounded-lg border-2 border-stone-200 hover:border-emerald-400 bg-white transition-colors overflow-hidden">
                            <div className="relative w-full bg-stone-50" style={{ height: '140px' }}>
                              {/* Iframe scaled down: render at 1280px wide, scale to fit thumbnail width.
                                  pointer-events disabled so the whole tile remains clickable. */}
                              <div className="absolute inset-0 overflow-hidden pointer-events-none">
                                <iframe
                                  src={`/preview/__preview_section/${encodeURIComponent(s.name)}`}
                                  loading="lazy"
                                  className="border-0 bg-white"
                                  style={{
                                    width: '1280px',
                                    height: '700px',
                                    transform: 'scale(0.22)',
                                    transformOrigin: 'top left',
                                  }}
                                  title={s.displayName}
                                />
                              </div>
                              <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-emerald-600 text-white text-[10px] font-bold opacity-0 group-hover:opacity-100 transition-opacity">+ Add</span>
                            </div>
                            <div className="px-2.5 py-1.5 border-t border-stone-100 bg-white">
                              <span className="text-[11px] font-medium text-stone-700">{s.displayName}</span>
                            </div>
                          </button>
                        ))}
                        {availableSections.filter(s => !chosenSections.includes(s.name)).length === 0 && (
                          <p className="col-span-2 text-center text-stone-400 text-xs py-6">All sections picked</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-gray-600 uppercase tracking-wider mb-1.5">
                    Chosen <span className="ml-1 text-stone-400 font-normal normal-case">({chosenSections.length}, top → bottom)</span>
                  </label>
                  <div className="border-2 border-stone-200 rounded-xl overflow-y-auto p-2" style={{ maxHeight: '60vh' }}>
                    {chosenSections.length === 0 ? (
                      <p className="text-center text-stone-400 text-xs py-6 px-3">Click a section on the left to add it</p>
                    ) : (
                      <div className="space-y-2"
                        onDragOver={e => e.preventDefault()}
                        onDrop={e => {
                          e.preventDefault();
                          // Drop on the container background (e.g. below the last item) → append to end
                          if (dragIndex != null) reorderChosenSections(dragIndex, chosenSections.length);
                          setDragIndex(null);
                          setDragOverIndex(null);
                        }}>
                        {chosenSections.map((name, i) => {
                          const meta = availableSections.find(s => s.name === name);
                          const isDragging = dragIndex === i;
                          const showIndicatorAbove = dragOverIndex === i && dragIndex !== i && dragIndex !== i - 1;
                          return (
                            <div key={name}>
                              {showIndicatorAbove && <div className="h-0.5 bg-emerald-500 rounded-full mb-1" />}
                              <div
                                draggable
                                onDragStart={e => { setDragIndex(i); e.dataTransfer.effectAllowed = 'move'; }}
                                onDragEnd={() => { setDragIndex(null); setDragOverIndex(null); }}
                                onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverIndex(i); }}
                                onDragLeave={() => { if (dragOverIndex === i) setDragOverIndex(null); }}
                                onDrop={e => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  if (dragIndex != null) reorderChosenSections(dragIndex, i);
                                  setDragIndex(null);
                                  setDragOverIndex(null);
                                }}
                                className={`group rounded-lg border-2 bg-white overflow-hidden transition-all ${
                                  isDragging ? 'opacity-40 border-emerald-400' : 'border-stone-200 hover:border-stone-400'
                                }`}
                                style={{ cursor: 'grab' }}
                                title="Drag to reorder">
                                <div className="flex items-stretch">
                                  {/* Drag grip */}
                                  <div className="flex flex-col items-center justify-center px-1.5 bg-stone-50 border-r border-stone-200 text-stone-400 select-none">
                                    <span className="text-[8px] leading-tight">⋮⋮</span>
                                    <span className="text-[10px] font-mono mt-0.5">{i + 1}</span>
                                  </div>
                                  {/* Iframe thumbnail */}
                                  <div className="relative flex-1 bg-stone-50" style={{ height: '110px' }}>
                                    <div className="absolute inset-0 overflow-hidden pointer-events-none">
                                      <iframe
                                        src={`/preview/__preview_section/${encodeURIComponent(name)}`}
                                        loading="lazy"
                                        className="border-0 bg-white"
                                        style={{
                                          width: '1280px',
                                          height: '600px',
                                          transform: 'scale(0.18)',
                                          transformOrigin: 'top left',
                                        }}
                                        title={meta?.displayName || name}
                                      />
                                    </div>
                                  </div>
                                </div>
                                <div className="px-2 py-1.5 border-t border-stone-100 flex items-center gap-1 bg-white">
                                  <span className="flex-1 text-[11px] font-medium text-stone-700 truncate">{meta?.displayName || name}</span>
                                  <button type="button" onClick={() => moveSection(name, -1)} disabled={i === 0}
                                    title="Move up" className="px-1.5 py-0.5 rounded hover:bg-stone-100 text-stone-500 disabled:opacity-30 text-xs">↑</button>
                                  <button type="button" onClick={() => moveSection(name, 1)} disabled={i === chosenSections.length - 1}
                                    title="Move down" className="px-1.5 py-0.5 rounded hover:bg-stone-100 text-stone-500 disabled:opacity-30 text-xs">↓</button>
                                  <button type="button" onClick={() => toggleSection(name)}
                                    title="Remove" className="px-1.5 py-0.5 rounded hover:bg-red-50 text-red-500 text-xs">×</button>
                                </div>
                              </div>
                              {dragOverIndex === i && i === chosenSections.length - 1 && dragIndex !== i && <div className="h-0.5 bg-emerald-500 rounded-full mt-1" />}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {newPageError && <p className="mt-3 text-xs text-red-600">{newPageError}</p>}
            </div>

            <div className="flex gap-2 px-5 py-4 border-t border-gray-100 bg-gray-50 rounded-b-2xl">
              <button onClick={() => !newPageCreating && setNewPageOpen(false)}
                className="flex-1 py-2 border border-stone-200 rounded-xl text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
              <button onClick={submitNewPage} disabled={newPageCreating || !newPageUrl.trim() || chosenSections.length === 0}
                className="flex-1 py-2 text-white rounded-xl text-sm font-semibold disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #1b4332, #2d6a4f)' }}>
                {newPageCreating ? 'Creating…' : 'Create page'}
              </button>
            </div>
          </div>
        </>
      )}

      {pushModalOpen && (
        <>
          <div className="fixed inset-0 bg-black/40" style={{ zIndex: 50 }} onClick={() => setPushModalOpen(false)} />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm" style={{ zIndex: 51 }}>
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Push to <span className="font-mono text-blue-600">{project.push_branch || project.repo_branch}</span></h3>
            <input value={commitMsg} onChange={e => setCommitMsg(e.target.value)}
              placeholder="Commit message..." autoFocus
              onKeyDown={e => { if (e.key === 'Enter') handlePush(); }}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder:text-gray-400 bg-white focus:ring-2 focus:ring-green-500 focus:border-transparent mb-3" />
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
