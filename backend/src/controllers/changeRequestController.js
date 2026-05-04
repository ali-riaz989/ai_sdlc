const { sequelize } = require('../config/database');
const aiService = require('../services/aiService');
const laravelAnalyzer = require('../services/laravelAnalyzer');
const routeResolver = require('../services/routeResolver');
const projectCache = require('../utils/projectCache');
const auditLogger = require('../utils/auditLogger');
const logger = require('../utils/logger');
const { exec } = require('child_process');
const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();
const path = require('path');
const fs = require('fs').promises;


class ChangeRequestController {
  async create(req, res, next) {
    try {
      const { project_id, title, prompt, category, image_base64, image_media_type, current_page_url, page_context, conversation, selected_element, resolved_blade_file, iframe_viewport } = req.body;
      const userId = req.user.id;

      const [projects] = await sequelize.query(
        'SELECT * FROM projects WHERE id = $1',
        { bind: [project_id] }
      );
      if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });

      const project = projects[0];
      const requestId = uuidv4();

      await sequelize.query(
        `INSERT INTO change_requests (id, project_id, user_id, title, prompt, category, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        { bind: [requestId, project_id, userId, title, prompt, category || 'content'] }
      );

      await auditLogger.log({
        change_request_id: requestId,
        user_id: userId,
        action: 'CREATE_CHANGE_REQUEST',
        entity_type: 'ChangeRequest',
        entity_id: requestId,
        new_value: { title, category },
        ip_address: req.ip_address,
        user_agent: req.user_agent
      });

      const [newRequest] = await sequelize.query(
        'SELECT * FROM change_requests WHERE id = $1',
        { bind: [requestId] }
      );

      const imageData = (image_base64 && image_media_type)
        ? { base64: image_base64, mediaType: image_media_type }
        : null;

      const _this = this;
      (async function() {
        try {
          await _this._processChangeRequest(requestId, project, req.app.get('io'), imageData, current_page_url, page_context, conversation, selected_element, resolved_blade_file, iframe_viewport);
        } catch (error) {
          console.error('>>> PROCESS ERROR:', error.message, error.stack);
          logger.error('Processing failed', { error: error.message, stack: error.stack, requestId });
        }
      })().catch(error => {
        console.error('>>> OUTER CATCH:', error);
      });

      res.json(newRequest[0]);
    } catch (error) {
      next(error);
    }
  }

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const [requests] = await sequelize.query(
        `SELECT cr.*, p.display_name as project_name
         FROM change_requests cr JOIN projects p ON cr.project_id = p.id WHERE cr.id = $1`,
        { bind: [id] }
      );
      if (requests.length === 0) return res.status(404).json({ error: 'Change request not found' });
      const [stagingEnvs] = await sequelize.query(
        'SELECT * FROM staging_environments WHERE change_request_id = $1 LIMIT 1',
        { bind: [id] }
      );
      const [generatedCode] = await sequelize.query(
        'SELECT id, file_path, change_type, diff FROM generated_code WHERE change_request_id = $1',
        { bind: [id] }
      );
      const result = requests[0];
      result.staging = stagingEnvs[0] || null;
      result.generated_code = generatedCode || [];
      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  async list(req, res, next) {
    try {
      const { status, project_id, page = 1, limit = 20 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);
      let query = `SELECT cr.*, p.display_name as project_name, p.production_url
                   FROM change_requests cr JOIN projects p ON cr.project_id = p.id WHERE 1=1`;
      const binds = [];
      if (status)     { binds.push(status);     query += ` AND cr.status = $${binds.length}`; }
      if (project_id) { binds.push(project_id); query += ` AND cr.project_id = $${binds.length}`; }
      query += ` ORDER BY cr.created_at DESC LIMIT $${binds.length + 1} OFFSET $${binds.length + 2}`;
      binds.push(parseInt(limit), offset);
      const [requests] = await sequelize.query(query, { bind: binds });
      res.json(requests);
    } catch (error) {
      next(error);
    }
  }

  // ── Main processor ─────────────────────────────────────────────────────────
  async _processChangeRequest(requestId, project, io, imageData = null, currentPageUrl = null, pageContext = null, conversation = null, selectedElement = null, clientResolvedBlade = null, iframeViewport = null) {
    const emit = (status, message) => {
      if (io) io.to(`cr-${requestId}`).emit(`change-request:${requestId}`, { status, message });
    };
    const emitFile = (file, change_type, status) => {
      if (io) io.to(`cr-${requestId}`).emit(`change-request:${requestId}:files`, { file, change_type, status });
    };

    try {
      logger.info('Processing change request', { requestId, currentPageUrl });
      const [rows] = await sequelize.query('SELECT * FROM change_requests WHERE id = $1', { bind: [requestId] });
      const changeRequest = rows[0];

      // ── Resolve current page → blade file ────────────────────────────────
      // Prefer the client-provided blade (pre-resolved once per URL, cached in the
      // chat session). Falls back to running the resolver here only if the client
      // didn't send one or sent something that no longer exists on disk.
      let pageBladeFile = null;
      let routeUnresolved = false;
      if (clientResolvedBlade?.blade_file) {
        const abs = path.join(project.local_path, clientResolvedBlade.blade_file);
        try {
          await fs.access(abs);
          pageBladeFile = { blade_file: clientResolvedBlade.blade_file, abs_path: abs };
          logger.info('Page blade reused from client cache', { blade: pageBladeFile.blade_file });
        } catch {
          logger.warn('Client-provided blade missing on disk, falling back to resolver', { blade: clientResolvedBlade.blade_file });
        }
      }
      if (!pageBladeFile && currentPageUrl) {
        await this._updateStatus(requestId, 'analyzing');
        emit('analyzing', 'Resolving page…');
        const resolved = await routeResolver.resolve(project.local_path, currentPageUrl);
        if (resolved) {
          try {
            await fs.access(resolved.abs_path);
            pageBladeFile = resolved;
            logger.info('Page resolved', { blade: resolved.blade_file });
          } catch {
            logger.warn('Resolved blade file not found on disk', { abs: resolved.abs_path });
            routeUnresolved = true;
          }
        } else {
          routeUnresolved = true;
        }
      }

      // When the blade file is resolved → always use directGenerate (1 API call).
      if (pageBladeFile) {
        await this._directGenerate(requestId, project, changeRequest, pageBladeFile, emit, emitFile, io, pageContext, imageData, conversation, selectedElement, iframeViewport);
      } else if (routeUnresolved) {
        // The user is on a specific page but we cannot map the URL to a blade file.
        // Scanning the whole project is unsafe — it will pick an unrelated file. Fail clearly.
        const urlPath = (currentPageUrl || '').replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '') || '/';
        await this._fail(requestId, emit,
          `Could not find the Laravel route for "${urlPath}". The link in the page may be broken, or the route is missing from routes/web.php. Navigate to a page with a working route, then try again.`);
      } else {
        // No page URL was sent at all — fall back to full pipeline (e.g. dashboard prompt)
        await this._updateStatus(requestId, 'analyzing');
        emit('analyzing', 'Classifying change…');
        const classification = await aiService.classifyChange(changeRequest.prompt);
        logger.info('Classified', { type: classification.type, requestId });

        if (classification.type === 'text_swap' && !imageData) {
          await this._fastTextSwapPath(requestId, project, changeRequest, classification, pageBladeFile, emit, emitFile);
        } else {
          await this._fullAIPipeline(requestId, project, changeRequest, imageData, pageBladeFile, emit, emitFile, io, pageContext);
        }
      }
    } catch (error) {
      logger.error('Change request processing failed', { requestId, error: error.message, stack: error.stack });
      await this._fail(requestId, emit, `Processing failed: ${error.message}`);
    }
  }

  // ── Fast path: string replace in the scoped blade file only ───────────────
  async _fastTextSwapPath(requestId, project, changeRequest, classification, pageBladeFile, emit, emitFile) {
    emit('generating_code', 'Applying text change…');

    const filesToSearch = pageBladeFile
      ? [{ relative_path: pageBladeFile.blade_file }]   // scoped to current page only
      : await this._getAllViews(project);                // fallback: search all views

    let applied = false;
    const changedFiles = [];

    for (const view of filesToSearch) {
      const absPath = path.join(project.local_path, view.relative_path);
      let content;
      try { content = await fs.readFile(absPath, 'utf-8'); } catch { continue; }

      if (!content.includes(classification.target_text)) continue;

      emitFile(view.relative_path, 'modify', 'generating');
      const result = await aiService.fastTextSwap(content, absPath, classification.target_text, classification.new_text);

      if (result.found) {
        await fs.writeFile(absPath, result.content, 'utf-8');
        changedFiles.push({ file_path: view.relative_path, original_content: content, generated_content: result.content });
        emitFile(view.relative_path, 'modify', 'done');
        applied = true;
        break;
      }
    }

    if (!applied) {
      logger.info('Text not found, falling back to full pipeline', { requestId });
      await this._fullAIPipeline(requestId, project, changeRequest, null, pageBladeFile, emit, emitFile);
      return;
    }

    for (const f of changedFiles) {
      await sequelize.query(
        `INSERT INTO generated_code (id, change_request_id, file_path, original_content, generated_content, change_type)
         VALUES ($1, $2, $3, $4, $5, 'modify')`,
        { bind: [uuidv4(), requestId, f.file_path, f.original_content, f.generated_content] }
      );
    }

    await this._clearViewCache(project.local_path);
    await this._updateStatus(requestId, 'review');
    emit('review', `Changes applied: ${project.project_url}`);
    logger.info('Fast text swap complete', { requestId, files: changedFiles.length });
  }

  // ── Direct-edit flow: user selects an element in the iframe, AI edits it ──
  // Select-first is the only supported path — if nothing is selected, we fail fast
  // rather than guessing a section and asking the user to confirm.
  async _directGenerate(requestId, project, changeRequest, pageBladeFile, emit, emitFile, io, pageContext = null, imageData = null, conversation = null, selectedElement = null, iframeViewport = null) {
    if (!(selectedElement?.section || selectedElement?.text || selectedElement?.classes || selectedElement?.isImage)) {
      await this._fail(requestId, emit, 'Click the Select button and choose the element you want to edit, then describe the change.');
      return;
    }

    await this._updateStatus(requestId, 'analyzing');
    emit('analyzing', 'Preparing edit…');

    const absPath = path.join(project.local_path, pageBladeFile.blade_file);
    let originalContent = null;
    try { originalContent = await fs.readFile(absPath, 'utf-8'); } catch {}
    if (!originalContent) {
      await this._fail(requestId, emit, `Could not read file: ${pageBladeFile.blade_file}`);
      return;
    }

    // Save uploaded image to disk first
    let savedImageUrl = null;
    if (imageData) {
      try {
        const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[imageData.mediaType] || '.jpg';
        const filename = `ai-${Date.now()}${ext}`;
        const uploadDir = path.join(project.local_path, 'public', 'images');
        await fs.mkdir(uploadDir, { recursive: true });
        await fs.writeFile(path.join(uploadDir, filename), Buffer.from(imageData.base64, 'base64'));
        savedImageUrl = `/images/${filename}`;
        logger.info('Saved uploaded image', { path: savedImageUrl });
      } catch (imgErr) {
        logger.warn('Failed to save uploaded image', { error: imgErr.message });
      }
    }

    // ── Build structured sections from DOM context or code ─────────────
    let structuredSections = pageContext?.sections || [];
    if (!structuredSections.length) {
      const codeCtx = this._buildSectionMapFromCode(originalContent);
      structuredSections = codeCtx.sectionMap.map((s, i) => ({
        id: `sec_${i + 1}`,
        role: s.role,
        tag: 'section',
        classes: s.classes || '',
        headings: s.heading ? s.heading.split(' | ').map(h => ({ tag: s.headingTag || 'h2', text: h })) : [],
        text: (s.content || []).join(' ').substring(0, 200),
        children_summary: [],
        images: s.images || [],
        buttons: s.buttons || [],
        links: s.links || []
      }));
      logger.info('Built structured sections from code', { count: structuredSections.length });
    }

    const lines = originalContent.split('\n');

    {
      logger.info('Direct edit mode', { section: selectedElement.section, tag: selectedElement.tag, isImage: selectedElement.isImage });
      await this._updateStatus(requestId, 'generating_code');
      emit('generating_code', `Editing: ${selectedElement.section || selectedElement.tag || 'selected element'}`);

      // Image-upload intent: if the user uploaded an image, do the mechanical src swap (fast + deterministic)
      const hasUploadedImage = selectedElement.isImage === true || !!savedImageUrl;

      // Locate where the user clicked in the source.
      // ── PRIMARY PATH: data-blade-src attribute injected at compile time ──
      // This is deterministic — no text matching, no heuristics. The frontend reads
      // the attribute from the clicked DOM element and ships it as `selectedElement.bladeSrc`
      // in "<relative path>:<line>" form. If the element lives in an @include'd partial,
      // we transparently switch pageBladeFile to the partial.
      let clickLine = -1;
      if (typeof selectedElement.bladeSrc === 'string' && selectedElement.bladeSrc.includes(':')) {
        const lastColon = selectedElement.bladeSrc.lastIndexOf(':');
        const srcFile = selectedElement.bladeSrc.substring(0, lastColon);
        const srcLine = parseInt(selectedElement.bladeSrc.substring(lastColon + 1), 10);
        if (srcFile && Number.isFinite(srcLine) && srcLine > 0) {
          // If the click came from a different file than the resolved page blade
          // (i.e. a partial), redirect the entire edit there.
          if (srcFile !== pageBladeFile.blade_file) {
            const partialAbs = path.join(project.local_path, srcFile);
            try {
              const partialContent = await fs.readFile(partialAbs, 'utf-8');
              pageBladeFile = { blade_file: srcFile, abs_path: partialAbs };
              originalContent = partialContent;
              lines = partialContent.split('\n');
              logger.info('Click resolved to a partial — switching target file', { partial: srcFile, line: srcLine });
            } catch (e) {
              logger.warn('Cannot read partial referenced by data-blade-src; falling back', { srcFile, error: e.message });
            }
          }
          clickLine = Math.max(0, Math.min(srcLine - 1, lines.length - 1));
          logger.info('Click line from data-blade-src', { file: pageBladeFile.blade_file, clickLine: clickLine + 1 });
        }
      }
      // ── FALLBACK PATH: heuristic locator (older Blade renders without the
      // attribute injection, edge cases like JS-injected DOM nodes, etc.) ──
      if (clickLine < 0) {
        clickLine = this._locateElementInSource(lines, selectedElement);
        logger.info('Located click in source (fallback heuristic)', {
          clickLine, section: selectedElement.section, classes: selectedElement.classes,
          textPreview: (selectedElement.text || '').substring(0, 60),
        });
      }

      // ── Image upload intent detection ────────────────────────────────
      // The mechanical src-swap is fast and deterministic, but ONLY applies when
      // the user's prompt is purely about replacing the clicked image. Three failure
      // modes the shortcut cannot handle, so we must route them to the AI:
      //   1. ADD intent — "Add another image", "duplicate this slide", "another card"
      //   2. MIXED intent — image + text/title/date/description in one prompt
      //      (e.g. "Replace this blog with this image, title will be 'Hello world',
      //       date is …, description is …"). The mechanical path would silently
      //      swap only the image and lose every other change.
      // Default (bare upload, no prompt, or "replace this image" with no extras)
      // still uses the fast path.
      const promptText = (changeRequest.prompt || '').toLowerCase();
      const wantsToAdd = /\b(add|insert|append|another|one more|extra|additional|duplicate|copy|clone|new (image|slide|card|item|entry))\b/.test(promptText);
      // Words that signal the prompt is editing OTHER fields besides the image —
      // titles, headings, dates, descriptions, captions, links. If any of these
      // appear, the AI must handle the whole edit holistically.
      const mentionsOtherFields = /\b(title|heading|name|date|description|desc(?:ription)?|caption|subtitle|text|copy|content|paragraph|button|label|link|url|href|alt|price|address|phone|email)\b/.test(promptText);
      const wantsToReplace = /\b(replace|change|swap|update|set)\b/.test(promptText);
      // Mechanical swap only when: no add intent AND no other fields mentioned AND
      // either an explicit replace word OR the prompt is essentially empty.
      const isReplaceIntent = !wantsToAdd && !mentionsOtherFields && (wantsToReplace || promptText.trim().length < 3);

      // ── Image upload: mechanical src swap — no AI needed ─────────────
      if (hasUploadedImage && savedImageUrl && isReplaceIntent) {
        const oldImgTag = this._findSelectedImgTag(originalContent, selectedElement, clickLine);
        if (oldImgTag) {
          logger.info('Targeted <img>', { preview: oldImgTag.substring(0, 160) });
          const assetPath = `{{ asset('${savedImageUrl.substring(1)}') }}`;
          const newImgTag = oldImgTag.replace(/src\s*=\s*(["'])[\s\S]*?\1/, `src="${assetPath}"`);
          // Find every occurrence of oldImgTag and replace ONLY the one nearest the
          // click. Identical <img> tags repeat across header + footer logos and brand
          // carousels — split/join would clobber every occurrence and ruin the page.
          const occs = [];
          let from = 0;
          while (true) {
            const i = originalContent.indexOf(oldImgTag, from);
            if (i < 0) break;
            occs.push(i);
            from = i + Math.max(1, oldImgTag.length);
          }
          if (newImgTag !== oldImgTag && occs.length) {
            let chosenIdx = occs[0];
            if (clickLine >= 0 && occs.length > 1) {
              const lineOfIdx = (i) => originalContent.slice(0, i).split('\n').length - 1;
              let bestDist = Math.abs(lineOfIdx(chosenIdx) - clickLine);
              for (let i = 1; i < occs.length; i++) {
                const d = Math.abs(lineOfIdx(occs[i]) - clickLine);
                if (d < bestDist) { chosenIdx = occs[i]; bestDist = d; }
              }
            }
            emitFile(pageBladeFile.blade_file, 'modify', 'generating');
            const finalContent = originalContent.substring(0, chosenIdx) + newImgTag + originalContent.substring(chosenIdx + oldImgTag.length);
            const diffInfo = { old_block: oldImgTag, new_block: newImgTag, reasoning: 'Replaced selected image' };
            await sequelize.query(`INSERT INTO generated_code (id, change_request_id, file_path, original_content, generated_content, change_type, diff) VALUES ($1, $2, $3, $4, $5, 'modify', $6)`,
              { bind: [uuidv4(), requestId, pageBladeFile.blade_file, originalContent, finalContent, JSON.stringify(diffInfo)] });
            await fs.writeFile(absPath, finalContent, 'utf-8');
            await this._clearViewCache(project.local_path);
            await this._updateStatus(requestId, 'pending_review');
            emit('pending_review', JSON.stringify({ message: 'Preview ready', diff: [{ file_path: pageBladeFile.blade_file, ...diffInfo }] }));
            return;
          }
          logger.warn('Image tag found but replace produced no change', { oldImgTag: oldImgTag.substring(0, 120) });
        }
        await this._fail(requestId, emit, 'Could not find an image near the selected element. Click directly on the image you want to replace.');
        logger.warn('Image intent but no <img> located', { clickLine, selectedElement });
        return;
      }

      // ── Unified AI edit (Claude-Code style): give AI the blade file + linked CSS
      //    and let IT decide the intent (in-place edit, move, append, etc). No
      //    keyword matching on our side — Claude reads the prompt and picks.

      // If the file fits in a reasonable context window, send the whole thing so Claude
      // can do cross-section work (moves, swaps, additions referencing other sections).
      // Otherwise fall back to a window around the click point for large files.
      const FULL_FILE_BYTE_LIMIT = 120 * 1024; // ~30K tokens, well under Claude's limit
      let bladeSection;
      let clickAnchor = null;
      if (originalContent.length <= FULL_FILE_BYTE_LIMIT) {
        bladeSection = originalContent;
        if (clickLine >= 0 && clickLine < lines.length) clickAnchor = lines[clickLine];
        logger.info('Sending full blade file', { file: pageBladeFile.blade_file, lines: lines.length, bytes: originalContent.length });
      } else {
        const CONTEXT_BEFORE = 40;
        const CONTEXT_AFTER = 80;
        const foundLine = clickLine >= 0 ? clickLine : 0;
        let blockStart = Math.max(0, foundLine - CONTEXT_BEFORE);
        let blockEnd = Math.min(lines.length, foundLine + CONTEXT_AFTER);
        if (clickLine >= 0) {
          for (let j = foundLine; j >= blockStart; j--) {
            if (/<section|<article/i.test(lines[j])) { blockStart = j; break; }
          }
          for (let j = foundLine; j < blockEnd; j++) {
            if (/<\/section>|<\/article>/i.test(lines[j])) { blockEnd = j + 1; break; }
          }
        }
        bladeSection = lines.slice(blockStart, blockEnd).join('\n');
        logger.info('Blade candidate window (large file)', { foundLine, lines: `${blockStart}-${blockEnd}`, bytes: originalContent.length });
      }

      // Build a "click region" — a numbered window of ~30 lines around where the
      // user clicked, with a marker on the click line. This is the unambiguous
      // signal Claude needs to disambiguate when the same markup repeats (e.g.
      // multiple testimonial cards with identical structure). Verbatim file is
      // still sent separately so old_block can be copied character-for-character.
      let clickRegion = null;
      if (clickLine >= 0) {
        const before = 12, after = 18;
        const start = Math.max(0, clickLine - before);
        const end = Math.min(lines.length, clickLine + after + 1);
        const numbered = [];
        const lineWidth = String(end).length;
        for (let i = start; i < end; i++) {
          const num = String(i + 1).padStart(lineWidth, ' ');
          const marker = i === clickLine ? '▶' : ' ';
          numbered.push(`${marker} ${num} | ${lines[i]}`);
        }
        clickRegion = numbered.join('\n');
      }

      const candidates = [
        { path: pageBladeFile.blade_file, content: bladeSection, type: 'blade', clickAnchor, clickLine: clickLine >= 0 ? clickLine + 1 : null, clickRegion }
      ];

      // Is this a CMS-style template? (content rendered via @foreach($page->sections) + @includeIf)
      const isCmsTemplate = /@foreach\s*\(\s*\$page->sections/.test(originalContent)
        || /@includeIf\s*\(\s*['"][^'"]*sections?\./.test(originalContent);

      // If the primary blade doesn't contain the selected element's text, the content
      // likely lives in an included partial — search for it.
      const primaryHasText = clickLine >= 0;

      if (!primaryHasText) {
        try {
          const partialMatches = await this._findBladeFilesMatchingElement(
            project.local_path, selectedElement, pageBladeFile.blade_file, isCmsTemplate
          );
          for (const match of partialMatches) {
            const pLines = match.content.split('\n');
            const s = Math.max(0, match.line - 40);
            const e = Math.min(pLines.length, match.line + 80);
            const scoped = pLines.slice(s, e).join('\n');
            candidates.push({ path: match.rel, content: scoped, type: 'blade' });
          }
          if (partialMatches.length) {
            logger.info('Additional blade partials matched', {
              matches: partialMatches.map(m => `${m.rel} (line ${m.line}, score ${m.score})`)
            });
          } else if (isCmsTemplate && selectedElement.text) {
            // CMS page + text not found anywhere in blade partials → it's in the DB.
            await this._fail(requestId, emit,
              `The text "${selectedElement.text.substring(0, 60)}" is not in any blade template — it's managed through the CMS database. This platform edits code, not database content. Edit it through the site's admin panel.`);
            return;
          }
        } catch (pErr) {
          logger.warn('Partial discovery failed', { error: pErr.message });
        }
      }

      // Attach linked CSS files (scoped around the element's classes)
      try {
        const cssFiles = await this._findLinkedCssFiles(project.local_path, pageBladeFile);
        for (const f of cssFiles) {
          try {
            let content = await fs.readFile(f.abs, 'utf-8');
            if (content.length > 12000 && selectedElement.classes) {
              const classes = selectedElement.classes.split(/\s+/).filter(c => c.length > 1);
              const cssLines = content.split('\n');
              let best = -1, bestScore = 0;
              for (let i = 0; i < cssLines.length; i++) {
                let s = 0;
                for (const cls of classes) if (cssLines[i].includes('.' + cls)) s++;
                if (s > bestScore) { bestScore = s; best = i; }
              }
              if (best >= 0) {
                const s = Math.max(0, best - 60);
                const e = Math.min(cssLines.length, best + 180);
                content = cssLines.slice(s, e).join('\n');
              } else {
                content = content.substring(0, 12000);
              }
            } else if (content.length > 12000) {
              content = content.substring(0, 12000);
            }
            candidates.push({ path: f.rel, content, type: 'css' });
          } catch {}
        }
      } catch (cssErr) {
        logger.warn('CSS discovery failed', { error: cssErr.message });
      }

      // Attach linked JS files — without these the AI is blind to slider/carousel
      // init code, modal triggers, AJAX form handlers, etc. Skip vendor/minified
      // bundles (they're huge and not editable). Cap each file at 14KB.
      try {
        const jsFiles = await this._findLinkedJsFiles(project.local_path, pageBladeFile);
        for (const f of jsFiles) {
          try {
            let content = await fs.readFile(f.abs, 'utf-8');
            if (content.length > 14000) content = content.substring(0, 14000) + '\n/* …truncated… */';
            candidates.push({ path: f.rel, content, type: 'js' });
          } catch {}
        }
      } catch (jsErr) {
        logger.warn('JS discovery failed', { error: jsErr.message });
      }

      // Slider/carousel/modal-style prompts depend on knowing the project's existing
      // convention (Slick? Swiper? Owl? Bootstrap carousel? GLightbox?). Grep blade +
      // JS for matching keywords and surface a SHORT example of the existing pattern
      // so the AI clones the right structure instead of inventing one.
      try {
        const promptLc = (changeRequest.prompt || '').toLowerCase();
        const libHints = [
          { kw: 'slick', signal: /slick/i },
          { kw: 'swiper', signal: /swiper/i },
          { kw: 'owl', signal: /owl-carousel|owl\.carousel/i },
          { kw: 'carousel', signal: /class="[^"]*\bcarousel\b[^"]*"/i },
          { kw: 'glightbox', signal: /glightbox/i },
          { kw: 'fancybox', signal: /fancybox/i },
        ];
        const triggerKws = ['slider', 'slick', 'swiper', 'carousel', 'owl', 'gallery', 'lightbox', 'glightbox', 'fancybox', 'modal', 'tab', 'accordion'];
        const prompted = triggerKws.some(k => promptLc.includes(k));
        if (prompted) {
          const example = await this._findLibraryUsageExample(project.local_path, libHints, pageBladeFile.blade_file);
          if (example) {
            candidates.push({ path: example.rel, content: example.snippet, type: 'example' });
            logger.info('Library example attached', { rel: example.rel, lib: example.lib });
          }
        }
      } catch (exErr) {
        logger.warn('Library example discovery failed', { error: exErr.message });
      }

      logger.info('Sending candidates to AI', { files: candidates.map(c => `${c.path} (${c.type})`) });

      // Stream tokens back to the frontend as Claude generates — the existing
      // change-request:{id}:token socket channel feeds the streaming-tokens UI panel.
      const onToken = (chunk) => {
        if (io) io.to(`cr-${requestId}`).emit(`change-request:${requestId}:token`, { token: chunk });
      };

      // When the user uploads an image + asks to add (not replace), make the
      // intent explicit to the AI so the savedImageUrl hint doesn't bias it
      // toward a `src` swap. The AI's rules already cover ADD via old_block +
      // new_block (= old_block + new content); we just need to prime it.
      let aiPrompt = changeRequest.prompt;
      if (hasUploadedImage && savedImageUrl && wantsToAdd) {
        aiPrompt += `\n\nINTENT: ADD a new image (do NOT replace the clicked image). Find the nearest repeating block at the click region (carousel slide, gallery card, brand tile, etc.), copy it as old_block, and emit old_block + a CLONED block using the uploaded image's asset path as new_block. Preserve the original image; insert alongside.`;
      }

