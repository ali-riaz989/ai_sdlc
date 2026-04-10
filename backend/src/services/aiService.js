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
  async generateCode(fileInfo, originalContent = null, priorMessages = [], onToken = null, pageContext = null) {
    logger.info('Generating code', { file: fileInfo.file_path, threaded: priorMessages.length > 0 });

    const systemPrompt = `You are an AI code editor (like Cursor or Claude Code) that makes precise, surgical edits to Laravel Blade files.

You MUST return ONLY valid JSON — no markdown, no explanation, no commentary.
The JSON format is: {"old_block":"exact verbatim text from the file","new_block":"replacement text"}

CRITICAL RULES:
- old_block must be EXACTLY character-for-character identical to a section in the file — copy it precisely
- Include 3-5 surrounding lines in old_block so it matches uniquely in the file
- new_block contains the modified version — change ONLY what the user asked for
- Preserve all indentation, whitespace, HTML structure, Blade directives exactly
- Do NOT rewrite sections the user didn't mention
- If the user mentions a heading, button, text, or section — find that EXACT element in the file and change only that`;

    // Build DOM context string so the AI knows what the user sees on screen
    let domNote = '';
    if (pageContext) {
      const parts = [];
      if (pageContext.url) parts.push(`Current page URL: ${pageContext.url}`);
      if (pageContext.title) parts.push(`Page title: "${pageContext.title}"`);
      if (pageContext.headings?.length) parts.push('Visible headings:\n' + pageContext.headings.map(h => `  - [${h.tag}] "${h.text}"`).join('\n'));
      if (pageContext.navLinks?.length) parts.push('Navigation links: ' + pageContext.navLinks.join(', '));
      if (pageContext.buttons?.length) parts.push('Buttons/CTAs:\n' + pageContext.buttons.map(b => `  - "${b.text}"${b.href ? ' → ' + b.href : ''}`).join('\n'));
      if (pageContext.images?.length) parts.push('Images:\n' + pageContext.images.map(i => `  - alt="${i.alt}"`).join('\n'));
      if (pageContext.paragraphs?.length) parts.push('Text content:\n' + pageContext.paragraphs.slice(0, 5).map(p => `  - "${p.substring(0, 120)}"`).join('\n'));
      if (pageContext.sections?.length) {
        pageContext.sections.forEach(s => {
          const fields = (s.fields || []).map(f => `${f.field}="${f.text}"`).join(', ');
          parts.push(`Data section [${s.section_slug || s.section_id}]: ${fields || s.current_text?.substring(0, 150)}`);
        });
      }
      if (parts.length) domNote = `\n\nThis is what the user currently sees on the page (use this to locate the right element in the code):\n${parts.join('\n')}`;
    }

    if (originalContent) {
      const generateUserPrompt = `The user is looking at this page and asks: "${fileInfo.description}"${domNote}

File: ${fileInfo.file_path}

\`\`\`blade
${originalContent}
\`\`\`

Find the exact section the user is referring to and return the surgical edit as JSON:
{"old_block":"verbatim text from the file above","new_block":"modified replacement"}`;

      const messages = [
        ...priorMessages,
        { role: 'user', content: generateUserPrompt }
      ];

      try {
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
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in AI response');
    return JSON.parse(match[0]);
  }

  _extractCode(text) {
    return text.replace(/^```[\w]*\n?/gm, '').replace(/^```\s*$/gm, '').trim();
  }
}

module.exports = new AIService();
