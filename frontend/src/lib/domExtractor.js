/**
 * Extracts page context from the iframe DOM.
 * Works with or without data-section-id attributes.
 */

export function extractPageContext(iframe) {
  try {
    const doc = iframe.contentDocument;
    if (!doc || !doc.body) return null;

    const origin = iframe.src ? new URL(iframe.src).origin : '';
    let pathname = '/';
    try { pathname = new URL(iframe.src.split('?')[0]).pathname; } catch {}

    // ── Sections with data attributes (rich mode) ─────────────────────────
    const dataSections = [...doc.querySelectorAll('[data-section-id],[data-section-slug]')]
      .map(el => ({
        section_id: el.getAttribute('data-section-id'),
        section_slug: el.getAttribute('data-section-slug'),
        tag: el.tagName,
        current_text: el.innerText?.trim().substring(0, 500),
        fields: [...el.querySelectorAll('[data-field]')].map(f => ({
          field: f.getAttribute('data-field'),
          tag: f.tagName,
          text: f.innerText?.trim().substring(0, 300)
        }))
      }));

    // ── Headings (always available) ────────────────────────────────────────
    const headings = [...doc.querySelectorAll('h1,h2,h3,h4')]
      .slice(0, 15)
      .map(el => ({
        tag: el.tagName,
        text: el.innerText?.trim().substring(0, 200),
        id: el.id || null,
        classes: el.className?.substring(0, 100)
      }))
      .filter(h => h.text);

    // ── Buttons & links with visible text ─────────────────────────────────
    const buttons = [...doc.querySelectorAll('button,a.btn,a[class*="btn"],[class*="button"]')]
      .slice(0, 10)
      .map(el => ({
        tag: el.tagName,
        text: el.innerText?.trim().substring(0, 100),
        href: el.href || null
      }))
      .filter(b => b.text);

    // ── Paragraphs (first few per visible area) ────────────────────────────
    const paragraphs = [...doc.querySelectorAll('p')]
      .slice(0, 10)
      .map(el => el.innerText?.trim().substring(0, 300))
      .filter(Boolean);

    return {
      url: pathname,
      origin,
      title: doc.title,
      has_data_attributes: dataSections.length > 0,
      sections: dataSections,
      headings,
      buttons,
      paragraphs
    };
  } catch {
    return null;
  }
}

/**
 * After a quick change succeeds, update the DOM directly without a full reload.
 * Only works when the element can be identified.
 */
export function applyDomUpdate(iframe, update) {
  try {
    const doc = iframe.contentDocument;
    if (!doc) return false;

    // Approach 1: data-section-id + data-field
    if (update.section_id && update.field) {
      const section = doc.querySelector(`[data-section-id="${update.section_id}"]`);
      if (section) {
        const el = section.querySelector(`[data-field="${update.field}"]`);
        if (el) { el.innerText = update.new_value; flashElement(el); return true; }
      }
    }

    // Approach 2: find element by its current text value
    if (update.old_text) {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent.trim() === update.old_text.trim()) {
          node.textContent = update.new_value;
          if (node.parentElement) flashElement(node.parentElement);
          return true;
        }
      }
    }

    return false;
  } catch {
    return false;
  }
}

function flashElement(el) {
  const prev = el.style.transition;
  el.style.transition = 'background-color 0.3s';
  el.style.backgroundColor = '#d4ffd4';
  setTimeout(() => {
    el.style.backgroundColor = '';
    el.style.transition = prev;
  }, 800);
}
