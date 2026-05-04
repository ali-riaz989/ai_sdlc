const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { validateChangeRequest } = require('../middleware/validation');
const changeRequestController = require('../controllers/changeRequestController');
const quickChangeController = require('../controllers/quickChangeController');
const { sequelize } = require('../config/database');

const router = express.Router();

// Apply a CSS-selector-based edit to the raw blade file content.
// The AI returns { selector: "section.questions-area h2", action: "replace_text", value: "Hello FAQ" }
// We find the matching HTML element in the file and apply the edit.
function applySelectorEdit(fileContent, generated) {
  const { selector, action, value, styles } = generated;
  if (!selector || !action) return { success: false, error: 'Missing selector or action' };

  // Parse the CSS selector into tag + classes + id + descendant
  // Supports: tag.class, tag#id, .class tag, parent child, tag:nth-child(n)
  const parts = selector.trim().split(/\s+/);
  const target = parts[parts.length - 1]; // innermost element
  const ancestors = parts.slice(0, -1);

  // Parse target into tag, classes, id
  const tagMatch = target.match(/^([a-z][a-z0-9]*)/i);
  const classMatches = [...target.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map(m => m[1]);
  const idMatch = target.match(/#([a-zA-Z0-9_-]+)/);
  const tag = tagMatch ? tagMatch[1] : null;

  // Build a regex to find the element in HTML (handles multi-line attributes)
  let pattern = '<';
  if (tag) {
    pattern += tag;
  } else {
    pattern += '[a-z][a-z0-9]*';
  }
  pattern += '[\\s\\S]*?'; // match attributes across multiple lines
  if (idMatch) pattern += `id=["']${idMatch[1]}["'][\\s\\S]*?`;
  for (const cls of classMatches) pattern += `(?=[\\s\\S]*?class=["'][^"']*\\b${cls}\\b)`;
  pattern += '>';

  // Verify ancestors exist by checking if the match is inside them
  const elementRegex = new RegExp(pattern, 'i');
  const match = fileContent.match(elementRegex);
  if (!match) return { success: false, error: `Element not found for selector: ${selector}` };

  const matchIndex = match.index;
  const openTag = match[0];
  const tagName = tag || openTag.match(/^<([a-z][a-z0-9]*)/i)?.[1];

  // Find the closing tag
  let depth = 1, i = matchIndex + openTag.length;
  const openRe = new RegExp(`<${tagName}[\\s>]`, 'gi');
  const closeRe = new RegExp(`</${tagName}>`, 'gi');

  // Simple: find content between open and close tag
  let closeIndex = -1;
  for (; i < fileContent.length; i++) {
    if (fileContent.substring(i).match(new RegExp(`^<${tagName}[\\s>]`, 'i'))) depth++;
    if (fileContent.substring(i).match(new RegExp(`^</${tagName}>`, 'i'))) {
      depth--;
      if (depth === 0) { closeIndex = i; break; }
    }
  }

  if (closeIndex === -1) return { success: false, error: `Could not find closing tag for ${tagName}` };

  const fullElement = fileContent.substring(matchIndex, closeIndex + `</${tagName}>`.length);
  const innerHTML = fileContent.substring(matchIndex + openTag.length, closeIndex);

  let newContent;
  switch (action) {
    case 'replace_text': {
      // Replace the text content inside the element, preserving child tags
      const textOnly = innerHTML.replace(/<[^>]*>/g, '').trim();
      if (textOnly) {
        newContent = fileContent.substring(0, matchIndex + openTag.length) + innerHTML.replace(textOnly, value) + fileContent.substring(closeIndex);
      } else {
        newContent = fileContent.substring(0, matchIndex + openTag.length) + value + fileContent.substring(closeIndex);
      }
      break;
    }
    case 'replace_html': {
      newContent = fileContent.substring(0, matchIndex + openTag.length) + value + fileContent.substring(closeIndex);
      break;
    }
    case 'replace_image': {
      // Replace src attribute in the matched img tag
      const srcRegex = /src=["'][^"']*["']/;
      if (srcRegex.test(fullElement)) {
        const newElement = fullElement.replace(srcRegex, `src="${value}"`);
        newContent = fileContent.substring(0, matchIndex) + newElement + fileContent.substring(matchIndex + fullElement.length);
      } else {
        return { success: false, error: 'No src attribute found in image element' };
      }
      break;
    }
    case 'update_style': {
      // Add/update inline style
      const styleStr = Object.entries(styles || {}).map(([k, v]) => `${k}: ${v}`).join('; ');
      const styleRegex = /style=["'][^"']*["']/;
      let newElement;
      if (styleRegex.test(openTag)) {
        newElement = openTag.replace(styleRegex, `style="${styleStr}"`);
      } else {
        newElement = openTag.replace('>', ` style="${styleStr}">`);
      }
      newContent = fileContent.substring(0, matchIndex) + newElement + fileContent.substring(matchIndex + openTag.length);
      break;
    }
    case 'insert_element': {
      const pos = generated.position || 'after';
      if (pos === 'before') {
        newContent = fileContent.substring(0, matchIndex) + value + '\n' + fileContent.substring(matchIndex);
      } else {
        const afterClose = matchIndex + fullElement.length;
        newContent = fileContent.substring(0, afterClose) + '\n' + value + fileContent.substring(afterClose);
      }
      break;
    }
    default:
      return { success: false, error: `Unknown action: ${action}` };
  }

  return { success: true, content: newContent };
}

// Tier 1/2 fast path — tried first by frontend
router.post('/quick', authenticateToken, (req, res, next) =>
  quickChangeController.handle(req, res, next)
);

router.post('/', authenticateToken, validateChangeRequest, (req, res, next) =>
  changeRequestController.create(req, res, next)
);

router.get('/', authenticateToken, (req, res, next) =>
  changeRequestController.list(req, res, next)
);

router.get('/:id', authenticateToken, (req, res, next) =>
  changeRequestController.getById(req, res, next)
);

// Accept — files are already on disk from the preview step, just mark as accepted
router.post('/:id/apply', authenticateToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const [requests] = await sequelize.query(
      'SELECT cr.*, p.project_url FROM change_requests cr JOIN projects p ON cr.project_id = p.id WHERE cr.id = $1',
      { bind: [id] }
    );
    if (!requests.length) return res.status(404).json({ error: 'Not found' });
    const cr = requests[0];
    if (cr.status !== 'pending_review') return res.status(400).json({ error: 'Not in pending_review state' });

    const io = req.app.get('io');
    const emit = (status, message) => {
      if (io) io.to(`cr-${id}`).emit(`change-request:${id}`, { status, message });
    };

    await sequelize.query("UPDATE change_requests SET status = 'review', updated_at = NOW() WHERE id = $1", { bind: [id] });
    emit('review', `Changes accepted`);
    res.json({ message: 'Accepted' });
  } catch (error) {
    next(error);
  }
});

