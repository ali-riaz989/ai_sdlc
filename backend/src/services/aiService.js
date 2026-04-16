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

  // ─── PHASE 1: Identify target section using structured DOM + file ────────
  // AI thinks through: understand → locate → validate
  // Returns { target_section, line_start, line_end, reasoning, confidence }
  async identifySection(prompt, structuredSections, fileContent, filePath, imageData = null, conversation = null) {
    logger.info('Phase 1: Identifying section', { prompt: prompt.substring(0, 80), hasConversation: !!(conversation?.length) });

    const numberedContent = fileContent.split('\n').map((line, i) => `${i + 1}| ${line}`).join('\n');

    // Build conversation context so AI understands corrections
    let conversationNote = '';
    if (conversation?.length) {
      conversationNote = '\n\nPREVIOUS CONVERSATION (use this to understand corrections):\n' +
        conversation.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.text}`).join('\n') + '\n';
    }

    const textBlock = {
      type: 'text',
      text: `USER REQUEST: "${prompt}"${conversationNote}

PAGE STRUCTURE (each section with its role and content):
${JSON.stringify(structuredSections, null, 2)}

FILE (with line numbers):
${numberedContent}

Follow this thinking process:
UNDERSTAND: What does the user want to change? If there is a PREVIOUS CONVERSATION, the user may be correcting a previous attempt — pay attention to what they said was wrong.
LOCATE: Which section from the PAGE STRUCTURE matches? Use context and meaning, not just keywords.
VALIDATE: Is this the ONLY correct match? If multiple sections match, pick the content section (not navigation).

Return ONLY valid JSON:
{
  "target_section": "heading or description of the matched section",
  "line_start": 100,
  "line_end": 150,
  "reasoning": "why this section matches the user's request",
  "confidence": "high|medium|low"
}`
    };

    const userContent = imageData
      ? [{ type: 'image', source: { type: 'base64', media_type: imageData.mediaType, data: imageData.base64 } }, textBlock]
      : [textBlock];

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 500,
        system: `You are an intelligent section identifier. Your job is to find which section of a webpage the user wants to edit.

RULES:
- Prefer CONTENT sections over navigation/header/footer
- Use meaning and context, not just keyword matching
- "Leeds golf" could mean a heading that says "Leeds Golf Centre" — fuzzy match is OK
- If the user mentions text that's slightly different from the file, still match the closest section
- If the user previously said "no, wrong section", pick a DIFFERENT section this time
- Return the line range that covers the FULL section (from <section> to </section>)`,
        messages: [{ role: 'user', content: userContent }]
      });
      try {
        return this._extractJSON(response.content[0].text);
      } catch (jsonErr) {
        logger.warn('AI returned invalid JSON in identifySection', { response: response.content[0].text.substring(0, 500) });
        return null;
      }
    } catch (error) {
      logger.error('Section identification failed', { error: error.message });
      return null;
    }
  }

  // ─── PHASE 2: Execute edit — old_block/new_block like Claude Code ───────
  // AI receives the RAW SOURCE CODE of the section and returns exact text replacement
  async executeEdit(prompt, sectionContent, filePath, imageData = null, savedImageUrl = null) {
    logger.info('Phase 2: Executing edit', { file: filePath });

    let editInstruction = prompt;
    if (savedImageUrl) {
      const assetPath = `{{ asset('${savedImageUrl.substring(1)}') }}`;
      editInstruction += `\n\nThe user uploaded an image saved at: ${savedImageUrl}\nFor image src use exactly: ${assetPath}`;
    }

    const systemPrompt = `You are a code editor like Claude Code or Cursor. You edit Laravel Blade source files.

You receive a section of RAW SOURCE CODE (Blade PHP) — NOT rendered HTML. This includes @include, @foreach, {{ }}, and other Blade directives.

Your job: find the exact lines to change and return a precise find-and-replace.

THINKING PROCESS:
1. UNDERSTAND what the user wants to change
2. FIND the exact lines in the source code that need changing
3. COPY those lines EXACTLY as they appear (character-for-character, including whitespace and Blade syntax)
4. WRITE the replacement with ONLY the requested change

OUTPUT: Return ONLY valid JSON:
{"old_block":"exact verbatim lines from the source code","new_block":"the replacement lines","reasoning":"what was changed"}

CRITICAL RULES:
- old_block must be COPIED character-for-character from the provided source — including spaces, tabs, newlines, Blade directives, HTML attributes
- Include 1-2 surrounding lines in old_block so it matches uniquely
- new_block changes ONLY what the user asked — everything else stays identical
- Do NOT invent code that isn't in the source
- Do NOT convert Blade syntax to plain HTML
- If the text contains special characters like smart quotes, copy them exactly
- If ambiguous: {"error":"Need more specific instruction"}`;

    const textBlock = {
      type: 'text',
      text: `USER REQUEST: "${editInstruction}"

SOURCE CODE of the section (this is raw Blade PHP, not rendered HTML):
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
      return { mode: 'skip' };
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
