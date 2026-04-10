/**
 * Tier 1: Pure regex/keyword matching — ZERO AI calls.
 * Matches prompts like "change X to Y" and resolves X against the DOM context.
 */

// Patterns: "change X to Y", "update X to Y", "replace X with Y", "set X to Y"
const CHANGE_PATTERNS = [
  /^(?:change|update|set|replace)\s+(?:the\s+)?(.+?)\s+(?:to|with|as)\s+["']?(.+?)["']?\s*$/i,
  /^(?:make|set)\s+(?:the\s+)?(.+?)\s+(?:say|read|be)\s+["']?(.+?)["']?\s*$/i,
  /^(?:rename|relabel)\s+(?:the\s+)?(.+?)\s+(?:to|as)\s+["']?(.+?)["']?\s*$/i,
];

// Maps common English words → DOM fields
const FIELD_ALIASES = {
  title:       ['title', 'heading', 'headline', 'h1', 'main heading', 'header text', 'page title'],
  subtitle:    ['subtitle', 'subheading', 'sub-heading', 'sub heading', 'h2', 'tagline'],
  description: ['description', 'body', 'paragraph', 'text', 'content', 'copy', 'body text'],
  button_text: ['button', 'cta', 'call to action', 'button text', 'link text', 'action button'],
  nav_link:    ['nav', 'menu', 'navigation', 'nav link', 'menu item'],
};

/**
 * Tries to parse a simple "change X to Y" prompt.
 * Returns { target_description, new_value } or null.
 */
function parseChangePrompt(prompt) {
  const trimmed = prompt.trim();
  for (const pattern of CHANGE_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m) {
      return {
        target_description: m[1].toLowerCase().trim(),
        new_value: m[2].trim()
      };
    }
  }
  return null;
}

/**
 * Given a target description and DOM page context, resolve to a specific text value.
 * Returns { old_text, new_value, section_id?, field? } or null.
 */
function resolveTarget(target, newValue, pageContext) {
  if (!pageContext) return null;

  // ── Try sections with data attributes ────────────────────────────────────
  if (pageContext.has_data_attributes && pageContext.sections?.length > 0) {
    const fieldMatch = matchField(target);
    const sectionSlug = extractSectionSlug(target, pageContext.sections);

    for (const section of pageContext.sections) {
      if (sectionSlug && section.section_slug !== sectionSlug) continue;
      if (fieldMatch && section.fields?.length > 0) {
        const field = section.fields.find(f => f.field === fieldMatch);
        if (field) {
          return {
            section_id: section.section_id,
            field: fieldMatch,
            old_text: field.text,
            new_value: newValue
          };
        }
      }
    }
  }

  // ── Try headings ──────────────────────────────────────────────────────────
  const isHeadingTarget = ['title', 'heading', 'h1', 'h2', 'h3', 'headline', 'header text', 'main heading']
    .some(kw => target.includes(kw));

  if (isHeadingTarget && pageContext.headings?.length > 0) {
    // Pick the most relevant heading (prefer h1, then first h2)
    const h1 = pageContext.headings.find(h => h.tag === 'H1');
    const heading = h1 || pageContext.headings[0];
    if (heading?.text) {
      return { old_text: heading.text, new_value: newValue };
    }
  }

  // ── Try buttons ───────────────────────────────────────────────────────────
  const isButtonTarget = ['button', 'cta', 'btn', 'link text', 'action'].some(kw => target.includes(kw));
  if (isButtonTarget && pageContext.buttons?.length > 0) {
    const btn = pageContext.buttons[0];
    if (btn?.text) return { old_text: btn.text, new_value: newValue };
  }

  // ── Fuzzy: target description IS the text to find ────────────────────────
  // e.g., "change 'Book Now' to 'Reserve Now'"
  const quotedTarget = target.match(/["']([^'"]+)["']/);
  if (quotedTarget) {
    return { old_text: quotedTarget[1], new_value: newValue };
  }

  // ── Last resort: check headings for partial text match ────────────────────
  const allText = [
    ...(pageContext.headings || []).map(h => h.text),
    ...(pageContext.buttons || []).map(b => b.text),
    ...(pageContext.paragraphs || [])
  ].filter(Boolean);

  const exactMatch = allText.find(t =>
    t.toLowerCase().includes(target) || target.includes(t.toLowerCase().substring(0, 20))
  );
  if (exactMatch) return { old_text: exactMatch, new_value: newValue };

  return null;
}

function matchField(target) {
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.some(alias => target.includes(alias))) return field;
  }
  return null;
}

function extractSectionSlug(target, sections) {
  for (const section of sections) {
    if (section.section_slug && target.includes(section.section_slug)) {
      return section.section_slug;
    }
  }
  return null;
}

/**
 * Main export: attempt a Tier 1 direct match.
 * Returns { old_text, new_value, section_id?, field? } or null.
 */
function tryDirectMatch(prompt, pageContext) {
  const parsed = parseChangePrompt(prompt);
  if (!parsed) return null;
  return resolveTarget(parsed.target_description, parsed.new_value, pageContext);
}

module.exports = { tryDirectMatch, parseChangePrompt };