// Restore a change request's files to their original content (DB-based undo, no git)
router.post('/:id/restore', authenticateToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const [requests] = await sequelize.query(
      'SELECT cr.*, p.local_path FROM change_requests cr JOIN projects p ON cr.project_id = p.id WHERE cr.id = $1',
      { bind: [id] }
    );
    if (!requests.length) return res.status(404).json({ error: 'Not found' });
    const cr = requests[0];
    // Ownership guard: editors can only restore their own changes; admins restore anything.
    if (req.user.role !== 'admin' && cr.user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only restore your own changes' });
    }
    if (cr.status !== 'review') return res.status(400).json({ error: 'Can only restore applied changes' });

    const [files] = await sequelize.query(
      'SELECT file_path, original_content FROM generated_code WHERE change_request_id = $1',
      { bind: [id] }
    );

    const fsp = require('fs').promises;
    const nodePath = require('path');
    for (const file of files) {
      if (file.original_content != null) {
        await fsp.writeFile(nodePath.join(cr.local_path, file.file_path), file.original_content, 'utf-8');
      }
    }

    await new Promise(resolve => require('child_process').exec('php artisan view:clear', { cwd: cr.local_path }, () => resolve()));
    await sequelize.query("UPDATE change_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1", { bind: [id] });

    const io = req.app.get('io');
    if (io) io.to(`cr-${id}`).emit(`change-request:${id}`, { status: 'rejected', message: 'Change restored to original' });

    res.json({ message: 'Restored to original' });
  } catch (error) {
    next(error);
  }
});

// Reject — restore original files from DB since the preview wrote them to disk
router.post('/:id/reject', authenticateToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const [requests] = await sequelize.query(
      'SELECT cr.*, p.local_path FROM change_requests cr JOIN projects p ON cr.project_id = p.id WHERE cr.id = $1',
      { bind: [id] }
    );
    if (!requests.length) return res.status(404).json({ error: 'Not found' });
    const cr = requests[0];

    // Restore originals
    const [files] = await sequelize.query(
      'SELECT file_path, original_content FROM generated_code WHERE change_request_id = $1',
      { bind: [id] }
    );
    const fsp = require('fs').promises;
    const nodePath = require('path');
    for (const file of files) {
      if (file.original_content != null) {
        await fsp.writeFile(nodePath.join(cr.local_path, file.file_path), file.original_content, 'utf-8');
      }
    }
    await new Promise(resolve => require('child_process').exec('php artisan view:clear', { cwd: cr.local_path }, () => resolve()));

    await sequelize.query("UPDATE change_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1", { bind: [id] });
    const io = req.app.get('io');
    if (io) io.to(`cr-${id}`).emit(`change-request:${id}`, { status: 'rejected', message: 'Change rejected — files restored' });
    res.json({ message: 'Rejected and restored' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
