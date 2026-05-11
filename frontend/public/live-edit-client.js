/* Live-edit client — runs inside the iframe (project's rendered pages).
 *
 * Owns DOM manipulation only. ai_sdlc UI (the parent window) owns auth +
 * API calls + persistence; we just postMessage user actions back so the
 * parent can decide what to do.
 *
 * Wire protocol (postMessage payloads, all carry source:'live-edit' or 'ai-sdlc-parent'):
 *
 *   parent → iframe:
 *     { type:'enable-edit',     overrides:[...] }   apply overrides + start edit mode
 *     { type:'disable-edit' }                       turn off edit mode
 *     { type:'apply-overrides', overrides:[...] }   apply without changing edit mode
 *     { type:'apply-image',     selector, url }     parent finished uploading, push new src
 *
 *   iframe → parent:
 *     { type:'ready',                  url }                              iframe loaded
 *     { type:'text-changed',           selector, field, previous, value } user blurred edited element
 *     { type:'image-replace-request',  selector, previous_src, mediaType, dataUrl }
 *
 * Override shape: { selector, field:'text'|'src'|'alt', new_value }
 */
(function () {
  'use strict';

  let editEnabled = false;
  const editableEls = new Set();
  const altChips = [];

  // Tags whose only children are these are still "text-bearing" — we'll allow
  // contenteditable on them. Anything else (a wrapping div with sub-sections,
  // a button group, etc.) is structural and excluded.
  // Inline children that DON'T disqualify a parent from being "text-bearing".
  // Includes IMG and SVG so mixed-content buttons/links — "Book Lesson →" with
  // an arrow icon, "Watch video ▶" with a play SVG — still get their text made
  // editable. The icon stays in place; the user can edit the text around it.
  const INLINE = new Set(['SPAN','A','EM','STRONG','B','I','BR','SMALL','CODE','MARK','SUB','SUP','U','TIME','IMG','SVG','PATH','USE']);
  // Note: <button> is INTENTIONALLY allowed — many sites use buttons as
  // accordion / dropdown / modal triggers (FAQs, tabs, etc.) and the user
  // needs to be able to edit the visible text inside them.
  const SKIP_TAGS = new Set(['SCRIPT','STYLE','META','LINK','HEAD','HTML','TITLE','NOSCRIPT','TEXTAREA','INPUT','SELECT','OPTION','SVG','PATH','IFRAME']);

  function isTextBearing(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return false;
    const txt = (el.textContent || '').trim();
    if (!txt) return false;
    for (let i = 0; i < el.children.length; i++) {
      if (!INLINE.has(el.children[i].tagName)) return false;
    }
    return true;
  }

  // Stable structural selector. Priority: id, then data-blade-src, then a
  // nth-of-type CSS path from <body>. Stable across reloads as long as the
  // surrounding markup hasn't shifted around.
  function selectorOf(el) {
    if (!el || !el.parentElement) return '';
    if (el.id) return '#' + cssEscape(el.id);
    const bs = el.getAttribute && el.getAttribute('data-blade-src');
    if (bs) return `[data-blade-src="${cssEscape(bs)}"]`;
    const path = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur.parentElement && cur.tagName !== 'BODY') {
      let token = cur.tagName.toLowerCase();
      const sibs = cur.parentElement.children;
      let total = 0, idx = 0;
      for (let i = 0; i < sibs.length; i++) {
        if (sibs[i].tagName === cur.tagName) {
          total++;
          if (sibs[i] === cur) idx = total;
        }
      }
      if (total > 1) token += `:nth-of-type(${idx})`;
      path.unshift(token);
      cur = cur.parentElement;
    }
    return path.length ? 'body > ' + path.join(' > ') : '';
  }

  // CSS.escape isn't on every legacy browser; small fallback.
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^\w-]/g, c => '\\' + c.charCodeAt(0).toString(16) + ' ');
  }

  function findBySelector(sel) {
    try { return document.querySelector(sel); } catch { return null; }
  }

  function applyOverrides(overrides) {
    if (!Array.isArray(overrides)) return;
    for (const o of overrides) {
      const el = findBySelector(o.selector);
      if (!el) continue;
      if (o.field === 'text') {
        // Use innerHTML so child elements survive the round-trip — a button
        // like "Book Lesson <img class='arrow'>" or a card with an inline
        // image keeps its icon. textContent would silently delete every
        // child while applying the new text.
        el.innerHTML = o.new_value;
      } else if (o.field === 'src' && el.tagName === 'IMG') {
        el.src = o.new_value;
      } else if (o.field === 'alt' && el.tagName === 'IMG') {
        el.alt = o.new_value;
      }
    }
  }

  function send(type, payload) {
    try {
      window.parent.postMessage(Object.assign({ source: 'live-edit', type }, payload || {}), '*');
    } catch (_) { /* sandboxed parent — silently skip */ }
  }

  // Capture-phase global click interceptor. While edit mode is on, swallow
  // any click that would navigate the page (anchors, form submits) — the
  // user's intent is to edit text inside them, not follow them. We don't
  // hook this onto every anchor individually because new anchors can be
  // added by the user's edits or by JS in the page.
  function suppressNav(e) {
    if (!editEnabled) return;
    const t = e.target;
    // Wired <img>s: let the click reach their own bubble-phase handler
    // (file picker). The wrapping anchor's default navigation is still
    // prevented below.
    const isWiredImg = t && t.tagName === 'IMG' && t.dataset && t.dataset.liveEditWired;
    // Our own UI (alt chip etc.) — never suppress.
    const ourUI = t.closest && t.closest('[data-live-edit-for]');
    if (ourUI) return;

    // Form submits → block, otherwise the form leaves the page.
    if (e.type === 'submit') { e.preventDefault(); return; }

    // Anchors with a real href → block navigation, but otherwise leave
    // propagation alone so JS-bound click handlers (carousel arrows etc.)
    // still fire. For wired images we additionally avoid stopPropagation
    // so the bubble-phase img handler runs.
    const anchor = t.closest && t.closest('a[href]');
    if (anchor) {
      const href = anchor.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:')) e.preventDefault();
      if (!isWiredImg) e.stopPropagation();
      return;
    }

    // Submit-style buttons → block form submission. ALL OTHER button clicks
    // (accordion toggles, dropdown toggles, modal openers, tab switches,
    // pure JS handlers) are intentionally NOT suppressed: users need them to
    // expand/show content they want to edit.
    if (t.tagName === 'INPUT' && (t.type === 'submit' || t.type === 'button')) { e.preventDefault(); return; }
    if (t.closest && t.closest('button[type="submit"]')) { e.preventDefault(); return; }
  }

  // ── Floating format toolbar (Word-like) ──────────────────────────────────
  // A single persistent toolbar anchored to the iframe document. Appears above
  // whichever contenteditable element currently has focus. Buttons issue
  // execCommand to format the selection in-place; the existing onTextBlur
  // captures the resulting innerHTML, so persistence "just works" — formatting
  // changes flow through the same /text-overrides path as plain text edits.
  let formatToolbar = null;
  let activeEditable = null;
  let toolbarHideTimer = null;
  const FONT_FAMILIES = [
    ['Default', ''],
    ['Sans-serif', 'sans-serif'],
    ['Serif', 'serif'],
    ['Monospace', 'monospace'],
    ['Inter', 'Inter, sans-serif'],
    ['Helvetica', 'Helvetica, Arial, sans-serif'],
    ['Georgia', 'Georgia, serif'],
    ['Times', '"Times New Roman", Times, serif'],
    ['Courier', '"Courier New", Courier, monospace'],
  ];
  const FONT_SIZES = ['10', '12', '14', '16', '18', '20', '24', '28', '32', '36', '48'];

  function buildToolbar() {
    if (formatToolbar) return formatToolbar;
    const tb = document.createElement('div');
    tb.id = '__lgc_format_toolbar';
    tb.style.cssText =
      'position:absolute;display:none;z-index:2147483647;' +
      'background:#1f2937;color:#f3f4f6;border:1px solid #111827;' +
      'border-radius:8px;padding:4px;box-shadow:0 4px 16px rgba(0,0,0,0.18);' +
      'font:13px/1 system-ui,-apple-system,sans-serif;' +
      'display:none;align-items:center;gap:2px;user-select:none;';
    // Stop mousedown on plain buttons from blurring the contenteditable —
    // otherwise pressing Bold clears the selection before execCommand fires.
    // BUT: <select> needs its native mousedown to open the dropdown, and
    // <input type="color"> needs it to open the picker. Only preventDefault
    // for elements that don't have their own popover behavior.
    tb.addEventListener('mousedown', (e) => {
      if (e.target.closest('select, input, textarea, option')) return;
      e.preventDefault();
    });

    const mkBtn = (label, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.innerHTML = label;
      b.style.cssText =
        'min-width:28px;height:28px;padding:0 6px;background:transparent;' +
        'color:inherit;border:0;border-radius:4px;cursor:pointer;font:inherit;' +
        'display:inline-flex;align-items:center;justify-content:center;';
      b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,0.12)'; });
      b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
      b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
      return b;
    };
    const mkSep = () => {
      const s = document.createElement('span');
      s.style.cssText = 'display:inline-block;width:1px;height:20px;background:rgba(255,255,255,0.18);margin:0 3px;';
      return s;
    };
    const mkSelect = (options, title, onChange) => {
      const sel = document.createElement('select');
      sel.title = title;
      sel.style.cssText =
        'height:24px;background:#374151;color:#f3f4f6;border:0;border-radius:4px;' +
        'padding:0 4px;font:12px/1 inherit;cursor:pointer;outline:none;';
      for (const [label, value] of options) {
        const o = document.createElement('option');
        o.value = String(value);
        o.textContent = label;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => onChange(sel.value));
      return sel;
    };

    const exec = (cmd, value) => {
      try { document.execCommand(cmd, false, value); } catch {}
    };

    // Select all — picks up the full contents of the active editable so
    // formatting / color buttons apply to everything in one click. Selects
    // within `activeEditable` (not the whole iframe document).
    tb.appendChild(mkBtn('⌘A', 'Select all in this block', () => {
      if (!activeEditable) return;
      const sel = document.getSelection();
      const range = document.createRange();
      try { range.selectNodeContents(activeEditable); } catch { return; }
      sel.removeAllRanges();
      sel.addRange(range);
    }));
    tb.appendChild(mkSep());

    // Inline formatting
    tb.appendChild(mkBtn('<b>B</b>', 'Bold (Ctrl+B)', () => exec('bold')));
    tb.appendChild(mkBtn('<i>I</i>', 'Italic (Ctrl+I)', () => exec('italic')));
    tb.appendChild(mkBtn('<u>U</u>', 'Underline (Ctrl+U)', () => exec('underline')));
    tb.appendChild(mkBtn('<s>S</s>', 'Strikethrough', () => exec('strikeThrough')));
    tb.appendChild(mkSep());

    // Color picker — native input, hidden behind a button label
    const colorWrap = document.createElement('label');
    colorWrap.title = 'Text color';
    colorWrap.style.cssText =
      'min-width:28px;height:28px;padding:0 6px;border-radius:4px;cursor:pointer;' +
      'display:inline-flex;align-items:center;justify-content:center;position:relative;';
    colorWrap.addEventListener('mouseenter', () => { colorWrap.style.background = 'rgba(255,255,255,0.12)'; });
    colorWrap.addEventListener('mouseleave', () => { colorWrap.style.background = 'transparent'; });
    colorWrap.innerHTML = '<span style="font-weight:600;border-bottom:3px solid #ef4444;line-height:1;">A</span>';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.style.cssText = 'position:absolute;inset:0;opacity:0;cursor:pointer;';
    colorInput.addEventListener('input', () => {
      // Color input opens on click; preserve selection by deferring exec
      exec('foreColor', colorInput.value);
    });
    colorWrap.appendChild(colorInput);
    tb.appendChild(colorWrap);

    tb.appendChild(mkSep());

    // Font family / size selects
    const fontSel = mkSelect(FONT_FAMILIES, 'Font family', (v) => exec('fontName', v || 'inherit'));
    tb.appendChild(fontSel);
    const sizeSel = mkSelect([['Size…', ''], ...FONT_SIZES.map(s => [s + 'px', s])], 'Font size', (v) => {
      if (!v) return;
      // execCommand('fontSize') uses 1-7 scale; we want px. Wrap selection in
      // a span with the chosen px value instead.
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const span = document.createElement('span');
      span.style.fontSize = v + 'px';
      try { range.surroundContents(span); } catch {
        // Selection crosses element boundaries; fall back to wrapping cloned
        // contents and re-inserting.
        const frag = range.extractContents();
        span.appendChild(frag);
        range.insertNode(span);
      }
      sizeSel.selectedIndex = 0; // reset label to "Size…"
    });
    tb.appendChild(sizeSel);

    tb.appendChild(mkSep());

    // Lists — bullet and numbered. execCommand toggles them on / off.
    tb.appendChild(mkBtn('• ☰', 'Bulleted list',  () => exec('insertUnorderedList')));
    tb.appendChild(mkBtn('1. ☰', 'Numbered list', () => exec('insertOrderedList')));

    tb.appendChild(mkSep());

    // Alignment
    tb.appendChild(mkBtn('⬱', 'Align left', () => exec('justifyLeft')));
    tb.appendChild(mkBtn('☰', 'Align center', () => exec('justifyCenter')));
    tb.appendChild(mkBtn('⬲', 'Align right', () => exec('justifyRight')));

    tb.appendChild(mkSep());

    // Clear formatting
    tb.appendChild(mkBtn('✕', 'Remove formatting', () => exec('removeFormat')));

    document.body.appendChild(tb);
    formatToolbar = tb;
    return tb;
  }

  function showToolbarFor(el) {
    if (!editEnabled || !el) return;
    clearTimeout(toolbarHideTimer);
    activeEditable = el;
    const tb = buildToolbar();
    const rect = el.getBoundingClientRect();
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const scrollX = window.scrollX || document.documentElement.scrollLeft || 0;
    // Position above the element; flip below if there's no room above.
    tb.style.display = 'inline-flex';
    const tbRect = tb.getBoundingClientRect();
    const aboveTop = rect.top + scrollY - tbRect.height - 8;
    const belowTop = rect.bottom + scrollY + 8;
    const top = aboveTop > scrollY + 4 ? aboveTop : belowTop;
    let left = rect.left + scrollX;
    // Keep within viewport horizontally
    const maxLeft = scrollX + window.innerWidth - tbRect.width - 8;
    if (left > maxLeft) left = Math.max(scrollX + 8, maxLeft);
    tb.style.top = top + 'px';
    tb.style.left = left + 'px';
  }

  function hideToolbar() {
    if (!formatToolbar) return;
    formatToolbar.style.display = 'none';
    activeEditable = null;
  }

  function enableEdit() {
    editEnabled = true;
    document.addEventListener('click', suppressNav, true);
    document.addEventListener('submit', suppressNav, true);

    // Show toolbar when focus enters an editable; hide (with grace period
    // to allow toolbar clicks) when it leaves.
    document.addEventListener('focusin', onEditableFocusIn, true);
    document.addEventListener('focusout', onEditableFocusOut, true);
    // Reposition toolbar on scroll/resize so it stays glued above the focused element
    document.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize);

    // Make text-bearing elements editable. We restrict the candidate tags to
    // common content tags so we don't accidentally make navigation chrome
    // editable.
    const candidates = document.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, figcaption, ' +
      'a, span, small, strong, em, b, i, label, dt, dd, summary, time, ' +
      // Include buttons — accordion (FAQ) toggles, modal triggers, "Subscribe"
      // / "Read more" CTAs are all <button> elements whose text the user wants
      // to edit. Their click handlers still fire (suppressNav allows them).
      'button, ' +
      // Include divs — many sites (FAQs, cards, blog post bodies, etc.) wrap
      // text in plain <div>s instead of <p>. The isTextBearing check below
      // filters to divs that contain ONLY text + inline elements, so a
      // structural div with sub-sections is excluded.
      'div'
    );
    candidates.forEach(el => {
      if (!isTextBearing(el)) return;
      if (el.dataset.liveEditWired) return;
      el.dataset.liveEditWired = '1';
      // Capture the FULL HTML, not just textContent. When the user edits the
      // visible text, the surrounding inline structure (icons, <strong>, <a>,
      // line breaks) is preserved on save. Using textContent would lose all
      // of that — the next render would replace e.g. "Book Lesson →" with
      // just "Book Lesson", deleting the arrow.
      el.dataset.liveEditOriginal = el.innerHTML;
      el.contentEditable = 'true';
      el.style.outline = '1px dashed rgba(34,197,94,0.45)';
      el.style.outlineOffset = '2px';
      el.addEventListener('blur', onTextBlur);
      editableEls.add(el);
    });

    // Image hooks: click → file picker, plus a small "alt:" chip below each
    // image so alt text can be edited inline alongside the image src.
    document.querySelectorAll('img').forEach(img => {
      if (img.dataset.liveEditWired) return;
      img.dataset.liveEditWired = '1';
      img.style.cursor = 'pointer';
      img.style.outline = '2px dashed rgba(59,130,246,0.55)';
      img.style.outlineOffset = '2px';
      img.addEventListener('click', onImageClick);

      // alt-text chip
      const chip = document.createElement('span');
      chip.contentEditable = 'true';
      chip.style.cssText =
        'display:inline-block;font-size:11px;line-height:1.4;color:#555;' +
        'background:rgba(255,255,255,0.92);padding:1px 6px;border:1px solid #c0c0c0;' +
        'border-radius:4px;margin:2px 0 0;font-family:system-ui,-apple-system,sans-serif;';
      chip.textContent = img.alt && img.alt.trim() ? `alt: ${img.alt}` : 'alt: (none)';
      chip.dataset.liveEditAltOrig = img.alt || '';
      chip.dataset.liveEditFor = 'alt';
      chip.addEventListener('blur', () => {
        const raw = chip.textContent.replace(/^alt:\s*/i, '').replace(/^\(none\)$/, '').trim();
        const prev = chip.dataset.liveEditAltOrig || '';
        if (raw === prev) return;
        send('text-changed', { selector: selectorOf(img), field: 'alt', previous: prev, value: raw });
        img.alt = raw;
        chip.dataset.liveEditAltOrig = raw;
      });
      if (img.parentNode) {
        img.parentNode.insertBefore(chip, img.nextSibling);
        altChips.push(chip);
      }
    });
  }

  function onEditableFocusIn(e) {
    const el = e.target;
    if (!el || !editableEls.has(el)) return;
    showToolbarFor(el);
  }
  function onEditableFocusOut(e) {
    // Delay hide so a click on a toolbar button or its <select> (which move
    // focus briefly) doesn't dismiss the toolbar before the click handler
    // runs. Focus is considered still "with us" if it's inside another
    // editable OR inside the toolbar itself (font/size dropdowns, color
    // picker, formatting buttons all live there).
    clearTimeout(toolbarHideTimer);
    toolbarHideTimer = setTimeout(() => {
      const ae = document.activeElement;
      const stillEditing = ae && editableEls.has(ae);
      const inToolbar = ae && formatToolbar && formatToolbar.contains(ae);
      if (!stillEditing && !inToolbar) hideToolbar();
    }, 120);
  }
  function onScrollResize() {
    if (activeEditable && formatToolbar && formatToolbar.style.display !== 'none') {
      showToolbarFor(activeEditable);
    }
  }

  function disableEdit() {
    editEnabled = false;
    document.removeEventListener('click', suppressNav, true);
    document.removeEventListener('submit', suppressNav, true);
    document.removeEventListener('focusin', onEditableFocusIn, true);
    document.removeEventListener('focusout', onEditableFocusOut, true);
    document.removeEventListener('scroll', onScrollResize, true);
    window.removeEventListener('resize', onScrollResize);
    hideToolbar();
    if (formatToolbar) { formatToolbar.remove(); formatToolbar = null; }
    editableEls.forEach(el => {
      el.contentEditable = 'false';
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.removeEventListener('blur', onTextBlur);
      delete el.dataset.liveEditWired;
      delete el.dataset.liveEditOriginal;
    });
    editableEls.clear();
    document.querySelectorAll('img[data-live-edit-wired]').forEach(img => {
      img.style.cursor = '';
      img.style.outline = '';
      img.style.outlineOffset = '';
      img.removeEventListener('click', onImageClick);
      delete img.dataset.liveEditWired;
    });
    altChips.splice(0).forEach(c => c.remove());
  }

  function onTextBlur(e) {
    const el = e.currentTarget;
    // innerHTML keeps child structure (icons, inline tags, images) intact.
    // Compare to the snapshot we took when wiring; emit only on change.
    const newVal = el.innerHTML;
    const prev = el.dataset.liveEditOriginal || '';
    if (newVal === prev) return;
    send('text-changed', { selector: selectorOf(el), field: 'text', previous: prev, value: newVal });
    el.dataset.liveEditOriginal = newVal;
  }

  function onImageClick(e) {
    if (!editEnabled) return;
    e.preventDefault();
    e.stopPropagation();
    const img = e.currentTarget;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        send('image-replace-request', {
          selector: selectorOf(img),
          previous_src: img.src,
          mediaType: file.type,
          dataUrl: reader.result,
        });
      };
      reader.readAsDataURL(file);
    });
    input.click();
  }

  // Listen for commands from the parent.
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.source !== 'ai-sdlc-parent') return;
    if (msg.type === 'enable-edit') {
      if (msg.overrides) applyOverrides(msg.overrides);
      enableEdit();
    } else if (msg.type === 'disable-edit') {
      disableEdit();
    } else if (msg.type === 'apply-overrides') {
      if (msg.overrides) applyOverrides(msg.overrides);
    } else if (msg.type === 'apply-image') {
      const el = findBySelector(msg.selector);
      if (el && el.tagName === 'IMG') el.src = msg.url;
    }
  });

  // Tell the parent we're alive so it can push initial overrides + edit-mode state.
  send('ready', { url: location.pathname + location.search + location.hash });
})();