      const generated = await aiService.executeEditMulti({
        prompt: aiPrompt,
        selectedElement,
        candidates,
        conversation,
        imageData,
        savedImageUrl,
        onToken,
        iframeViewport,
      });

      if (generated.mode === 'skip' || !generated.file_path) {
        await this._fail(requestId, emit, generated.reason || 'AI could not determine the edit');
        return;
      }

      // Load the full file the AI chose
      const targetAbs = path.join(project.local_path, generated.file_path);
      let targetOriginal;
      try { targetOriginal = await fs.readFile(targetAbs, 'utf-8'); }
      catch {
        await this._fail(requestId, emit, `AI picked a file that cannot be read: ${generated.file_path}`);
        return;
      }

      // Click-region validation: when the AI edits the same file the user clicked in,
      // the proposed old_block MUST overlap the click region. Without this guard, Claude
      // sometimes picks a similar-looking element elsewhere in the file (e.g. another tab
      // with the same accordion structure) and silently edits the wrong thing.
      // We try exact-position first; if old_block was paraphrased and only fuzzy-matches,
      // we use the fuzzy match's line range so paraphrasing can't smuggle past the check.
      if (generated.mode === 'replace' && generated.file_path === pageBladeFile.blade_file && clickLine >= 0 && generated.old_block) {
        let oldBlockStartLine = -1, oldBlockEndLine = -1;
        // When old_block appears multiple times (duplicate markup like header+footer
        // logos), scan for ALL occurrences and pick the one nearest clickLine —
        // otherwise the in-region check would always grade against the FIRST match
        // in the file and incorrectly reject (or accept) the AI's edit.
        const occs = [];
        let from = 0;
        while (true) {
          const i = targetOriginal.indexOf(generated.old_block, from);
          if (i < 0) break;
          occs.push(i);
          from = i + Math.max(1, generated.old_block.length);
        }
        if (occs.length) {
          let exactIdx = occs[0];
          if (occs.length > 1) {
            let bestDist = Math.abs((targetOriginal.slice(0, exactIdx).split('\n').length - 1) - clickLine);
            for (let i = 1; i < occs.length; i++) {
              const ln = targetOriginal.slice(0, occs[i]).split('\n').length - 1;
              const d = Math.abs(ln - clickLine);
              if (d < bestDist) { exactIdx = occs[i]; bestDist = d; }
            }
          }
          oldBlockStartLine = targetOriginal.slice(0, exactIdx).split('\n').length - 1;
          oldBlockEndLine = oldBlockStartLine + generated.old_block.split('\n').length - 1;
        } else {
          const range = this._findFuzzyMatchRange(targetOriginal, generated.old_block, clickLine);
          if (range) { oldBlockStartLine = range.startLine; oldBlockEndLine = range.endLine; }
        }
        if (oldBlockStartLine >= 0) {
          const SLACK = 40;
          const inRegion = oldBlockEndLine >= clickLine - SLACK && oldBlockStartLine <= clickLine + SLACK;
          if (!inRegion) {
            logger.warn('AI edit lands outside click region', {
              clickLine: clickLine + 1, oldBlockLines: `${oldBlockStartLine + 1}-${oldBlockEndLine + 1}`,
              old_preview: generated.old_block.substring(0, 120),
            });
            await this._fail(requestId, emit,
              `The AI tried to edit lines ${oldBlockStartLine + 1}–${oldBlockEndLine + 1}, but you clicked around line ${clickLine + 1}. Please retry with a more specific prompt that names the element you want to change.`);
            return;
          }
        }
      }

