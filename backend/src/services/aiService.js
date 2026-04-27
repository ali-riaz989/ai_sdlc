const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');

class AIService {
  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.model = 'claude-sonnet-4-5';
  }

  // ─── Step 1: Fast classifier (<2 s) ────────────────────────────────────────
  async classifyChange(prompt) {
    logger.info('Classifying change', { prompt: prompt.substring(0, 80) });
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 200,
        system: 'You are a classifier. Reply with valid JSON only, no explanation.',
        messages: [{
          role: 'user',
          content: `Classify this change request for a Laravel website:\n"${prompt}"\n\nReply ONLY with JSON:\n{"type":"text_swap"|"structural","target_text":"exact text to find (empty if structural)","new_text":"replacement text (empty if structural)"}`
        }]
      });
      return this._extractJSON(response.content[0].text);
    } catch (error) {
      logger.warn('Classification failed, falling back to structural', { error: error.message });
      return { type: 'structural' };
    }
  }

  // ─── Step 2a: Fast text swap — no code generation ──────────────────────────
  // Returns { found: bool, file: string, content: string }
  async fastTextSwap(fileContent, filePath, targetText, newText) {
    if (!targetText || !fileContent.includes(targetText)) {
      // Target text not found verbatim — ask Claude to locate it in just this file
      logger.info('Target text not found verbatim, asking Claude to locate', { filePath });
      const located = await this._locateAndSwap(fileContent, filePath, targetText, newText);
      return located;
    }
    const updated = fileContent.split(targetText).join(newText);
    return { found: true, content: updated };
  }

  // Fallback: send only the single file + prompt to Claude for targeted replacement
  async _locateAndSwap(fileContent, _filePath, targetText, newText) {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: fileContent.length + 500,
        system: 'You are a Laravel file editor. Return ONLY the modified file content, no markdown, no explanation.',
        messages: [{
          role: 'user',
          content: `In this file, replace "${targetText}" with "${newText}".\n\nFile content:\n${fileContent}`
        }]
      });
      return { found: true, content: this._extractCode(response.content[0].text) };
    } catch (error) {
      return { found: false, content: fileContent };
    }
  }


  // ─── Execute edit — old_block/new_block like Claude Code ────────────────
  // AI receives the RAW SOURCE CODE of the section and returns exact text replacement
  async executeEdit(prompt, sectionContent, filePath, imageData = null, savedImageUrl = null, language = 'blade', conversation = null) {
    logger.info('Executing edit', { file: filePath, language, hasConversation: !!(conversation?.length) });

    let editInstruction = prompt;
    if (savedImageUrl) {
      const assetPath = `{{ asset('${savedImageUrl.substring(1)}') }}`;
      editInstruction += `\n\nThe user uploaded an image saved at: ${savedImageUrl}\nFor image src use exactly: ${assetPath}`;
    }

    // Thread full chat history so the AI can interpret corrections and follow-ups
    let conversationNote = '';
    if (conversation?.length) {
      conversationNote = '\n\nPREVIOUS CONVERSATION (earlier → later; use to resolve references like "change it to", "make that bigger"):\n' +
        conversation.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.text}`).join('\n') + '\n';
    }

    const languageDesc = language === 'css'
      ? { name: 'CSS', sourceDesc: 'RAW CSS source (selectors, declarations, media queries)', extras: '- Preserve selector syntax exactly (. # : pseudo-classes, nesting)\n- Keep units, !important, vendor prefixes intact' }
      : { name: 'Laravel Blade', sourceDesc: 'RAW SOURCE CODE (Blade PHP) — NOT rendered HTML. This includes @include, @foreach, {{ }}, and other Blade directives', extras: '- Do NOT convert Blade syntax to plain HTML' };

    const systemPrompt = `You are a code editor like Claude Code or Cursor. You edit ${languageDesc.name} source files.

You receive a section of ${languageDesc.sourceDesc}.

Your job: find the exact lines to change and return a precise find-and-replace.

THINKING PROCESS:
1. UNDERSTAND what the user wants to change
2. FIND the exact lines in the source code that need changing
3. COPY those lines EXACTLY as they appear (character-for-character, including whitespace and syntax)
4. WRITE the replacement with ONLY the requested change

OUTPUT: Return ONLY valid JSON:
{"old_block":"exact verbatim lines from the source code","new_block":"the replacement lines","reasoning":"what was changed"}

CRITICAL RULES:
- old_block must be COPIED character-for-character from the provided source — including spaces, tabs, newlines, syntax
- Include 1-2 surrounding lines in old_block so it matches uniquely
- new_block changes ONLY what the user asked — everything else stays identical
- Do NOT invent code that isn't in the source
${languageDesc.extras}
- If the text contains special characters like smart quotes, copy them exactly
- If ambiguous: {"error":"Need more specific instruction"}`;

    const textBlock = {
      type: 'text',
      text: `USER REQUEST: "${editInstruction}"${conversationNote}

SOURCE CODE of the section (this is raw ${languageDesc.name}):
${sectionContent}

Return ONLY valid JSON: {"old_block":"...","new_block":"...","reasoning":"..."}`
    };

    const userContent = imageData
      ? [{ type: 'image', source: { type: 'base64', media_type: imageData.mediaType, data: imageData.base64 } }, textBlock]
      : [textBlock];

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      });
      let result;
      try {
        result = this._extractJSON(response.content[0].text);
      } catch (jsonErr) {
        logger.warn('AI returned invalid JSON in executeEdit', { response: response.content[0].text.substring(0, 500) });
        return { mode: 'skip' };
      }

      if (result?.error) {
        logger.warn('AI reported ambiguity', { error: result.error });
        return { mode: 'skip', reason: result.error };
      }

      if (result?.old_block !== undefined && result?.new_block !== undefined) {
        logger.info('Edit ready', { reasoning: result.reasoning, old_preview: result.old_block.substring(0, 80) });
        return { mode: 'replace', old_block: result.old_block, new_block: result.new_block, reasoning: result.reasoning };
      }

      logger.warn('AI returned unexpected shape', { keys: Object.keys(result || {}) });
      return { mode: 'skip' };
    } catch (error) {
      logger.error('Edit execution failed', { error: error.message });
      const reason = error.message?.includes('rate_limit') || error.message?.includes('429')
        ? 'Rate limit reached — wait a moment and try again'
        : error.message?.includes('Connection')
        ? 'API connection error — try again in a moment'
        : 'AI service error: ' + (error.message || 'unknown');
      return { mode: 'skip', reason };
    }
  }

  // ─── Claude-Code-style edit: AI picks which file to edit from multiple candidates ───
  // candidates: [{ path, content, type }]  (e.g. blade, css, js)
  // Returns { mode: 'replace', file_path, old_block, new_block, reasoning } or { mode: 'skip', reason }
  async executeEditMulti({ prompt, selectedElement, candidates, conversation = null, imageData = null, savedImageUrl = null }) {
    logger.info('Multi-file edit', { candidates: candidates.map(c => `${c.path} (${c.type})`), hasConversation: !!(conversation?.length) });

    let editInstruction = prompt;
    if (savedImageUrl) {
      const assetPath = `{{ asset('${savedImageUrl.substring(1)}') }}`;
      editInstruction += `\n\nThe user uploaded an image saved at: ${savedImageUrl}\nFor image src use exactly: ${assetPath}`;
    }
    let conversationNote = '';
    if (conversation?.length) {
      conversationNote = '\n\nPREVIOUS CONVERSATION (earlier → later; use to resolve references):\n' +
        conversation.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.text}`).join('\n') + '\n';
    }

    const clickAnchor = candidates.find(c => c.clickAnchor)?.clickAnchor;
    const elInfo = selectedElement ? `
SELECTED ELEMENT (what the user clicked):
- tag: <${selectedElement.tag || '?'}>
- classes: "${selectedElement.classes || ''}"
- heading/section: "${selectedElement.section || ''}"
- inner text (preview): "${(selectedElement.text || '').substring(0, 100)}"
- is image: ${selectedElement.isImage ? 'yes' : 'no'}${clickAnchor ? `
- click-landed on this exact line in the blade file: ${JSON.stringify(clickAnchor.substring(0, 160))}` : ''}` : '';

    const filesBlock = candidates.map(c =>
      `\n===== FILE: ${c.path}  [type: ${c.type}] =====\n${c.content}\n===== END FILE: ${c.path} =====\n`
    ).join('\n');

    const systemPrompt = `You are a code editor, like Claude Code or Cursor, operating on a website codebase.

You receive:
- Metadata about the element the user clicked in the browser
- The user's request (and prior chat history)
- One or more CANDIDATE FILES (Blade PHP, CSS, JS, etc.). For blade files you usually receive the FULL file so you can work across sections if the request requires it.

FIRST: figure out what the user is actually asking for. Examples of intents:
- "change text / color / style / size" → in-place edit of the element or its CSS rule
- "move / shift / relocate / reorder / swap / place X above-or-below Y" → structural MOVE of a block of markup within the blade file
- "add a new section / append X / create Y" → additive edit (new content)
- "replace this image" → image src swap in the blade
- "delete / remove X" → removal edit

The user will NOT always spell the intent out literally. Infer it from the phrasing and from the SELECTED ELEMENT context. Do NOT keyword-match — understand the request.

Then pick ONE of these two output shapes, whichever fits the request. Return ONLY valid JSON.

OUTPUT SHAPE A — in-place find-and-replace (default for edits, additions, image swaps, deletions):
{"file_path":"<exact path from a FILE header>","old_block":"<exact verbatim lines from that file>","new_block":"<replacement lines>","reasoning":"<short>"}

OUTPUT SHAPE B — structural move (use ONLY when the user wants to relocate a block of markup):
{"file_path":"<exact path from a FILE header>","move":{"source_start":"<verbatim first line of the block to MOVE>","source_end":"<verbatim last line of the block to MOVE>","insert_before":"<verbatim first line of where the block should land>"},"reasoning":"<short>"}

OUTPUT SHAPE C — error / no-op:
{"error":"<why>"}

DECISION RULES (when to pick which file):
- Styling/visual changes (color, spacing, size, layout): prefer the CSS file that defines the clicked element's class rule.
- Text, content, structure, image, move, add, delete: edit the Blade template.
- Behavior/interaction: edit a JS file.
- Only pick from files provided in CANDIDATE FILES headers.

SHAPE A RULES (old_block / new_block):
- old_block is copied character-for-character from the chosen file (whitespace, quotes, Blade directives, CSS syntax — all verbatim).
- Include 1-2 surrounding lines so the match is unique.
- new_block changes ONLY what the user asked for.
- Do NOT invent code not present in the files.
- ADDING NEW CONTENT: find a nearby existing block; put those lines in old_block EXACTLY; put those same lines PLUS your new content in new_block.
- If truly appending to the very end: old_block = last 2–5 non-empty lines verbatim; new_block = those same lines followed by your new content.

SHAPE B RULES (move op):
- source_start, source_end, insert_before are EACH a SINGLE line copied character-for-character from the file.
- Each must be unique enough to identify the position — prefer opening <section class="..."> tags, HTML comment markers, or other lines that appear exactly once. Avoid generic lines like "</div>".
- source_start and source_end bracket the block to relocate (inclusive on both ends).
- insert_before is the first line of the destination; the moved block is placed IMMEDIATELY BEFORE that line.
- "move X below Y" / "after Y" → set insert_before to the line AFTER Y's closing tag (usually the next section's opening tag).
- If the block is already in the requested position: {"error":"already in that position"}.
- NEVER fake a move with a comment like "<!-- MOVED -->" — the backend verifies anchors and will reject.

AMBIGUITY: If the request is unclear or you can't identify the target, return {"error":"<why>"}.`;

    const textBlock = {
      type: 'text',
      text: `USER REQUEST: "${editInstruction}"${conversationNote}
${elInfo}

CANDIDATE FILES:${filesBlock}

Return ONLY valid JSON: {"file_path":"...","old_block":"...","new_block":"...","reasoning":"..."}`
    };

    const userContent = imageData
      ? [{ type: 'image', source: { type: 'base64', media_type: imageData.mediaType, data: imageData.base64 } }, textBlock]
      : [textBlock];

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      });
      let result;
      try { result = this._extractJSON(response.content[0].text); }
      catch { logger.warn('AI returned invalid JSON in executeEditMulti'); return { mode: 'skip' }; }

      if (result?.error) return { mode: 'skip', reason: result.error };

      // Infer file_path if Claude forgot to include it: look for a candidate whose content
      // contains the old_block (or the move anchors) verbatim.
      const inferFilePath = (needle) => {
        if (!needle) return null;
        const hits = candidates.filter(c => c.content && c.content.includes(needle));
        if (hits.length === 1) return hits[0].path;
        return null;
      };

      if (result?.move?.source_start && result?.move?.source_end && result?.move?.insert_before) {
        const filePath = result.file_path || inferFilePath(result.move.source_start) || inferFilePath(result.move.insert_before);
        if (!filePath) {
          logger.warn('Move anchors not unique to any candidate', { source_start: result.move.source_start?.substring(0, 60) });
          return { mode: 'skip', reason: 'Could not determine which file to move within' };
        }
        logger.info('Structural move ready', { file: filePath, inferred: !result.file_path, reasoning: result.reasoning });
        return { mode: 'move', file_path: filePath, ...result.move, reasoning: result.reasoning };
      }
      if (result?.old_block !== undefined && result?.new_block !== undefined) {
        const filePath = result.file_path || inferFilePath(result.old_block);
        if (!filePath) {
          logger.warn('old_block not unique to any candidate — Claude must specify file_path', { old_preview: (result.old_block || '').substring(0, 80) });
          return { mode: 'skip', reason: 'AI edit did not specify which file, and the target text appears in multiple files' };
        }
        logger.info('Multi-file edit ready', { file: filePath, inferred: !result.file_path, reasoning: result.reasoning });
        return { mode: 'replace', file_path: filePath, old_block: result.old_block, new_block: result.new_block, reasoning: result.reasoning };
      }
      logger.warn('AI returned unexpected shape in executeEditMulti', { keys: Object.keys(result || {}) });
      return { mode: 'skip' };
    } catch (error) {
      logger.error('Multi-file edit failed', { error: error.message });
      const reason = error.message?.includes('rate_limit') || error.message?.includes('429')
        ? 'Rate limit reached — wait a moment and try again'
        : error.message?.includes('Connection')
        ? 'API connection error — try again in a moment'
        : 'AI service error: ' + (error.message || 'unknown');
      return { mode: 'skip', reason };
    }
  }

  // ─── Step 2b: Scoped page analysis — only one blade file sent ─────────────
  // Returns { result, messages } — messages threads into the generate step.
  async analyzePageChange(prompt, bladeFilePath, bladeContent, imageData = null, changeHistory = '', relatedFiles = []) {
    logger.info('Analyzing scoped page change', { file: bladeFilePath });

    const truncated = bladeContent.length > 12000
      ? bladeContent.substring(0, 12000) + '\n<!-- file truncated -->'
      : bladeContent;

    const historyNote = changeHistory
      ? `\n\nRecent changes to this project:\n${changeHistory}`
      : '';

    const relatedNote = relatedFiles.length > 0
      ? '\n\nRelated files (read-only context):\n' + relatedFiles.map(f => `\n--- ${f.relative_path} ---\n${f.content}`).join('\n')
      : '';

    const textBlock = {
      type: 'text',
      text: `You are editing a Laravel blade file.${historyNote}\n\nFile: ${bladeFilePath}\n\nCurrent content:\n${truncated}${relatedNote}\n\nChange request: "${prompt}"\n\nRespond ONLY with JSON:\n{"understanding":"what will change","complexity":1,"risk_level":"low","files_affected":["${bladeFilePath}"],"implementation_plan":[{"step":1,"description":"what to do","file_path":"${bladeFilePath}","change_type":"modify","details":"specific changes"}]}`
    };

    const userContent = imageData
      ? [{ type: 'image', source: { type: 'base64', media_type: imageData.mediaType, data: imageData.base64 } }, textBlock]
      : [textBlock];

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 800,
      system: 'You are an expert Laravel developer. Analyze the change request for the given blade file only. Respond ONLY with valid JSON.',
      messages: [{ role: 'user', content: userContent }]
    });

    const result = this._extractJSON(response.content[0].text);

    // Capture this turn so it can be threaded into generateCode
    const messages = [
      { role: 'user', content: userContent },
      { role: 'assistant', content: response.content[0].text }
    ];

    return { result, messages };
  }

  // ─── Step 3: Full pipeline — analyze then generate ─────────────────────────
  // Returns { result, messages } — messages threads into the generate step.
  async analyzeChangeRequest(prompt, projectContext, category, imageData = null, changeHistory = '') {
    logger.info('Starting AI analysis', { category, hasImage: !!imageData });

    const systemPrompt = this._buildAnalysisSystemPrompt(projectContext, changeHistory);

    const textBlock = {
      type: 'text',
      text: `Analyze this ${category} change request for a Laravel application:\n\n${prompt}\n\nRespond with a JSON object containing:
{
  "understanding": "Brief summary of what needs to be done",
  "complexity": 1,
  "risk_level": "low",
  "change_type": "content",
  "files_affected": ["path/to/file1.blade.php"],
  "implementation_plan": [
    {
      "step": 1,
      "description": "What to do",
      "file_path": "path/to/file.blade.php",
      "change_type": "modify",
      "details": "Specific changes needed"
    }
  ],
  "can_instant_preview": true,
  "requires_staging": false,
  "estimated_time_minutes": 5
}`
    };

    const userContent = imageData
      ? [{ type: 'image', source: { type: 'base64', media_type: imageData.mediaType, data: imageData.base64 } }, textBlock]
      : [textBlock];

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      });

      const result = this._extractJSON(response.content[0].text);
      logger.info('AI analysis completed', { complexity: result.complexity, risk: result.risk_level });

      const messages = [
        { role: 'user', content: userContent },
        { role: 'assistant', content: response.content[0].text }
      ];

      return { result, messages };
    } catch (error) {
      logger.error('AI analysis failed', { error: error.message });
      throw new Error(`AI analysis failed: ${error.message}`);
    }
  }

  // Generate a surgical block replacement for a file.
  // Returns { mode: 'replace', old_block, new_block } for existing files,
  //         { mode: 'create', content } for new files,
  //      or { mode: 'skip' } if the AI couldn't determine the change.
  //
  // priorMessages: conversation thread from the preceding analyze call.
  // When provided, the AI already knows the plan — we only send the full file
  // in the new user turn, saving tokens on re-explaining the change.
  async generateCode(fileInfo, originalContent = null, priorMessages = [], onToken = null, pageContext = null, imageData = null) {
    logger.info('Generating code', { file: fileInfo.file_path, threaded: priorMessages.length > 0 });

    const systemPrompt = `You are an AI code editor making precise surgical edits to a Laravel Blade file.

RESPONSE: Return ONLY valid JSON — no markdown, no explanation.
{"old_block":"exact verbatim text from the file","new_block":"replacement text"}

HOW TO FIND THE RIGHT ELEMENT:
1. You will receive a PAGE STRUCTURE MAP showing every section on the page with its role (navigation, content-section, footer).
2. You will receive the FILE with line numbers.
3. FIRST identify which section (by role + heading) the user is referring to.
4. THEN find that section's code in the file by matching the heading text and class names.
5. Edit ONLY within that section.

DISAMBIGUATION — if the same text appears in multiple places:
- PREFER content sections (section, article, main) over navigation (nav, header, menu)
- PREFER elements with headings (h1-h4) over link lists
- PREFER larger containers over inline elements
- NEVER edit navigation menus unless the user explicitly says "nav", "menu", or "navigation"

old_block RULES:
- Must be character-for-character identical to text in the file (NO line numbers)
- Include 2-4 surrounding lines for uniqueness
- new_block changes ONLY what was asked — preserve everything else`;

    // Build structured DOM context
    let domNote = '';
    if (pageContext?.sectionMap?.length) {
      const sections = pageContext.sectionMap.map((s, i) => {
        let desc = `[${i + 1}] role=${s.role}`;
        if (s.id) desc += ` id="${s.id}"`;
        if (s.classes) desc += ` class="${s.classes.substring(0, 80)}"`;
        if (s.heading) desc += `\n    heading: "${s.heading}"`;
        if (s.content?.length) desc += `\n    text: ${s.content.map(p => `"${p.substring(0, 80)}"`).join(', ')}`;
        if (s.buttons?.length) desc += `\n    buttons: ${s.buttons.join(', ')}`;
        if (s.images?.length) desc += `\n    images: ${s.images.map(img => img.alt || 'no-alt').join(', ')}`;
        if (s.links?.length) desc += `\n    links: ${s.links.slice(0, 10).join(', ')}`;
        return desc;
      }).join('\n');
      domNote = `\n\nPAGE STRUCTURE MAP (use this to identify the correct section):\n${sections}`;
    }

    if (originalContent) {
      const numberedContent = originalContent.split('\n').map((line, i) => `${i + 1}| ${line}`).join('\n');

      const textPrompt = `User request: "${fileInfo.description}"${domNote}

File: ${fileInfo.file_path}
${numberedContent}

Return ONLY the JSON edit. old_block must NOT include line numbers:
{"old_block":"verbatim raw text from file","new_block":"replacement"}`;

      // Build user content — include image if provided
      const generateUserPrompt = imageData
        ? [
            { type: 'image', source: { type: 'base64', media_type: imageData.mediaType, data: imageData.base64 } },
            { type: 'text', text: textPrompt }
          ]
        : textPrompt;

      const messages = [
        ...priorMessages,
        { role: 'user', content: generateUserPrompt }
      ];

      try {
        // For image requests: use non-streaming create() — stream() can hang with images
        if (imageData) {
          logger.info('Using non-streaming API for image request');
          const response = await this.client.messages.create({
            model: this.model,
            max_tokens: 4096,
            system: systemPrompt,
            messages
          });
          let result;
          try { result = this._extractJSON(response.content[0].text); } catch {
            logger.warn('AI response not valid JSON (image)', { response: response.content[0].text.substring(0, 300) });
            return { mode: 'skip' };
          }
          if (result?.old_block !== undefined && result?.new_block !== undefined) {
            return { mode: 'replace', old_block: result.old_block, new_block: result.new_block };
          }
          return { mode: 'skip' };
        }

        if (onToken) {
          let accumulated = '';
          const stream = this.client.messages.stream({
            model: this.model,
            max_tokens: 4096,
            system: systemPrompt,
            messages
          });
          stream.on('text', chunk => {
            accumulated += chunk;
            onToken(chunk);
          });
          await stream.finalMessage();
          let result;
          try {
            result = this._extractJSON(accumulated);
          } catch (jsonErr) {
            logger.warn('AI response not valid JSON', { file: fileInfo.file_path, response: accumulated.substring(0, 500) });
            return { mode: 'skip' };
          }
          if (result?.old_block !== undefined && result?.new_block !== undefined) {
            logger.info('Surgical block generated (streamed)', { file: fileInfo.file_path });
            return { mode: 'replace', old_block: result.old_block, new_block: result.new_block };
          }
          logger.warn('AI returned unexpected JSON shape, skipping', { file: fileInfo.file_path, keys: Object.keys(result || {}), response: accumulated.substring(0, 300) });
          return { mode: 'skip' };
        } else {
          const response = await this.client.messages.create({
            model: this.model,
            max_tokens: 4096,
            system: systemPrompt,
            messages
          });

          const result = this._extractJSON(response.content[0].text);
          if (result?.old_block !== undefined && result?.new_block !== undefined) {
            logger.info('Surgical block generated', { file: fileInfo.file_path, threaded: priorMessages.length > 0 });
            return { mode: 'replace', old_block: result.old_block, new_block: result.new_block };
          }
          logger.warn('AI returned unexpected JSON shape, skipping', { file: fileInfo.file_path });
          return { mode: 'skip' };
        }
      } catch (error) {
        logger.error('Code generation failed', { file: fileInfo.file_path, error: error.message });
        throw new Error(`Code generation failed: ${error.message}`);
      }
    } else {
      // ── New file creation: return raw content ────────────────────────────
      const newFileSystemPrompt = `You are an expert Laravel developer. Generate clean, secure, production-ready code.
Return ONLY the file content — no markdown fences, no explanations.`;

      const userPrompt = `File: ${fileInfo.file_path}
Change: ${fileInfo.description}
Details: ${fileInfo.details}

Create this new file.`;

      try {
        if (onToken) {
          let accumulated = '';
          const stream = this.client.messages.stream({
            model: this.model,
            max_tokens: 4096,
            system: newFileSystemPrompt,
            messages: [...priorMessages, { role: 'user', content: userPrompt }]
          });
          stream.on('text', chunk => {
            accumulated += chunk;
            onToken(chunk);
          });
          await stream.finalMessage();
          const content = this._extractCode(accumulated);
          logger.info('New file generated (streamed)', { file: fileInfo.file_path, bytes: content.length });
          return { mode: 'create', content };
        } else {
          const response = await this.client.messages.create({
            model: this.model,
            max_tokens: 4096,
            system: newFileSystemPrompt,
            messages: [...priorMessages, { role: 'user', content: userPrompt }]
          });

          const content = this._extractCode(response.content[0].text);
          logger.info('New file generated', { file: fileInfo.file_path, bytes: content.length });
          return { mode: 'create', content };
        }
      } catch (error) {
        logger.error('Code generation failed', { file: fileInfo.file_path, error: error.message });
        throw new Error(`Code generation failed: ${error.message}`);
      }
    }
  }

  // ─── Build compact change history string for system prompts ────────────────
  // recentChanges: [{ prompt, file_path, change_type, created_at }]
  buildChangeHistory(recentChanges) {
    if (!recentChanges || recentChanges.length === 0) return '';
    return recentChanges
      .map((c, i) => {
        const date = new Date(c.created_at).toLocaleDateString();
        return `${i + 1}. [${date}] ${c.change_type} "${c.file_path}" — ${c.prompt.substring(0, 120)}`;
      })
      .join('\n');
  }

  _buildAnalysisSystemPrompt(projectContext, changeHistory = '') {
    // Send only view list and routes — not full file contents — to keep tokens low
    const slim = {
      views: (projectContext.views || []).map(v => v.relative_path),
      routes: (projectContext.routes || []).map(r => r.file),
    };
    const historyNote = changeHistory
      ? `\n\nRecent changes to this project (use this to understand current state):\n${changeHistory}`
      : '';
    return `You are an expert Laravel developer analyzing change requests.

Project views:\n${slim.views.join('\n')}\n\nProject routes:\n${slim.routes.join('\n')}${historyNote}

Respond ONLY with valid JSON. If a screenshot is provided, use it to understand the visual context.`;
  }

  _extractJSON(text) {
    // Strip markdown fences and any text before/after JSON
    let cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    // Find the outermost JSON object
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in AI response');

    let jsonStr = match[0];

    // Try parsing directly first
    try { return JSON.parse(jsonStr); } catch {}

    // Fix common issues: literal newlines inside string values
    // Replace actual newlines inside JSON strings with \\n
    jsonStr = jsonStr.replace(/:\s*"((?:[^"\\]|\\.)*)"/g, (match) => {
      return match.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
    });
    try { return JSON.parse(jsonStr); } catch {}

    // Last resort: try to extract old_block and new_block with regex
    const oldMatch = jsonStr.match(/"old_block"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
    const newMatch = jsonStr.match(/"new_block"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
    if (oldMatch && newMatch) {
      return {
        old_block: oldMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
        new_block: newMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      };
    }

    throw new Error('Could not parse JSON from AI response');
  }

  _extractCode(text) {
    return text.replace(/^```[\w]*\n?/gm, '').replace(/^```\s*$/gm, '').trim();
  }
}

module.exports = new AIService();
