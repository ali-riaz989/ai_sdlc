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

// Confirm section — user approves the identified section, Phase 2 runs the edit
router.post('/:id/confirm', authenticateToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const [requests] = await sequelize.query(
      'SELECT cr.*, p.local_path, p.project_url FROM change_requests cr JOIN projects p ON cr.project_id = p.id WHERE cr.id = $1',
      { bind: [id] }
    );
    if (!requests.length) return res.status(404).json({ error: 'Not found' });
    const cr = requests[0];
    if (cr.status !== 'confirm_section') return res.status(400).json({ error: 'Not in confirm_section state' });

    const [gcRows] = await sequelize.query('SELECT * FROM generated_code WHERE change_request_id = $1 LIMIT 1', { bind: [id] });
    if (!gcRows.length) return res.status(400).json({ error: 'No section data' });
    const gc = gcRows[0];
    const sectionInfo = JSON.parse(gc.diff || '{}');
    const originalContent = gc.original_content;
    const lines = originalContent.split('\n');

    // Find the section by searching for the target heading text in the file
    // Don't trust AI-returned line numbers — they're often wrong
    let startLine = sectionInfo.line_start;
    let endLine = sectionInfo.line_end;

    if (sectionInfo.target_section) {
      const keywords = sectionInfo.target_section.toLowerCase().split(/\W+/).filter(w => w.length > 3);
      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase();
        if (/<h[1-6]/.test(lines[i])) {
          const matchCount = keywords.filter(k => lineLower.includes(k)).length;
          if (matchCount >= Math.min(2, keywords.length)) {
            // Found the heading — walk UP to find the containing block
            // Skip inner wrappers (caption, content, inner) — find outer block/card/item
            let blockStart = i;
            const innerWrappers = /caption|content|inner|text|desc|body|detail/i;
            for (let j = i; j >= Math.max(0, i - 40); j--) {
              if (/<section/.test(lines[j]) || /<article/.test(lines[j])) { blockStart = j; break; }
              const classMatch = lines[j].match(/<div\s[^>]*class="([^"]*)"/);
              if (classMatch && !innerWrappers.test(classMatch[1])) { blockStart = j; break; }
            }
            // Walk DOWN to find the closing of this block
            // Count div depth from blockStart
            let depth = 0;
            let blockEnd = Math.min(i + 40, lines.length);
            for (let j = blockStart; j < Math.min(blockStart + 80, lines.length); j++) {
              const opens = (lines[j].match(/<div[\s>]/g) || []).length;
              const closes = (lines[j].match(/<\/div>/g) || []).length;
              depth += opens - closes;
              if (j > blockStart && depth <= 0) { blockEnd = j + 1; break; }
              // Also stop at </section>
              if (/<\/section>/.test(lines[j])) { blockEnd = j + 1; break; }
            }
            startLine = blockStart;
            endLine = blockEnd;
            require('../utils/logger').info('Found sub-block by heading', { keywords, headingLine: i, range: `${startLine}-${endLine}` });
            break;
          }
        }
      }
    }

    const sectionContent = lines.slice(startLine, endLine).join('\n');

    await sequelize.query("UPDATE change_requests SET status = 'generating_code', updated_at = NOW() WHERE id = $1", { bind: [id] });
    res.json({ message: 'Confirmed' });

    // Phase 2 in background
    const aiService = require('../services/aiService');
    const fsp = require('fs').promises;
    const nodePath = require('path');
    const logger = require('../utils/logger');
    const io = req.app.get('io');
    const emit = (status, message) => { if (io) io.to(`cr-${id}`).emit(`change-request:${id}`, { status, message }); };

    const fail = async (msg) => {
      await sequelize.query("UPDATE change_requests SET status = 'failed', updated_at = NOW() WHERE id = $1", { bind: [id] });
      emit('failed', msg);
    };

    try {
      // ── Direct image replacement: if user uploaded an image and section has <img>, replace it directly ──
      const isImageChange = sectionInfo.saved_image_url && /image|photo|picture|img|replace.*image|change.*image|update.*image|upload/i.test(cr.prompt);
      if (isImageChange) {
        // Find the first <img in the section — match src attribute carefully (handles Blade {{ }})
        const imgSrcMatch = sectionContent.match(/<img\s[\s\S]*?src=(["'])([\s\S]*?)\1[\s\S]*?>/);
        if (imgSrcMatch) {
          const oldImgTag = imgSrcMatch[0];
          const oldSrc = imgSrcMatch[2];
          const quote = imgSrcMatch[1];
          const assetPath = `{{ asset('${sectionInfo.saved_image_url.substring(1)}') }}`;
          // Replace only the src value, preserve everything else
          const newImgTag = oldImgTag.replace(`src=${quote}${oldSrc}${quote}`, `src="${assetPath}"`);

          if (originalContent.includes(oldImgTag)) {
            const finalContent = originalContent.split(oldImgTag).join(newImgTag);
            const diffInfo = { old_block: oldImgTag, new_block: newImgTag, reasoning: 'Replaced image src with uploaded image' };

            await sequelize.query('UPDATE generated_code SET generated_content = $1, diff = $2 WHERE change_request_id = $3',
              { bind: [finalContent, JSON.stringify(diffInfo), id] });

            const absPath = nodePath.join(cr.local_path, gc.file_path);
            await fsp.writeFile(absPath, finalContent, 'utf-8');
            await new Promise(resolve => require('child_process').exec('php artisan view:clear', { cwd: cr.local_path }, () => resolve()));

            await sequelize.query("UPDATE change_requests SET status = 'pending_review', updated_at = NOW() WHERE id = $1", { bind: [id] });
            emit('pending_review', JSON.stringify({ message: 'Preview ready', diff: [{ file_path: gc.file_path, ...diffInfo }] }));
            require('../utils/logger').info('Direct image replacement', { old_src: imgMatch[1], new_src: assetPath });
            return;
          }
        }
      }

      // ── AI-powered edit for text/style/layout changes ──
      const generated = await aiService.executeEdit(cr.prompt, sectionContent, gc.file_path, null, sectionInfo.saved_image_url);

      if (generated.mode === 'skip') { await fail(generated.reason || 'AI could not determine the edit'); return; }
      if (generated.mode !== 'replace' || !generated.old_block) { await fail('AI returned unexpected response'); return; }

      // ── old_block/new_block replacement — like Claude Code ──
      let oldBlock = generated.old_block;
      let newBlock = generated.new_block;
      if (/^\d+\|\s/.test(oldBlock)) {
        oldBlock = oldBlock.split('\n').map(l => l.replace(/^\d+\|\s?/, '')).join('\n');
        newBlock = newBlock.split('\n').map(l => l.replace(/^\d+\|\s?/, '')).join('\n');
      }

      const tryReplace = (content, old_b, new_b) => content.includes(old_b) ? content.split(old_b).join(new_b) : null;
      const norm = s => s.replace(/\r\n/g, '\n');
      const trimL = s => s.split('\n').map(l => l.trimEnd()).join('\n');
      const normQ = s => s.replace(/[\u2018\u2019\u0060\u00B4]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-');

      let finalContent = tryReplace(originalContent, oldBlock, newBlock)
        || tryReplace(norm(originalContent), norm(oldBlock), norm(newBlock))
        || tryReplace(trimL(norm(originalContent)), trimL(norm(oldBlock)), trimL(norm(newBlock)))
        || tryReplace(normQ(originalContent), normQ(oldBlock), normQ(newBlock));

      if (!finalContent) { await fail('Could not locate the text to replace. old_block: ' + oldBlock.substring(0, 80)); return; }
      const diffInfo = { old_block: oldBlock, new_block: newBlock, reasoning: generated.reasoning };

      // PHP syntax check
      if (gc.file_path.endsWith('.php')) {
        const { validatePhpSyntax } = require('../services/phpValidator');
        const check = await validatePhpSyntax(finalContent);
        if (!check.valid) { await fail('Syntax error in generated code'); return; }
      }

      // Save and apply
      await sequelize.query('UPDATE generated_code SET generated_content = $1, diff = $2 WHERE change_request_id = $3',
        { bind: [finalContent, JSON.stringify(diffInfo), id] });

      const absPath = nodePath.join(cr.local_path, gc.file_path);
      await fsp.writeFile(absPath, finalContent, 'utf-8');
      await new Promise(resolve => require('child_process').exec('php artisan view:clear', { cwd: cr.local_path }, () => resolve()));

      await sequelize.query("UPDATE change_requests SET status = 'pending_review', updated_at = NOW() WHERE id = $1", { bind: [id] });
      emit('pending_review', JSON.stringify({ message: 'Preview ready', diff: [{ file_path: gc.file_path, ...diffInfo }] }));
      logger.info('Edit applied for preview', { file: gc.file_path, reasoning: generated.reasoning });

    } catch (err) {
      logger.error('Confirm failed', { error: err.message });
      await fail(err.message);
    }
  } catch (error) {
    next(error);
  }
});

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