      // Structural-move mode: AI returned 3 anchor lines; we do the cut/paste mechanically.
      let finalContent;
      let generatedOldBlock;
      let generatedNewBlock;
      if (generated.mode === 'move') {
        const fileLines = targetOriginal.split('\n');
        // Match both exact and whitespace-normalized so that indentation drift doesn't kill us
        const norm = s => (s || '').replace(/\s+/g, ' ').trim();
        const findMatches = (needle) => {
          const matches = [];
          const n = norm(needle);
          for (let i = 0; i < fileLines.length; i++) {
            if (fileLines[i] === needle || norm(fileLines[i]) === n) matches.push(i);
          }
          return matches;
        };
        const srcStartMatches = findMatches(generated.source_start);
        const srcEndMatches = findMatches(generated.source_end);
        const insertMatches = findMatches(generated.insert_before);
        if (!srcStartMatches.length || !srcEndMatches.length || !insertMatches.length) {
          logger.warn('Move anchors missing', {
            source_start_hits: srcStartMatches.length, source_start_preview: (generated.source_start || '').substring(0, 80),
            source_end_hits: srcEndMatches.length, source_end_preview: (generated.source_end || '').substring(0, 80),
            insert_before_hits: insertMatches.length, insert_before_preview: (generated.insert_before || '').substring(0, 80),
          });
          await this._fail(requestId, emit, `Move anchors not found verbatim in file (source_start=${srcStartMatches.length}, source_end=${srcEndMatches.length}, insert_before=${insertMatches.length}). Try rephrasing.`);
          return;
        }

        // For each (srcStart, srcEnd) pair where end > start, record the span.
        // Pair each srcStart with its NEAREST following srcEnd (tightest enclosing range —
        // correct for nested/repeated closing tags like </section>).
        const candidates = [];
        for (const s of srcStartMatches) {
          const e = srcEndMatches.find(ei => ei >= s);
          if (e !== undefined) candidates.push({ start: s, end: e, span: e - s });
        }
        if (!candidates.length) {
          await this._fail(requestId, emit, 'source_end line does not follow source_start in the file.');
          return;
        }
        // Prefer the smallest span (innermost block). If Claude chose a generic closing tag
        // as source_end, this still picks the matching one for the source_start it named.
        candidates.sort((a, b) => a.span - b.span);
        const { start: srcStart, end: srcEnd } = candidates[0];

        // Pick the insert anchor that is OUTSIDE the source range and closest to it
        // (on the side the user likely meant — we can't perfectly infer side, but nearest-outside
        // is almost always the correct pick for a single-step move).
        const outsideInserts = insertMatches.filter(i => i < srcStart || i > srcEnd);
        if (!outsideInserts.length) {
          await this._fail(requestId, emit, 'insert_before anchor is inside the block being moved.');
          return;
        }
        outsideInserts.sort((a, b) => Math.min(Math.abs(a - srcStart), Math.abs(a - srcEnd)) - Math.min(Math.abs(b - srcStart), Math.abs(b - srcEnd)));
        const insertIdx = outsideInserts[0];

        const block = fileLines.slice(srcStart, srcEnd + 1);
        // Remove the block, then insert before the target (accounting for index shift)
        const without = [...fileLines.slice(0, srcStart), ...fileLines.slice(srcEnd + 1)];
        const newInsertIdx = insertIdx > srcEnd ? insertIdx - block.length : insertIdx;
        const reordered = [...without.slice(0, newInsertIdx), ...block, ...without.slice(newInsertIdx)];
        finalContent = reordered.join('\n');

        // Build a compact diff preview covering just the affected span
        const spanStart = Math.min(srcStart, insertIdx);
        const spanEnd = Math.max(srcEnd, insertIdx);
        generatedOldBlock = fileLines.slice(spanStart, spanEnd + 1).join('\n');
        const newSpanStart = Math.min(newInsertIdx, newInsertIdx + block.length);
        const newSpanEnd = Math.max(newInsertIdx + block.length - 1, newInsertIdx - 1) + (insertIdx > srcEnd ? 0 : block.length);
        // Safer: recompute new span bounds from spanStart..spanEnd translated through the move
        const reorderedLines = reordered;
        const newSpanEndAdjusted = Math.min(spanEnd, reorderedLines.length - 1);
        generatedNewBlock = reorderedLines.slice(spanStart, newSpanEndAdjusted + 1).join('\n');
        logger.info('Structural move applied', { file: generated.file_path, srcLines: `${srcStart + 1}-${srcEnd + 1}`, targetLine: insertIdx + 1, blockLines: block.length });
        // suppress unused-var warning
        void newSpanStart; void newSpanEnd;
      } else if (!generated.old_block || generated.old_block.trim() === '') {
        // Append mode: AI wants to add new content with no existing block to replace
        if (!generated.new_block || generated.new_block.trim() === '') {
          await this._fail(requestId, emit, 'AI returned empty edit — nothing to change');
          return;
        }
        const sep = targetOriginal.endsWith('\n') ? '' : '\n';
        finalContent = targetOriginal + sep + generated.new_block + (generated.new_block.endsWith('\n') ? '' : '\n');
        generatedOldBlock = '';
        generatedNewBlock = generated.new_block;
        logger.info('Append mode', { file: generated.file_path, added: generated.new_block.length });
      } else {
        // Pass clickLine so location-aware replace picks the duplicate near the click,
        // not the first one in the file (header logo vs footer logo case).
        const replaceClickLine = (generated.file_path === pageBladeFile.blade_file) ? clickLine : -1;
        finalContent = this._applyBlockReplace(targetOriginal, generated.old_block, generated.new_block, replaceClickLine);
        if (!finalContent) {
          logger.warn('Block replace failed', {
            file: generated.file_path,
            old_preview: generated.old_block.substring(0, 200),
            new_preview: (generated.new_block || '').substring(0, 200)
          });
          await this._fail(requestId, emit, `Could not locate the text to replace in ${generated.file_path}. The AI's old_block didn't match the file verbatim — try again or rephrase.`);
          return;
        }
        generatedOldBlock = generated.old_block;
        generatedNewBlock = generated.new_block;
      }

