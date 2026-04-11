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
      const { project_id, title, prompt, category, image_base64, image_media_type, current_page_url, page_context } = req.body;
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

      this._processChangeRequest(requestId, project, req.app.get('io'), imageData, current_page_url, page_context).catch(error => {
        console.error('PROCESS ERROR FULL STACK:', error);
        logger.error('Processing failed', { error: error.message, stack: error.stack, requestId });
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
      const result = requests[0];
      result.staging = stagingEnvs[0] || null;
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
  async _processChangeRequest(requestId, project, io, imageData = null, currentPageUrl = null, pageContext = null) {
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

      // ── Resolve current page → blade file (always, even with images) ────────
      let pageBladeFile = null;
      if (currentPageUrl) {
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
          }
        }
      }

      // When the blade file is resolved → always use directGenerate (1 API call).
      // This ensures the AI edits the CORRECT file (the one the user is looking at).
      if (pageBladeFile) {
        await this._directGenerate(requestId, project, changeRequest, pageBladeFile, emit, emitFile, io, pageContext, imageData);
      } else {
        // No page resolved (no URL sent) — fall back to full pipeline
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
      logger.error('Change request processing failed', { requestId, error: error.message });
      await this._updateStatus(requestId, 'failed');
      emit('failed', `Processing failed: ${error.message}`);
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

  // ── Direct generate: 1 API call, no classify/analyze overhead ──────────────
  // Used when blade file is already resolved from the URL — the common case.
  async _directGenerate(requestId, project, changeRequest, pageBladeFile, emit, emitFile, io, pageContext = null, imageData = null) {
    await this._updateStatus(requestId, 'generating_code');
    emit('generating_code', 'Generating change…');
    logger.info('directGenerate', { file: pageBladeFile.blade_file, hasPageContext: !!pageContext, hasSectionMap: !!pageContext?.sectionMap?.length, hasImage: !!imageData });

    const absPath = path.join(project.local_path, pageBladeFile.blade_file);
    let originalContent = null;
    try { originalContent = await fs.readFile(absPath, 'utf-8'); } catch {}

    // If no DOM context from frontend (cross-origin iframe), build section map from the blade file
    if ((!pageContext || !pageContext.sectionMap?.length) && originalContent) {
      pageContext = this._buildSectionMapFromCode(originalContent);
      logger.info('Built section map from code', { sections: pageContext.sectionMap.length });
    }

    // If user uploaded an image, save it to project's public/images/ and get the asset URL
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

    emitFile(pageBladeFile.blade_file, 'modify', 'generating');

    const onToken = (chunk) => {
      if (io) io.to(`cr-${requestId}`).emit(`change-request:${requestId}:token`, { token: chunk });
    };

    // For image requests on large files: use the section map to extract the right block
    let contentForAI = originalContent;
    if (imageData && originalContent && originalContent.length > 30000 && pageContext?.sectionMap?.length) {
      const lines = originalContent.split('\n');
      const prompt = changeRequest.prompt.toLowerCase();

      // Find the content section whose heading best matches the prompt
      const contentSections = pageContext.sectionMap.filter(s => s.role === 'content-section' && s.startLine);
      let bestSection = null;
      let bestScore = 0;

      for (const s of contentSections) {
        let score = 0;
        const heading = (s.heading || '').toLowerCase();
        const classes = (s.classes || '').toLowerCase();
        // Check if any word from heading appears in prompt
        heading.split(/\s+/).forEach(w => { if (w.length > 2 && prompt.includes(w)) score += 10; });
        classes.split(/[\s-]+/).forEach(w => { if (w.length > 2 && prompt.includes(w)) score += 3; });
        if (score > bestScore) { bestScore = score; bestSection = s; }
      }

      if (bestSection && bestScore >= 10) {
        // Extract from this section's start line to the next section (or +100 lines)
        const startIdx = bestSection.startLine - 1;
        const nextSection = contentSections.find(s => s.startLine > bestSection.startLine);
        const endIdx = nextSection ? nextSection.startLine - 1 : Math.min(startIdx + 100, lines.length);
        contentForAI = lines.slice(Math.max(0, startIdx - 3), endIdx).join('\n');
        logger.info('Image request: matched section by heading', { heading: bestSection.heading, lines: `${startIdx}-${endIdx}`, score: bestScore });
      } else {
        contentForAI = originalContent.substring(0, 30000) + '\n<!-- file truncated -->';
        logger.info('Image request: no heading match, truncated', { file: pageBladeFile.blade_file });
      }
    }

    // If image was saved, append the real URL to the prompt so the AI uses it
    let promptWithImage = changeRequest.prompt;
    if (savedImageUrl) {
      promptWithImage += `\n\nThe uploaded image has been saved to: ${savedImageUrl}\nUse this exact path in the code: {{ asset('${savedImageUrl.substring(1)}') }}`;
    }

    const step = { file_path: pageBladeFile.blade_file, change_type: 'modify', description: promptWithImage, details: promptWithImage };
    const generated = await aiService.generateCode(step, contentForAI, [], onToken, pageContext, imageData);

    let finalContent;
    if (generated.mode === 'replace') {
      // Strip line numbers if the AI accidentally included them (e.g. "42| <h1>")
      let oldBlock = generated.old_block;
      let newBlock = generated.new_block;
      if (/^\d+\|\s/.test(oldBlock)) {
        oldBlock = oldBlock.split('\n').map(l => l.replace(/^\d+\|\s?/, '')).join('\n');
        newBlock = newBlock.split('\n').map(l => l.replace(/^\d+\|\s?/, '')).join('\n');
        logger.info('Stripped line numbers from AI response');
      }

      const found = originalContent && originalContent.includes(oldBlock);
      if (found) {
        finalContent = originalContent.split(oldBlock).join(newBlock);
      } else if (originalContent) {
        // Try normalizing line endings
        const norm = s => s.replace(/\r\n/g, '\n');
        const normContent = norm(originalContent);
        const normOld = norm(oldBlock);
        if (normContent.includes(normOld)) {
          finalContent = normContent.split(normOld).join(norm(newBlock));
        } else {
          // Try trimming trailing whitespace per line
          const trimLines = s => s.split('\n').map(l => l.trimEnd()).join('\n');
          if (trimLines(normContent).includes(trimLines(normOld))) {
            finalContent = trimLines(normContent).split(trimLines(normOld)).join(trimLines(norm(newBlock)));
          } else {
            logger.warn('old_block not found — skipping', { file: step.file_path, old_block_preview: oldBlock.substring(0, 200) });
            emitFile(step.file_path, 'modify', 'failed');
            await this._updateStatus(requestId, 'failed');
            emit('failed', 'AI generated a change that could not be located in the file');
            return;
          }
        }
      }
    } else if (generated.mode === 'create') {
      finalContent = generated.content;
    } else {
      logger.warn('AI returned skip', { file: step.file_path });
      emitFile(step.file_path, 'modify', 'failed');
      await this._updateStatus(requestId, 'failed');
      emit('failed', 'AI could not determine the change');
      return;
    }

    // PHP syntax check
    if (step.file_path.endsWith('.php')) {
      const { validatePhpSyntax } = require('../services/phpValidator');
      const check = await validatePhpSyntax(finalContent);
      if (!check.valid) {
        logger.warn('PHP syntax error', { file: step.file_path, output: check.output });
        emitFile(step.file_path, 'modify', 'failed');
        await this._updateStatus(requestId, 'failed');
        emit('failed', 'Generated code has syntax errors');
        return;
      }
    }

    // Store in DB
    const gcId = uuidv4();
    await sequelize.query(
      `INSERT INTO generated_code (id, change_request_id, file_path, original_content, generated_content, change_type, diff)
       VALUES ($1, $2, $3, $4, $5, 'modify', $6)`,
      { bind: [gcId, requestId, step.file_path, originalContent, finalContent, JSON.stringify({ old_block: generated.old_block || '', new_block: generated.new_block || '' })] }
    );

    emitFile(step.file_path, 'modify', 'done');

    // Write to disk for live preview
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, finalContent, 'utf-8');
    logger.info('Applied file for preview', { file: step.file_path });

    await projectCache.invalidate(project.id);
    await this._clearViewCache(project.local_path);

    // Enter pending_review — user sees live preview and clicks Accept/Reject
    await this._updateStatus(requestId, 'pending_review');
    const diffPayload = [{ file_path: step.file_path, change_type: 'modify', old_block: generated.old_block || '', new_block: generated.new_block || '' }];
    emit('pending_review', JSON.stringify({ message: 'Preview ready — accept or reject', diff: diffPayload }));
    logger.info('Direct generate complete', { requestId });
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

      // Find heading, images, text within next 80 lines
      let heading = null, headingTag = null;
      const images = [], paragraphs = [], buttons = [];
      const endLine = Math.min(i + 80, lines.length);

      for (let j = i + 1; j < endLine; j++) {
        if (/<\/section>/i.test(lines[j])) break;
        if (!heading) {
          const hm = lines[j].match(/<(h[1-4])[^>]*>([^<]*(?:<[^/][^>]*>[^<]*)*)<\/\1>/i);
          if (hm) { headingTag = hm[1].toUpperCase(); heading = hm[2].replace(/<[^>]*>/g, '').trim(); }
        }
        const imgm = lines[j].match(/alt="([^"]*)"/);
        if (imgm && images.length < 3) images.push({ alt: imgm[1] });
        const pm = lines[j].match(/<p[^>]*>([^<]{10,})/);
        if (pm && paragraphs.length < 2) paragraphs.push(pm[1].trim().substring(0, 100));
        const bm = lines[j].match(/<(?:a|button)[^>]*class="[^"]*btn[^"]*"[^>]*>([^<]+)/i);
        if (bm && buttons.length < 3) buttons.push(bm[1].trim());
      }

      sectionMap.push({
        role: 'content-section',
        classes: classes.substring(0, 120),
        heading,
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
