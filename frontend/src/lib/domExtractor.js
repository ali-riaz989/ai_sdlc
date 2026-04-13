/**
 * Builds a structured DOM map for the AI.
 * Each section gets an ID, role, and content summary.
 * AI uses this to identify the correct target — no raw HTML scanning.
 */

export function extractPageContext(iframe) {
  try {
    const doc = iframe.contentDocument;
    if (!doc || !doc.body) return null;

    let pathname = '/';
    try { pathname = new URL(iframe.src.split('?')[0]).pathname; } catch {}

    const sections = [];
    let secIdx = 0;

    // Walk all major structural elements
    const elements = doc.querySelectorAll('nav, header, section, article, main, footer, [class*="section"], [class*="area"], [class*="block"]');

    [...elements].forEach(el => {
      // Skip nested elements (already captured by parent)
      if (el.closest('nav') !== el && el.closest('nav')) return;
      if (el.closest('header') !== el && el.closest('header')) return;
      if (el.closest('footer') !== el && el.closest('footer')) return;

      // Determine role
      const tag = el.tagName.toLowerCase();
      let role = 'content';
      if (tag === 'nav' || el.closest('nav')) role = 'navigation';
      else if (tag === 'header' || el.closest('header')) role = 'header';
      else if (tag === 'footer' || el.closest('footer')) role = 'footer';

      secIdx++;
      const id = `sec_${secIdx}`;

      // Collect headings
      const headings = [...el.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .slice(0, 6)
        .map(h => ({ tag: h.tagName.toLowerCase(), text: h.innerText?.trim().substring(0, 150) }))
        .filter(h => h.text);

      // Collect visible text summary
      const textContent = el.innerText?.trim().substring(0, 300) || '';

      // Children summary (tag types)
      const childTags = [...new Set([...el.querySelectorAll('*')].slice(0, 50).map(c => c.tagName.toLowerCase()))].slice(0, 10);

      // Images
      const images = [...el.querySelectorAll('img')].slice(0, 4).map(img => ({
        alt: img.alt?.trim().substring(0, 80) || '',
        src: img.src?.substring(0, 150) || ''
      }));

      // Buttons/links
      const buttons = [...el.querySelectorAll('a.btn, a[class*="btn"], button, [class*="button"]')]
        .slice(0, 4)
        .map(b => b.innerText?.trim().substring(0, 60))
        .filter(Boolean);

      // Links (for nav)
      const links = role === 'navigation'
        ? [...el.querySelectorAll('a')].slice(0, 15).map(a => a.innerText?.trim().substring(0, 40)).filter(Boolean)
        : [];

      sections.push({
        id,
        role,
        tag,
        classes: el.className?.substring(0, 120) || '',
        headings,
        text: textContent,
        children_summary: childTags,
        images,
        buttons,
        links
      });
    });

    return {
      url: pathname,
      title: doc.title,
      sections
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
