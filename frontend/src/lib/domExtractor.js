/**
 * Extracts a structured DOM map from the iframe.
 * Builds a section-level view so the AI can navigate like a browser,
 * distinguishing nav items from content sections.
 */

export function extractPageContext(iframe) {
  try {
    const doc = iframe.contentDocument;
    if (!doc || !doc.body) return null;

    const origin = iframe.src ? new URL(iframe.src).origin : '';
    let pathname = '/';
    try { pathname = new URL(iframe.src.split('?')[0]).pathname; } catch {}

    // ── Build structured section map ──────────────────────────────────────
    // Each entry has: role, tag, id, classes, heading, content summary, images
    const sectionMap = [];

    // 1. Navigation elements (explicitly tagged as nav — AI should avoid editing these unless asked)
    [...doc.querySelectorAll('nav, .nav, .navbar, [class*="menu"], header')].forEach((el, i) => {
      const links = [...el.querySelectorAll('a')].slice(0, 20).map(a => a.innerText?.trim()).filter(Boolean);
      if (links.length === 0) return;
      sectionMap.push({
        role: 'navigation',
        tag: el.tagName,
        id: el.id || null,
        classes: el.className?.substring(0, 120) || null,
        links,
        _score: -10 // AI should NOT target nav unless explicitly asked
      });
    });

    // 2. Content sections (section, article, main, div with section-like classes)
    const sectionEls = doc.querySelectorAll('section, article, main, [class*="section"], [class*="area"], [class*="block"]:not(nav):not(header):not(footer)');
    [...sectionEls].forEach((el, i) => {
      // Skip if inside nav/header/footer
      if (el.closest('nav') || el.closest('header') || el.closest('footer')) return;
      // Skip very small elements
      if (el.innerText?.trim().length < 20) return;

      const heading = el.querySelector('h1,h2,h3,h4');
      const images = [...el.querySelectorAll('img')].slice(0, 4).map(img => ({
        alt: img.alt?.trim().substring(0, 80) || '',
        src: img.src?.substring(0, 150) || ''
      }));
      const buttons = [...el.querySelectorAll('a.btn,a[class*="btn"],button,[class*="button"]')].slice(0, 4).map(b => b.innerText?.trim().substring(0, 60)).filter(Boolean);
      const paragraphs = [...el.querySelectorAll('p')].slice(0, 3).map(p => p.innerText?.trim().substring(0, 150)).filter(Boolean);

      sectionMap.push({
        role: 'content-section',
        tag: el.tagName,
        id: el.id || null,
        classes: el.className?.substring(0, 150) || null,
        heading: heading?.innerText?.trim().substring(0, 120) || null,
        headingTag: heading?.tagName || null,
        content: paragraphs,
        buttons,
        images,
        _score: 10 // AI should prefer content sections
      });
    });

    // 3. Footer
    [...doc.querySelectorAll('footer, .footer, [class*="footer"]')].forEach(el => {
      sectionMap.push({
        role: 'footer',
        tag: el.tagName,
        id: el.id || null,
        classes: el.className?.substring(0, 100) || null,
        text: el.innerText?.trim().substring(0, 200),
        _score: -5
      });
    });

    return {
      url: pathname,
      origin,
      title: doc.title,
      sectionMap
    };
  } catch {
    return null;
  }
}

/**
 * After a quick change succeeds, update the DOM directly without a full reload.
 */
export function applyDomUpdate(iframe, update) {
  try {
    const doc = iframe.contentDocument;
    if (!doc) return false;

    if (update.section_id && update.field) {
      const section = doc.querySelector(`[data-section-id="${update.section_id}"]`);
      if (section) {
        const el = section.querySelector(`[data-field="${update.field}"]`);
        if (el) { el.innerText = update.new_value; flashElement(el); return true; }
      }
    }

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