      const diffInfo = { old_block: generatedOldBlock, new_block: generatedNewBlock, reasoning: generated.reasoning };
      emitFile(generated.file_path, 'modify', 'generating');
      await sequelize.query(`INSERT INTO generated_code (id, change_request_id, file_path, original_content, generated_content, change_type, diff) VALUES ($1, $2, $3, $4, $5, 'modify', $6)`,
        { bind: [uuidv4(), requestId, generated.file_path, targetOriginal, finalContent, JSON.stringify(diffInfo)] });
      await fs.writeFile(targetAbs, finalContent, 'utf-8');
      await this._clearViewCache(project.local_path);
      await this._updateStatus(requestId, 'pending_review');
      emit('pending_review', JSON.stringify({ message: 'Preview ready', diff: [{ file_path: generated.file_path, ...diffInfo }] }));
      logger.info('Unified edit applied', { requestId, file: generated.file_path, reasoning: generated.reasoning });
      return;
    }
  }

  // ── Locate selected element in source using every signal available ─────────
  _locateElementInSource(lines, sel) {
    // Tier 1: User clicked an <img> directly — match by src filename
    if (sel.isImage && sel.src) {
      const filename = sel.src.split(/[?#]/)[0].split('/').pop();
      if (filename && filename.length > 2) {
        for (let i = 0; i < lines.length; i++) {
          if (/<img/i.test(lines[i]) && lines[i].includes(filename)) return i;
        }
      }
    }

    // Collect candidate heading/text phrases (section name + first line of innerText)
    const phrases = [];
    if (sel.section && sel.section.length > 2) phrases.push(sel.section);
    if (sel.text) {
      for (const ln of sel.text.split('\n')) {
        const t = ln.trim();
        if (t.length > 2 && !phrases.includes(t)) { phrases.push(t.substring(0, 60)); break; }
      }
    }
    const looksLikeHeadingText = (s) => /[a-z]/i.test(s) && /\s/.test(s) || /[a-z]/i.test(s) && !/^[a-z0-9_-]+$/i.test(s);

    // The exact tag the user clicked, if known. We use this to bias matches toward
    // the right tag family instead of grabbing any heading that happens to mention
    // the same words.
    const clickedTag = (sel.tag || '').toLowerCase();
    const tagPattern = /^h[1-6]$/.test(clickedTag) ? clickedTag : null;

    // When the page has N peer elements with identical tag+text (3 testimonial cards
    // saying "test testimonial", etc.), the frontend tells us WHICH occurrence the user
    // clicked. We then need to return the Nth match in source order, not the 1st.
    const occurrenceIdx = Math.max(0, parseInt(sel.occurrenceIndex || 0, 10) || 0);
    // Helper that "consumes" the first N matches and returns the (N+1)th. If no Nth
    // match exists (file has fewer matches than the page does — unlikely, but possible
    // when blade @foreach renders), it falls back to the last available match.
    const pickNth = (matchFn) => {
      let lastFound = -1;
      let seen = 0;
      for (let i = 0; i < lines.length; i++) {
        if (matchFn(i)) {
          if (seen === occurrenceIdx) return i;
          lastFound = i;
          seen++;
        }
      }
      return lastFound; // graceful fallback: best of what we found
    };

    // Tier 2a: TAG-SPECIFIC multi-line match (occurrence-aware). When the user clicked
    // an h1, look for <h1 ...> openings (which may not have the text on the same line)
    // and check the heading's textual content. If multiple peers share the same text
    // (e.g. duplicate testimonial titles), pickNth selects the occurrenceIdx-th match.
    if (tagPattern) {
      for (const p of phrases) {
        if (!looksLikeHeadingText(p)) continue;
        const needle = p.toLowerCase();
        const openRe = new RegExp(`<${tagPattern}\\b`, 'i');
        const closeRe = new RegExp(`</${tagPattern}\\s*>`, 'i');
        const idx = pickNth((i) => {
          if (!openRe.test(lines[i])) return false;
          const blockEnd = Math.min(i + 7, lines.length);
          let block = '';
          let foundClose = false;
          for (let j = i; j < blockEnd; j++) {
            block += lines[j].toLowerCase() + ' ';
            if (closeRe.test(lines[j])) { foundClose = true; break; }
          }
          return foundClose && block.includes(needle);
        });
        if (idx >= 0) return idx;
      }
    }

    // Tier 2b: Generic h1-h6 multi-line match (occurrence-aware).
    for (const p of phrases) {
      if (!looksLikeHeadingText(p)) continue;
      const needle = p.toLowerCase();
      const idx = pickNth((i) => {
        if (!/<h[1-6]\b/i.test(lines[i])) return false;
        const blockEnd = Math.min(i + 7, lines.length);
        let block = '';
        let foundClose = false;
        for (let j = i; j < blockEnd; j++) {
          block += lines[j].toLowerCase() + ' ';
          if (/<\/h[1-6]\s*>/i.test(lines[j])) { foundClose = true; break; }
        }
        return foundClose && block.includes(needle);
      });
      if (idx >= 0) return idx;
    }

    // Tier 3: Phrase anywhere on a line (substring match, occurrence-aware).
    // Skip <title> / <meta> matches in document head — those are SEO, not the click target.
    for (const p of phrases) {
      if (!looksLikeHeadingText(p)) continue;
      const needle = p.toLowerCase();
      const idx = pickNth((i) => {
        const ll = lines[i].toLowerCase();
        if (!ll.includes(needle)) return false;
        if (/<(title|meta|link|script)\b/.test(ll)) return false;
        return true;
      });
      if (idx >= 0) return idx;
    }

    // Tier 4: CSS classes — token-aware match (not substring), rarest class first
    if (sel.classes) {
      const targetClasses = sel.classes.split(/\s+/).filter(c => c.length > 1 && !/^[0-9]/.test(c));
      if (targetClasses.length) {
        const counts = targetClasses.map(cls => {
          let n = 0;
          for (const line of lines) {
            for (const m of line.matchAll(/class\s*=\s*["']([^"']*)["']/gi)) {
              if (m[1].split(/\s+/).includes(cls)) n++;
            }
          }
          return { cls, n };
        }).filter(x => x.n > 0).sort((a, b) => a.n - b.n);

        for (const { cls } of counts) {
          for (let i = 0; i < lines.length; i++) {
            for (const m of lines[i].matchAll(/class\s*=\s*["']([^"']*)["']/gi)) {
              if (m[1].split(/\s+/).includes(cls)) return i;
            }
          }
        }
      }
    }

    // Tier 5: heading-keyword fallback (split classname-ish strings and score)
    const sectionName = sel.section || '';
    const keywords = sectionName.toLowerCase().split(/\W+/).filter(w => w.length > 2);
    if (keywords.length) {
      for (let i = 0; i < lines.length; i++) {
        if (/<h[1-6]/.test(lines[i])) {
          const ll = lines[i].toLowerCase();
          const matchCount = keywords.filter(k => ll.includes(k)).length;
          if (matchCount >= Math.min(2, keywords.length)) return i;
        }
      }
    }

    return -1;
  }

  // ── Find the <img> tag the user is targeting ──────────────────────────────
  // Case A: user clicked the <img> directly → match by src filename
  // Case B: user clicked a container → return the <img> closest to the click line
  _findSelectedImgTag(content, sel, clickLine = -1) {
    // Helper: of the <img> matches found, pick the one whose source line is
    // closest to clickLine. Without this, an image whose filename happens to
    // appear in multiple <img> tags (e.g. logo reused in header + footer) would
    // resolve to the FIRST match and edit the wrong element.
    const pickNearestMatch = (matches) => {
      if (!matches.length) return null;
      if (clickLine < 0 || matches.length === 1) return matches[0].tag;
      let best = matches[0], bestDist = Math.abs(matches[0].line - clickLine);
      for (let i = 1; i < matches.length; i++) {
        const d = Math.abs(matches[i].line - clickLine);
        if (d < bestDist) { best = matches[i]; bestDist = d; }
      }
      return best.tag;
    };

    // Case A: direct IMG click — match by filename (or 2-segment path tail) and
    // disambiguate by proximity to clickLine.
    if (sel?.isImage && sel?.src) {
      const filename = sel.src.split(/[?#]/)[0].split('/').pop();
      if (filename && filename.length > 2) {
        const matches = [];
        for (const m of content.matchAll(/<img\b[^>]*>/gi)) {
          if (m[0].includes(filename)) {
            matches.push({ tag: m[0], line: content.slice(0, m.index).split('\n').length - 1 });
          }
        }
        const picked = pickNearestMatch(matches);
        if (picked) return picked;

        const pathTail = sel.src.split(/[?#]/)[0].split('/').slice(-2).join('/');
        if (pathTail && pathTail !== filename) {
          const tailMatches = [];
          for (const m of content.matchAll(/<img\b[^>]*>/gi)) {
            if (m[0].includes(pathTail)) {
              tailMatches.push({ tag: m[0], line: content.slice(0, m.index).split('\n').length - 1 });
            }
          }
          const pickedTail = pickNearestMatch(tailMatches);
          if (pickedTail) return pickedTail;
        }
      }
    }

    // Case B: find the <img> nearest to the click line (within 120 lines)
    if (clickLine >= 0) {
      let best = null;
      let bestDist = Infinity;
      for (const m of content.matchAll(/<img\b[^>]*>/gi)) {
        const lineNum = content.slice(0, m.index).split('\n').length - 1;
        const dist = Math.abs(lineNum - clickLine);
        if (dist < bestDist && dist <= 120) { bestDist = dist; best = m[0]; }
      }
      return best;
    }

    return null;
  }

  // ── Robust block replace with whitespace/quote normalisation ──────────────
  // clickLine (0-indexed) tells us which line the user actually clicked on. When
  // the same markup repeats (header + footer share an identical logo <img>), the
  // AI's verbatim old_block matches both — without this hint we'd replace the
  // FIRST one and clobber the wrong element. Pass clickLine so we replace the
  // occurrence nearest the user's click.
  _applyBlockReplace(originalContent, oldBlock, newBlock, clickLine = -1) {
    if (/^\d+\|\s/.test(oldBlock)) {
      oldBlock = oldBlock.split('\n').map(l => l.replace(/^\d+\|\s?/, '')).join('\n');
      newBlock = newBlock.split('\n').map(l => l.replace(/^\d+\|\s?/, '')).join('\n');
    }
    const norm = s => s.replace(/\r\n/g, '\n');
    const trimL = s => s.split('\n').map(l => l.trimEnd()).join('\n');
    const normQ = s => s.replace(/[\u2018\u2019\u0060\u00B4]/g, "'").replace(/[\u201C\u201D]/g, '"');
    const lineOf = (content, idx) => content.slice(0, idx).split('\n').length - 1;

    // Find every byte-offset of `o` inside `c` (not just the first).
    const allOccurrences = (c, o) => {
      const out = [];
      if (!o) return out;
      let from = 0;
      while (true) {
        const i = c.indexOf(o, from);
        if (i < 0) break;
        out.push(i);
        from = i + Math.max(1, o.length);
      }
      return out;
    };
    // Of the given offsets, return the one whose line is closest to clickLine.
    // Falls back to the first occurrence when clickLine is unknown.
    const pickNearest = (occs, c, ref) => {
      if (!occs.length) return -1;
      if (ref < 0 || occs.length === 1) return occs[0];
      let best = occs[0], bestDist = Math.abs(lineOf(c, best) - ref);
      for (let i = 1; i < occs.length; i++) {
        const d = Math.abs(lineOf(c, occs[i]) - ref);
        if (d < bestDist) { best = occs[i]; bestDist = d; }
      }
      return best;
    };

    // Levels 1-4 (exact, line-end norm, trailing-ws strip, smart-quote norm).
    // For each variant where old_block matches, replace ONLY the occurrence nearest
    // the click — never split/join (which would replace EVERY occurrence and clobber
    // duplicate markup elsewhere in the file, e.g. the header logo when the user
    // clicked the footer logo).
    const variants = [
      { o: oldBlock, n: newBlock, c: originalContent },
      { o: norm(oldBlock), n: norm(newBlock), c: norm(originalContent) },
      { o: trimL(norm(oldBlock)), n: trimL(norm(newBlock)), c: trimL(norm(originalContent)) },
      { o: normQ(oldBlock), n: normQ(newBlock), c: normQ(originalContent) },
    ];
    for (const { o, n, c } of variants) {
      const occs = allOccurrences(c, o);
      if (!occs.length) continue;
      const idx = pickNearest(occs, c, clickLine);
      return c.substring(0, idx) + n + c.substring(idx + o.length);
    }

    // Level 5 — FUZZY: allow Claude's old_block to differ from the file in:
    //   • leading whitespace per line (indent drift)
    //   • blank-line count between non-blank lines (Claude often collapses gaps)
    try {
      const escape = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const oldLinesRaw = norm(oldBlock).split('\n');
      // Drop blank lines from both ends and middle; we anchor only by non-blank content.
      const nonBlankLines = oldLinesRaw.filter(l => l.trim() !== '');
      if (nonBlankLines.length === 0) return null;

      // Each non-blank line must appear on its own line in the file with arbitrary
      // leading whitespace. Between consecutive non-blank lines, allow ANY number of
      // newline+whitespace characters (covers Claude collapsing N blank lines into 0).
      const parts = nonBlankLines.map(l => '[ \\t]*' + escape(l.trimStart()));
      const pattern = parts.join('(?:\\r?\\n[ \\t]*)+');
      const re = new RegExp(pattern, 'g');
      const normContent = norm(originalContent);
      // Collect every fuzzy match, then pick the one whose line is nearest clickLine.
      // Without this, repeating markup (header/footer logo with slight whitespace
      // drift) silently lands on the first occurrence regardless of where the user clicked.
      const matches = [];
      let mm;
      while ((mm = re.exec(normContent)) !== null) {
        matches.push({ idx: mm.index, matched: mm[0] });
        if (mm[0].length === 0) re.lastIndex++;
      }
      if (matches.length) {
        let chosen = matches[0];
        if (clickLine >= 0 && matches.length > 1) {
          let bestDist = Math.abs(lineOf(normContent, chosen.idx) - clickLine);
          for (let i = 1; i < matches.length; i++) {
            const d = Math.abs(lineOf(normContent, matches[i].idx) - clickLine);
            if (d < bestDist) { chosen = matches[i]; bestDist = d; }
          }
        }
        const { idx, matched } = chosen;
        // Re-indent newBlock so its first line aligns with the matched indent in the file.
        const firstIndent = (matched.match(/^[ \t]*/) || [''])[0];
        const newLines = norm(newBlock).split('\n');
        const oldFirstIndent = (nonBlankLines[0].match(/^[ \t]*/) || [''])[0];
        const reindented = newLines.map(line => {
          if (line.trim() === '') return line;
          const lineIndent = (line.match(/^[ \t]*/) || [''])[0];
          const stripped = line.slice(lineIndent.length);
          const relativeSpaces = lineIndent.length - oldFirstIndent.length;
          return firstIndent + (relativeSpaces > 0 ? ' '.repeat(relativeSpaces) : '') + stripped;
        }).join('\n');
        return normContent.substring(0, idx) + reindented + normContent.substring(idx + matched.length);
      }
    } catch (e) {
      logger.warn('Fuzzy replace error', { error: e.message });
    }
    return null;
  }

  // After a fuzzy match succeeds we don't have a literal byte-offset for old_block
  // (it doesn't appear verbatim in the file). To still validate that the edit lands
  // inside the click region, we run the same fuzzy-match regex against the original
  // content and return the matched line range. Returns { startLine, endLine } in
  // 0-indexed coords, or null if no match.
  _findFuzzyMatchRange(originalContent, oldBlock, clickLine = -1) {
    try {
      const norm = s => s.replace(/\r\n/g, '\n');
      const escape = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const nonBlankLines = norm(oldBlock).split('\n').filter(l => l.trim() !== '');
      if (!nonBlankLines.length) return null;
      const parts = nonBlankLines.map(l => '[ \\t]*' + escape(l.trimStart()));
      const re = new RegExp(parts.join('(?:\\r?\\n[ \\t]*)+'), 'g');
      const normContent = norm(originalContent);
      // Pick the fuzzy match whose start-line is closest to clickLine, so the
      // in-region check matches the occurrence we actually intend to replace.
      let chosen = null, bestDist = Infinity;
      let m;
      while ((m = re.exec(normContent)) !== null) {
        const startLine = normContent.substring(0, m.index).split('\n').length - 1;
        if (clickLine < 0) { chosen = { idx: m.index, startLine, full: m[0] }; break; }
        const d = Math.abs(startLine - clickLine);
        if (d < bestDist) { chosen = { idx: m.index, startLine, full: m[0] }; bestDist = d; }
        if (m[0].length === 0) re.lastIndex++;
      }
      if (!chosen) return null;
      const endLine = chosen.startLine + chosen.full.split('\n').length - 1;
      return { startLine: chosen.startLine, endLine };
    } catch { return null; }
  }

  // ── Find blade partials containing the selected element's text or classes ─────
  // Laravel CMS pages use @foreach + @includeIf to pull content from partials.
  // The route-resolved blade is often just a skeleton; the real text lives elsewhere.
  // This grep-ranks all blade files under resources/views/ and returns the best matches.
  async _findBladeFilesMatchingElement(projectPath, selectedElement, excludeRel, isCmsTemplate = false) {
    const viewsRoot = path.join(projectPath, 'resources', 'views');
    const allBlades = [];
    const walk = async (dir) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) await walk(fp);
        else if (e.name.endsWith('.blade.php')) allBlades.push(fp);
      }
    };
    await walk(viewsRoot);

    // Skip admin views — user is editing the frontend
    let bladesToScan = allBlades.filter(p => !/[\\/]admin[\\/]/.test(p));

    // For CMS templates, restrict strictly to sections/partials directories.
    // Otherwise, matches like navigation menus in static_pages dominate.
    if (isCmsTemplate) {
      bladesToScan = bladesToScan.filter(p => /[\\/]frontend[\\/](sections|partials)[\\/]/.test(p));
    }

    // Build search needles — only the most specific signals
    const needles = [];
    if (selectedElement.text) {
      const firstLine = selectedElement.text.split('\n').map(s => s.trim()).find(s => s.length > 4 && /[a-z]/i.test(s));
      if (firstLine) {
        needles.push({ type: 'text', value: firstLine.substring(0, 50).toLowerCase(), weight: 10 });
      }
    }
    if (selectedElement.classes) {
      for (const cls of selectedElement.classes.split(/\s+/)) {
        if (cls.length > 3 && !/^[0-9]/.test(cls) && !['row','col','btn','img','div','block','text','content','card','item','main','wrapper','inner','container'].includes(cls)) {
          needles.push({ type: 'class', value: cls, weight: 4 });
        }
      }
    }
    if (!needles.length) return [];

    const tag = (selectedElement.tag || '').toLowerCase();
    const isHeading = /^h[1-6]$/.test(tag);

    const results = [];
    for (const abs of bladesToScan) {
      const rel = path.relative(projectPath, abs);
      if (rel === excludeRel) continue; // already included as primary
      let content;
      try { content = await fs.readFile(abs, 'utf-8'); } catch { continue; }

      let score = 0;
      let bestLine = -1;
      let tagMatched = false;
      const lines = content.split('\n');
      for (const n of needles) {
        if (n.type === 'text') {
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].toLowerCase();
            if (!line.includes(n.value)) continue;
            let lineScore = n.weight;
            // Tag bonus: if user clicked h2 and line has <h2>, big bonus. Wrong tag family: small penalty.
            if (isHeading) {
              if (line.includes(`<${tag}`) || line.includes(`<${tag} `) || line.includes(`<${tag}>`)) { lineScore += 8; tagMatched = true; }
              else if (/<h[1-6]/.test(line)) lineScore -= 2;
            } else if (tag && (line.includes(`<${tag} `) || line.includes(`<${tag}>`))) {
              lineScore += 4; tagMatched = true;
            }
            score += lineScore;
            if (bestLine < 0) bestLine = i;
            break;
          }
        } else if (n.type === 'class') {
          const safe = n.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`class\\s*=\\s*["'][^"']*\\b${safe}\\b`, 'i');
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              score += n.weight;
              if (bestLine < 0) bestLine = i;
              break;
            }
          }
        }
      }

      // Prefer CMS partial directories (sections/, partials/) where content lives in CMS apps
      if (/[\\/]frontend[\\/](sections|partials)[\\/]/.test(rel)) score += 2;

      // Require a strong match — text + correct tag, or classes + text. Drop weak single-word hits.
      if (score < 10 || (needles.some(n => n.type === 'text') && !tagMatched && score < 14)) continue;

      results.push({ rel, abs, content, score, line: Math.max(0, bestLine) });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 3); // top 3 partials
  }

  // ── Find CSS files referenced from the page blade + its extends/include tree ──
  // Generic: walks @extends / @include / @component refs from ANY blade.
  async _findLinkedCssFiles(projectPath, pageBladeFile) {
    const viewsRoot = path.join(projectPath, 'resources', 'views');
    const visited = new Set();
    const bladeContents = [];

    const resolveBladeName = async (dottedName) => {
      // Try a few common resolutions Laravel supports
      const parts = dottedName.replace(/^\/+/, '').split(/[./]/).join('/');
      const candidates = [
        path.join(viewsRoot, parts + '.blade.php'),
        path.join(viewsRoot, parts, 'index.blade.php')
      ];
      for (const c of candidates) {
        try { await fs.access(c); return c; } catch {}
      }
      return null;
    };

    const walk = async (absPath) => {
      if (!absPath || visited.has(absPath)) return;
      visited.add(absPath);
      let content;
      try { content = await fs.readFile(absPath, 'utf-8'); } catch { return; }
      bladeContents.push(content);
      const refPattern = /@(?:extends|include|includeIf|includeWhen|includeUnless|includeFirst|component|yield)\s*\(\s*['"]([^'"]+)['"]/g;
      const seenRefs = new Set();
      for (const m of content.matchAll(refPattern)) seenRefs.add(m[1]);
      for (const ref of seenRefs) {
        const child = await resolveBladeName(ref);
        if (child) await walk(child);
      }
    };

    await walk(path.join(projectPath, pageBladeFile.blade_file));

    const combined = bladeContents.join('\n');
    const seenCss = new Set();
    const refs = [];
    const pushRef = (raw) => {
      let p = raw.replace(/^\/+/, '').replace(/\?.*$/, '').replace(/#.*$/, '');
      if (!p.toLowerCase().endsWith('.css') || seenCss.has(p)) return;
      seenCss.add(p); refs.push(p);
    };
    for (const m of combined.matchAll(/href\s*=\s*["']([^"']+\.css[^"']*)["']/gi)) pushRef(m[1]);
    for (const m of combined.matchAll(/asset\(\s*['"]([^'"]+\.css)['"]\s*\)/gi)) pushRef(m[1]);
    for (const m of combined.matchAll(/url\(\s*['"]?([^'")]+\.css)['"]?\s*\)/gi)) pushRef(m[1]);

    const resolved = [];
    for (const p of refs) {
      const tries = [
        path.join(projectPath, 'public', p),
        path.join(projectPath, p),
        path.join(projectPath, 'resources', p),
        path.join(projectPath, 'resources', 'css', path.basename(p))
      ];
      for (const abs of tries) {
        try { await fs.access(abs); resolved.push({ rel: path.relative(projectPath, abs), abs }); break; } catch {}
      }
    }
    return resolved;
  }

  // ── Linked JS file discovery (mirrors _findLinkedCssFiles) ──────────────
  // Walks the blade extend/include chain, collects every <script src=…> /
  // asset('…js') / mix('…js') reference, resolves under public/ resources/
  // and skips obvious vendor/minified bundles the AI can't usefully edit.
  async _findLinkedJsFiles(projectPath, pageBladeFile) {
    const viewsRoot = path.join(projectPath, 'resources', 'views');
    const visited = new Set();
    const bladeContents = [];

    const resolveBladeName = async (dottedName) => {
      const parts = dottedName.replace(/^\/+/, '').split(/[./]/).join('/');
      const candidates = [
        path.join(viewsRoot, parts + '.blade.php'),
        path.join(viewsRoot, parts, 'index.blade.php'),
      ];
      for (const c of candidates) {
        try { await fs.access(c); return c; } catch {}
      }
      return null;
    };

    const walk = async (absPath) => {
      if (!absPath || visited.has(absPath)) return;
      visited.add(absPath);
      let content;
      try { content = await fs.readFile(absPath, 'utf-8'); } catch { return; }
      bladeContents.push(content);
      const refPattern = /@(?:extends|include|includeIf|includeWhen|includeUnless|includeFirst|component|yield)\s*\(\s*['"]([^'"]+)['"]/g;
      const seenRefs = new Set();
      for (const m of content.matchAll(refPattern)) seenRefs.add(m[1]);
      for (const ref of seenRefs) {
        const child = await resolveBladeName(ref);
        if (child) await walk(child);
      }
    };

    await walk(path.join(projectPath, pageBladeFile.blade_file));

    const combined = bladeContents.join('\n');
    const seenJs = new Set();
    const refs = [];
    // Skip vendor/minified bundles — the AI can't edit slick.min.js or jquery, and
    // they bloat the prompt. We still surface them via the "library example" path
    // for pattern lookups, just not as editable candidates here.
    const isVendor = (p) => /(\.min\.js$|\/(vendor|node_modules|lib|libs|libraries|plugins|jquery|bootstrap)\/)/i.test(p)
      || /^\/?(vendor|node_modules|libs|libraries)\//i.test(p);
    const pushRef = (raw) => {
      let p = raw.replace(/^\/+/, '').replace(/\?.*$/, '').replace(/#.*$/, '');
      if (!p.toLowerCase().endsWith('.js') || seenJs.has(p) || isVendor(p)) return;
      seenJs.add(p); refs.push(p);
    };
    for (const m of combined.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+\.js[^"']*)["']/gi)) pushRef(m[1]);
    for (const m of combined.matchAll(/asset\(\s*['"]([^'"]+\.js)['"]\s*\)/gi)) pushRef(m[1]);
    for (const m of combined.matchAll(/mix\(\s*['"]([^'"]+\.js)['"]\s*\)/gi)) pushRef(m[1]);

    const resolved = [];
    for (const p of refs) {
      const tries = [
        path.join(projectPath, 'public', p),
        path.join(projectPath, p),
        path.join(projectPath, 'resources', p),
        path.join(projectPath, 'resources', 'js', path.basename(p)),
      ];
      for (const abs of tries) {
        try { await fs.access(abs); resolved.push({ rel: path.relative(projectPath, abs), abs }); break; } catch {}
      }
    }
    return resolved;
  }

  // ── Find one short example of how this project already uses a UI library ──
  // When the user asks to add a slider/carousel/lightbox/modal, the AI needs
  // to clone the project's existing convention rather than invent a fresh
  // structure. This greps blade + JS files for known library signatures and
  // returns the FIRST short snippet around a hit.
  async _findLibraryUsageExample(projectPath, libHints, excludeBlade) {
    const viewsRoot = path.join(projectPath, 'resources', 'views');
    const jsRoots = [
      path.join(projectPath, 'public', 'js'),
      path.join(projectPath, 'public', 'assets', 'js'),
      path.join(projectPath, 'resources', 'js'),
    ];
    const collect = async (dir, ext) => {
      const out = [];
      const stack = [dir];
      while (stack.length) {
        const d = stack.pop();
        let entries;
        try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) {
            // Skip vendor heavyweights
            if (/^(node_modules|vendor|lib|libs|libraries|jquery|bootstrap)$/i.test(e.name)) continue;
            stack.push(full);
          } else if (e.isFile() && (Array.isArray(ext) ? ext.some(x => e.name.endsWith(x)) : e.name.endsWith(ext))) {
            // Skip vendor/minified
            if (/\.min\.js$/i.test(e.name)) continue;
            out.push(full);
          }
        }
      }
      return out;
    };
    const blades = await collect(viewsRoot, '.blade.php');
    const jsFiles = (await Promise.all(jsRoots.map(r => collect(r, '.js')))).flat();
    const allFiles = [...blades, ...jsFiles];

    for (const lib of libHints) {
      for (const file of allFiles) {
        const rel = path.relative(projectPath, file);
        if (rel === excludeBlade) continue;
        let content;
        try { content = await fs.readFile(file, 'utf-8'); } catch { continue; }
        const m = lib.signal.exec(content);
        if (!m) continue;
        const lines = content.split('\n');
        const hitLine = content.slice(0, m.index).split('\n').length - 1;
        // Capture a tight ~40-line window around the first hit so the AI sees both
        // the markup wrapper AND any nearby init code without flooding the prompt.
        const start = Math.max(0, hitLine - 12);
        const end = Math.min(lines.length, hitLine + 28);
        const snippet = `[Existing ${lib.kw} usage in ${rel} — clone this convention]\n\n` + lines.slice(start, end).join('\n');
        return { rel, lib: lib.kw, snippet };
      }
    }
    return null;
  }

  // ── Pick the CSS file most likely to own the selected element's classes ──
  async _pickCssFileForClasses(cssFiles, classesStr) {
    if (!cssFiles?.length) return null;
    const classes = (classesStr || '').split(/\s+/).filter(c => c.length > 1);
    if (!classes.length) {
      try { const content = await fs.readFile(cssFiles[0].abs, 'utf-8'); return { ...cssFiles[0], content }; } catch { return null; }
    }
    let best = null;
    let bestScore = 0;
    for (const f of cssFiles) {
      try {
        const content = await fs.readFile(f.abs, 'utf-8');
        let score = 0;
        for (const cls of classes) {
          const safe = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp('\\.' + safe + '\\b', 'g');
          const matches = content.match(re);
          if (matches) score += matches.length;
        }
        if (score > bestScore) { bestScore = score; best = { ...f, content }; }
      } catch {}
    }
    if (!best) {
      try { const content = await fs.readFile(cssFiles[0].abs, 'utf-8'); best = { ...cssFiles[0], content }; } catch {}
    }
    return best;
  }

  // ── Apply a CSS edit to the file that owns the selected element's classes ─
  async _applyCssEdit({ requestId, project, changeRequest, selectedElement, imageData, pageBladeFile, emit, emitFile, conversation }) {
    const cssFiles = await this._findLinkedCssFiles(project.local_path, pageBladeFile);
    if (!cssFiles.length) {
      logger.info('No linked CSS files found', { page: pageBladeFile.blade_file });
      return { applied: false, reason: 'no_css_found' };
    }
    const picked = await this._pickCssFileForClasses(cssFiles, selectedElement.classes);
    if (!picked) return { applied: false, reason: 'css_read_failed' };

    logger.info('Editing CSS file', { file: picked.rel, size: picked.content.length });
    emit('generating_code', `Editing stylesheet: ${picked.rel}`);
    emitFile(picked.rel, 'modify', 'generating');

    // Scope large files to a window around the most relevant class
    let scoped = picked.content;
    if (scoped.length > 15000 && selectedElement.classes) {
      const classes = selectedElement.classes.split(/\s+/).filter(c => c.length > 1);
      const cssLines = picked.content.split('\n');
      let bestLine = -1, bestScore = 0;
      for (let i = 0; i < cssLines.length; i++) {
        let s = 0;
        for (const cls of classes) if (cssLines[i].includes('.' + cls)) s++;
        if (s > bestScore) { bestScore = s; bestLine = i; }
      }
      if (bestLine >= 0) {
        const s = Math.max(0, bestLine - 80);
        const e = Math.min(cssLines.length, bestLine + 200);
        scoped = cssLines.slice(s, e).join('\n');
      } else {
        scoped = picked.content.substring(0, 15000);
      }
    }

    const styledPrompt = `The user selected an element <${selectedElement.tag || 'div'}> with classes: "${selectedElement.classes || ''}". Edit the CSS rule(s) that target those classes.\n\nRequest: ${changeRequest.prompt}`;
    const generated = await aiService.executeEdit(styledPrompt, scoped, picked.rel, imageData, null, 'css', conversation);

    if (generated.mode !== 'replace' || !generated.old_block) {
      return { applied: false, reason: generated.reason || 'ai_skip' };
    }

    const finalCss = this._applyBlockReplace(picked.content, generated.old_block, generated.new_block);
    if (!finalCss) return { applied: false, reason: 'replace_failed' };

    const diffInfo = { old_block: generated.old_block, new_block: generated.new_block, reasoning: generated.reasoning };
    await sequelize.query(`INSERT INTO generated_code (id, change_request_id, file_path, original_content, generated_content, change_type, diff) VALUES ($1, $2, $3, $4, $5, 'modify', $6)`,
      { bind: [uuidv4(), requestId, picked.rel, picked.content, finalCss, JSON.stringify(diffInfo)] });
    await fs.writeFile(picked.abs, finalCss, 'utf-8');
    await this._clearViewCache(project.local_path);
    await this._updateStatus(requestId, 'pending_review');
    emit('pending_review', JSON.stringify({ message: 'Preview ready', diff: [{ file_path: picked.rel, ...diffInfo }] }));
    logger.info('CSS edit applied', { requestId, file: picked.rel, reasoning: generated.reasoning });
    return { applied: true };
  }

  // ── Full pipeline: analyze → generate (scoped to current page file) ────────
  async _fullAIPipeline(requestId, project, changeRequest, imageData, pageBladeFile, emit, emitFile, io, pageContext = null) {
    emit('analyzing', 'Analyzing page…');

    // Load compact history of recent changes for this project
    const recentChanges = await this._getChangeHistory(project.id);
    const changeHistory = aiService.buildChangeHistory(recentChanges);

    let analysis;
    let analyzeMessages = []; // conversation thread passed into generate steps

    if (pageBladeFile) {
      // SCOPED: send only the single blade file — skip full LaravelAnalyzer
      let bladeContent = '';
      try { bladeContent = await fs.readFile(pageBladeFile.abs_path, 'utf-8'); } catch {}

      const { scanIncludes } = require('../services/bladeIncludeScanner');
      const relatedFiles = await scanIncludes(pageBladeFile.abs_path, project.local_path);

      ({ result: analysis, messages: analyzeMessages } = await aiService.analyzePageChange(
        changeRequest.prompt,
        pageBladeFile.blade_file,
        bladeContent,
        imageData,
        changeHistory,
        relatedFiles
      ));
    } else {
      // FALLBACK: use cached full project context
      let projectContext = await projectCache.get(project.id);
      if (!projectContext) {
        projectContext = await laravelAnalyzer.analyzeProject(project.local_path);
        await projectCache.set(project.id, projectContext);
      }
      ({ result: analysis, messages: analyzeMessages } = await aiService.analyzeChangeRequest(
        changeRequest.prompt, projectContext, changeRequest.category, imageData, changeHistory
      ));
    }

    await sequelize.query(
      `INSERT INTO ai_analysis (id, change_request_id, model_used, analysis_result, complexity_score, estimated_files_affected, risk_assessment)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      { bind: [uuidv4(), requestId, 'claude-sonnet-4-5', JSON.stringify(analysis), analysis.complexity || 1, (analysis.files_affected || []).length, analysis.risk_level || 'low'] }
    );

    await this._updateStatus(requestId, 'generating_code');
    emit('generating_code', 'Generating code…');

    // If page is scoped and analysis didn't return a plan, default to the resolved file
    const plan = analysis.implementation_plan && analysis.implementation_plan.length > 0
      ? analysis.implementation_plan
      : pageBladeFile
        ? [{ step: 1, file_path: pageBladeFile.blade_file, change_type: 'modify', description: changeRequest.prompt, details: changeRequest.prompt }]
        : [];

    const generatedFiles = [];
    for (const step of plan) {
      const absPath = path.join(project.local_path, step.file_path);
      let originalContent = null;
      try { originalContent = await fs.readFile(absPath, 'utf-8'); } catch {}

      emit('generating_code', `Generating: ${step.file_path}`);
      emitFile(step.file_path, step.change_type, 'generating');

      // Stream tokens to frontend while generating
      const onToken = (chunk) => {
        if (io) io.to(`cr-${requestId}`).emit(`change-request:${requestId}:token`, { token: chunk });
      };

      // Send only the relevant window to the AI — saves tokens and improves precision.
      // The old_block returned will still be verbatim from the file, so the replace works on the full content.
      const window = originalContent ? this._findRelevantWindow(originalContent, changeRequest.prompt, pageContext) : null;
      const contentForAI = window ? window.content : originalContent;
      if (window) logger.info('Using windowed context', { file: step.file_path, lines: `${window.startLine}-${window.endLine}`, score: window.score });

      // Thread the analyze conversation — AI already knows the plan, no need to re-explain
      const generated = await aiService.generateCode(step, contentForAI, analyzeMessages, onToken);

      let finalContent;
      if (generated.mode === 'replace') {
        // Surgical string replace — never overwrites the whole file
        const found = originalContent && originalContent.includes(generated.old_block);
        if (found) {
          finalContent = originalContent.split(generated.old_block).join(generated.new_block);
        } else if (originalContent) {
          // Try normalising line endings (CRLF → LF) before giving up
          const norm = s => s.replace(/\r\n/g, '\n');
          const normContent = norm(originalContent);
          const normOld = norm(generated.old_block);
          if (normContent.includes(normOld)) {
            finalContent = normContent.split(normOld).join(norm(generated.new_block));
          } else {
            logger.warn('old_block not found in file — skipping write to prevent corruption', { file: step.file_path });
            emitFile(step.file_path, step.change_type, 'failed');
            continue;
          }
        }
      } else if (generated.mode === 'create') {
        finalContent = generated.content;
      } else {
        // mode === 'skip': AI could not determine the change
        logger.warn('AI returned skip — no change applied', { file: step.file_path });
        emitFile(step.file_path, step.change_type, 'failed');
        continue;
      }

      // PHP syntax check — skip write if the generated content has syntax errors
      if (step.file_path.endsWith('.php')) {
        const { validatePhpSyntax } = require('../services/phpValidator');
        const check = await validatePhpSyntax(finalContent);
        if (!check.valid) {
          logger.warn('PHP syntax error in generated code — skipping', { file: step.file_path, output: check.output });
          emitFile(step.file_path, step.change_type, 'failed');
          emit('generating_code', `Syntax error in ${step.file_path} — skipped`);
          continue;
        }
      }

      const gcId = uuidv4();
      await sequelize.query(
        `INSERT INTO generated_code (id, change_request_id, file_path, original_content, generated_content, change_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        { bind: [gcId, requestId, step.file_path, originalContent, finalContent, step.change_type] }
      );

      generatedFiles.push({
        file_path: step.file_path,
        generated_content: finalContent,
        old_block: generated.old_block || '',
        new_block: generated.new_block || finalContent,
        change_type: step.change_type
      });
      emitFile(step.file_path, step.change_type, 'done');
    }

    // Write files to disk so the user can preview the actual result in the iframe
    for (const file of generatedFiles) {
      const absPath = path.join(project.local_path, file.file_path);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, file.generated_content, 'utf-8');
      logger.info('Applied file for preview', { file: file.file_path });
    }

    await projectCache.invalidate(project.id);
    await this._clearViewCache(project.local_path);

    // Store diff data for the accept/reject step
    for (const f of generatedFiles) {
      await sequelize.query(
        'UPDATE generated_code SET diff = $1 WHERE change_request_id = $2 AND file_path = $3',
        { bind: [JSON.stringify({ old_block: f.old_block, new_block: f.new_block }), requestId, f.file_path] }
      );
    }

    await this._updateStatus(requestId, 'pending_review');
    const diffPayload = generatedFiles.map(f => ({
      file_path: f.file_path,
      change_type: f.change_type,
      old_block: f.old_block,
      new_block: f.new_block,
    }));
    emit('pending_review', JSON.stringify({ message: 'Preview ready — accept or reject', diff: diffPayload }));
    logger.info('Full pipeline complete — preview applied, awaiting review', { requestId });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Find the ~80-line window in a file most relevant to the change.
  // Uses DOM context (visible headings/buttons/text) and prompt keywords.
  // Returns { content, startLine, endLine, score } or null (→ send full file).
  // Build a section map from blade file source code (fallback when DOM context unavailable)
  _buildSectionMapFromCode(content) {
    const lines = content.split('\n');
    const sectionMap = [];

    // Find nav blocks
    const navStart = lines.findIndex(l => /<nav[\s>]/i.test(l) || /class="[^"]*nav/i.test(l));
    if (navStart >= 0) {
      const navLinks = [];
      for (let i = navStart; i < Math.min(navStart + 100, lines.length); i++) {
        const m = lines[i].match(/<a[^>]*>([^<]+)<\/a>/);
        if (m) navLinks.push(m[1].trim());
        if (/<\/nav>/i.test(lines[i])) break;
      }
      sectionMap.push({ role: 'navigation', links: navLinks.slice(0, 15), _score: -10 });
    }

    // Find content sections
    for (let i = 0; i < lines.length; i++) {
      const sectionMatch = lines[i].match(/<section[\s>][^>]*(?:class="([^"]*)")?/i);
      if (!sectionMatch) continue;

      const classes = sectionMatch[1] || '';
      const startLine = i + 1;

      // Find ALL headings, images, text within next 150 lines
      const headings = [];
      let headingTag = null;
      const images = [], paragraphs = [], buttons = [];
      const endLine = Math.min(i + 150, lines.length);

      for (let j = i + 1; j < endLine; j++) {
        if (/<\/section>/i.test(lines[j])) break;
        const hm = lines[j].match(/<(h[1-6])[^>]*>([^<]*(?:<[^/][^>]*>[^<]*)*)<\/\1>/i);
        if (hm) {
          const hText = hm[2].replace(/<[^>]*>/g, '').trim();
          if (hText) headings.push(hText);
          if (!headingTag) headingTag = hm[1].toUpperCase();
        }
        const imgm = lines[j].match(/alt="([^"]*)"/);
        if (imgm && images.length < 3) images.push({ alt: imgm[1] });
        const pm = lines[j].match(/<p[^>]*>([^<]{10,})/);
        if (pm && paragraphs.length < 2) paragraphs.push(pm[1].trim().substring(0, 100));
        const bm = lines[j].match(/<(?:a|button)[^>]*class="[^"]*btn[^"]*"[^>]*>([^<]+)/i);
        if (bm && buttons.length < 3) buttons.push(bm[1].trim());
      }

      const heading = headings.join(' | ');
      sectionMap.push({
        role: 'content-section',
        classes: classes.substring(0, 120),
        heading: heading || null,
        headingTag,
        startLine,
        content: paragraphs,
        buttons,
        images,
        _score: 10
      });
    }

    return { sectionMap };
  }

  // Find a <section> block that contains a keyword from the prompt.
  // Returns { content, startLine, endLine, keyword } or null.
  _findSectionByKeyword(content, prompt) {
    if (!content) return null;
    const lines = content.split('\n');

    // Extract meaningful keywords from prompt (2+ word phrases and single words)
    const stop = new Set(['this','that','with','from','have','make','change','update','please','should','would','could','the','and','for','add','image','section','here','now','put','show','text','color','red','blue','green','new','old']);
    const words = prompt.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stop.has(w));

    // Find all section-like blocks and score them
    const sectionStarts = [];
    for (let i = 0; i < lines.length; i++) {
      if (/<section[\s>]/i.test(lines[i]) || /class="[^"]*(?:section|area|block|banner|feature|testimonial|faq|contact|blog)[^"]*"/i.test(lines[i])) {
        sectionStarts.push(i);
      }
    }
    if (sectionStarts.length === 0) return null;

    // For each section, find its end and score by keyword matches
    let bestSection = null;
    let bestScore = 0;
    let bestKeyword = '';

    for (let si = 0; si < sectionStarts.length; si++) {
      const start = sectionStarts[si];
      const end = sectionStarts[si + 1] ? sectionStarts[si + 1] : Math.min(start + 150, lines.length);
      const block = lines.slice(start, end).join('\n').toLowerCase();

      let score = 0;
      let matchedWord = '';
      for (const w of words) {
        const count = (block.match(new RegExp(w, 'gi')) || []).length;
        if (count > 0) {
          // Weight by specificity — longer words and heading matches score higher
          score += count * w.length;
          if (!matchedWord || w.length > matchedWord.length) matchedWord = w;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestSection = { startLine: start, endLine: end };
        bestKeyword = matchedWord;
      }
    }

    if (!bestSection || bestScore < 5) return null;

    // Include 5 lines before for context
    const start = Math.max(0, bestSection.startLine - 5);
    const end = bestSection.endLine;
    return {
      content: lines.slice(start, end).join('\n'),
      startLine: start,
      endLine: end,
      keyword: bestKeyword
    };
  }

  _findRelevantWindow(content, prompt, pageContext) {
    if (!content) return null;
    const lines = content.split('\n');
    if (lines.length <= 120) return null; // small file — send whole thing

    // Collect search terms from DOM visible text
    const terms = [];
    if (pageContext) {
      for (const h of (pageContext.headings || [])) {
        if (h.text && h.text.length > 3) terms.push({ text: h.text.trim(), w: 10 });
      }
      for (const b of (pageContext.buttons || [])) {
        if (b.text && b.text.length > 3) terms.push({ text: b.text.trim(), w: 5 });
      }
      for (const p of (pageContext.paragraphs || [])) {
        if (p && p.length > 10) terms.push({ text: p.substring(0, 80).trim(), w: 3 });
      }
      for (const s of (pageContext.sections || [])) {
        for (const f of (s.fields || [])) {
          if (f.text && f.text.length > 3) terms.push({ text: f.text.trim(), w: 12 });
        }
      }
    }

    // Extract keywords from the prompt
    const stop = new Set(['this','that','with','from','have','make','change','update','please','should','would','could','the','and','for','text']);
    const promptWords = prompt.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stop.has(w));

    let bestLine = -1;
    let bestScore = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineLower = line.toLowerCase();
      let score = 0;

      for (const t of terms) {
        if (line.includes(t.text)) {
          score += t.w * 3; // exact match
        } else {
          const words = t.text.toLowerCase().split(/\s+/);
          for (const w of words) {
            if (w.length > 3 && lineLower.includes(w)) score += t.w;
          }
        }
      }
      for (const w of promptWords) {
        if (lineLower.includes(w)) score += 3;
      }
      if (score > bestScore) { bestScore = score; bestLine = i; }
    }

    if (bestLine === -1 || bestScore < 6) return null; // need strong match, otherwise send full file

    const WINDOW = 40;
    const start = Math.max(0, bestLine - WINDOW);
    const end = Math.min(lines.length, bestLine + WINDOW + 1);

    return {
      content: lines.slice(start, end).join('\n'),
      startLine: start,
      endLine: end,
      bestLine,
      score: bestScore
    };
  }

  async _getAllViews(project) {
    let ctx = await projectCache.get(project.id);
    if (!ctx) {
      ctx = await laravelAnalyzer.analyzeProject(project.local_path);
      await projectCache.set(project.id, ctx);
    }
    return ctx.views || [];
  }

  _clearViewCache(projectPath) {
    return new Promise(resolve => {
      exec('php artisan view:clear', { cwd: projectPath }, (err) => {
        if (err) logger.warn('view:clear failed', { error: err.message });
        resolve();
      });
    });
  }

  async _updateStatus(requestId, newStatus) {
    await sequelize.query(
      'UPDATE change_requests SET status = $1, updated_at = NOW() WHERE id = $2',
      { bind: [newStatus, requestId] }
    );
    logger.info('Status updated', { requestId, status: newStatus });
  }

  // Set status='failed' AND persist the reason so the frontend can display the real error.
  async _fail(requestId, emit, reason) {
    const msg = reason || 'Unknown error';
    try {
      await sequelize.query(
        `UPDATE change_requests SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
        { bind: [msg, requestId] }
      );
    } catch (e) {
      logger.warn('Failed to persist error_message', { error: e.message });
    }
    logger.warn('Change request failed', { requestId, reason: msg });
    if (emit) emit('failed', msg);
  }

  // Fetch the last 8 completed changes for a project — used to build AI change history.
  async _getChangeHistory(projectId) {
    try {
      const [rows] = await sequelize.query(
        `SELECT cr.prompt, cr.created_at, gc.file_path, gc.change_type
         FROM change_requests cr
         JOIN generated_code gc ON gc.change_request_id = cr.id
         WHERE cr.project_id = $1 AND cr.status = 'review'
         ORDER BY cr.created_at DESC
         LIMIT 8`,
        { bind: [projectId] }
      );
      return rows;
    } catch {
      return [];
    }
  }
}

module.exports = new ChangeRequestController();
