const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');
const requestLogger = require('../utils/requestLogger');

class AIService {
  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 60000,    // hard cap per request (ms) — prevents the SDK from sitting forever on a half-open socket
      maxRetries: 3,     // retry transient network/5xx failures with exponential backoff
    });
    this.model = 'claude-sonnet-4-6';
    // Edit model. Haiku 4.5 is faster but makes verbatim-copy typos under
    // pressure and tends to pick the first matching CSS rule (often a
    // framework reset) instead of the project's specific override. Sonnet
    // handles both correctly. Latency is ~2x but accuracy matters more for
    // non-technical users who can't debug a botched edit.
    this.editModel = 'claude-sonnet-4-6';
  }

  // ─── Step 1: Fast classifier (<2 s) ────────────────────────────────────────
  async classifyChange(prompt, _ctx = null) {
    logger.info('Classifying change', { prompt: prompt.substring(0, 80) });
    try {
      const t0 = Date.now();
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 200,
        system: 'You are a classifier. Reply with valid JSON only, no explanation.',
        messages: [{
          role: 'user',
          content: `Classify this change request for a Laravel website:\n"${prompt}"\n\nReply ONLY with JSON:\n{"type":"text_swap"|"structural","target_text":"exact text to find (empty if structural)","new_text":"replacement text (empty if structural)"}`
        }]
      });
      if (_ctx?.requestId) requestLogger.recordAiCall(_ctx.requestId, { fn: 'classifyChange', model: this.model, ms: Date.now() - t0, response });
      return this._extractJSON(response.content[0].text);
    } catch (error) {
      logger.warn('Classification failed, falling back to structural', { error: error.message });
      if (_ctx?.requestId) requestLogger.recordError(_ctx.requestId, error);
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
  async _locateAndSwap(fileContent, _filePath, targetText, newText, _ctx = null) {
    try {
      const t0 = Date.now();
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: fileContent.length + 500,
        system: 'You are a Laravel file editor. Return ONLY the modified file content, no markdown, no explanation.',
        messages: [{
          role: 'user',
          content: `In this file, replace "${targetText}" with "${newText}".\n\nFile content:\n${fileContent}`
        }]
      });
      if (_ctx?.requestId) requestLogger.recordAiCall(_ctx.requestId, { fn: '_locateAndSwap', model: this.model, ms: Date.now() - t0, response });
      return { found: true, content: this._extractCode(response.content[0].text) };
    } catch (error) {
      if (_ctx?.requestId) requestLogger.recordError(_ctx.requestId, error);
      return { found: false, content: fileContent };
    }
  }


  // ─── Execute edit — old_block/new_block like Claude Code ────────────────
  // AI receives the RAW SOURCE CODE of the section and returns exact text replacement
  async executeEdit(prompt, sectionContent, filePath, imageData = null, savedImageUrl = null, language = 'blade', conversation = null, _ctx = null) {
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
      const t0 = Date.now();
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      });
      if (_ctx?.requestId) requestLogger.recordAiCall(_ctx.requestId, { fn: 'executeEdit', model: this.model, ms: Date.now() - t0, response });
      let result;
      try {
        result = this._extractJSON(response.content[0].text);
      } catch (jsonErr) {
        logger.warn('AI returned invalid JSON in executeEdit', { response: response.content[0].text.substring(0, 500) });
        if (_ctx?.requestId) requestLogger.recordError(_ctx.requestId, jsonErr, 'invalid_json');
        return { mode: 'skip' };
      }

      if (result?.error) {
        logger.warn('AI reported ambiguity', { error: result.error });
        if (_ctx?.requestId) requestLogger.recordError(_ctx.requestId, result.error, 'ambiguous');
        return { mode: 'skip', reason: result.error };
      }

      if (result?.old_block !== undefined && result?.new_block !== undefined) {
        logger.info('Edit ready', { reasoning: result.reasoning, old_preview: result.old_block.substring(0, 80) });
        if (_ctx?.requestId) requestLogger.recordReasoning(_ctx.requestId, result.reasoning);
        return { mode: 'replace', old_block: result.old_block, new_block: result.new_block, reasoning: result.reasoning };
      }

      logger.warn('AI returned unexpected shape', { keys: Object.keys(result || {}) });
      return { mode: 'skip' };
    } catch (error) {
      logger.error('Edit execution failed', { error: error.message });
      if (_ctx?.requestId) requestLogger.recordError(_ctx.requestId, error);
      const reason = error.message?.includes('rate_limit') || error.message?.includes('429')
        ? 'Rate limit reached — wait a moment and try again'
        : error.message?.includes('Connection')
        ? 'API connection error — try again in a moment'
        : 'AI service error: ' + (error.message || 'unknown');
      return { mode: 'skip', reason };
    }
  }

  // ── Static system prompt for the edit path. Hoisted so warmEditCache can use the
  //    exact same bytes — cache hits depend on byte-identical prefixes.
  get _editSystemPrompt() {
    return `You are a code editor for a website codebase, operating like Claude Code: you read attached files, understand what the user wants, and emit the smallest precise edit that produces the requested visible result.

THE PERSON YOU ARE TALKING TO:

The user is non-technical. They describe what they see on the page — colours, text, sizes, animations, positions — not the underlying code. They do not know HTML vs CSS vs JS, or where a rule lives. Your job is to translate their everyday description into the right technical change and to explain in reasoning what you did in everyday language too. Never use jargon like "@keyframes", "selector specificity", "blade partial", "cascade", "compiled output" in messages the user reads.

WHAT YOU RECEIVE:

- SELECTED ELEMENT: metadata about the element the user clicked (tag, classes, text, the parent section, and the precise file+line via bladeSrc when available).
- USER REQUEST: what they typed, plus any prior chat turns.
- CANDIDATE FILES: blade templates, CSS, JS files. Whole files when they fit; otherwise scoped slices. Files marked [type: example] are READ-ONLY reference — never set file_path to those.
- CLICK REGION: a numbered ~30-line window of the blade around the line under the cursor, with a marker on the click line itself. This is authoritative for which part of the page the user means.

THE FILES ARE COMPLETE. There are no hidden rules, no "elsewhere" — what you see in attached files is what the project has. If a property isn't there, it genuinely isn't declared. Never ask the user to "send the full file" or "provide the untruncated CSS".

WORKFLOW (run through every prompt, in order):

Step 1 — INTERPRET. What VISIBLE outcome does the user want? Translate their words into a concrete observable change. If they name a value, that value is the target. If they describe a behaviour ("stop", "remove", "make like Y"), identify the behaviour precisely.

Step 2 — LOCATE. Find the existing markup and existing rules that produce the current visible behaviour for the target element. Start at the click region. Read the parent and ancestor wrappers there. Then scan the attached CSS for declarations whose selectors match any of those class names (including pseudo-class variants like :hover/:focus and media queries). Also scan attached JS if interactivity is involved. Recognise SCSS-style nesting: an inner &-prefixed block inside a parent .x is a pseudo-class rule for .x; an inner .y block is the descendant rule .x .y; an inner @media block is a responsive variant. Treat these as real rules and edit values inside them.

Step 3 — CHOOSE THE SMALLEST EDIT. The right edit is almost always changing one existing value, not adding a new rule, not introducing structure. The right file is almost always the one that already declares the property you need to change. If multiple files would each have to change for the user to see the result (e.g. a behaviour driven by HTML + CSS together, or a class renamed across blade + CSS), emit SHAPE A-MULTI with every needed edit at once.

Step 4 — VERIFY MENTALLY. Imagine the user reloading the page right after your edit is written. Will they see exactly what they asked for? If your edit only sets some unrelated property, or relies on a follow-up step that nothing will perform, or merely overrides one of several conflicting declarations, the edit is wrong — go back to Step 2.

Step 5 — EMIT. Output ONE valid JSON object using one of the output shapes below. Reasoning describes what the edit actually does in plain user-facing language.

PRINCIPLES (every step above is bound by these):

- Edit existing values. If the property the user is changing is already declared on the target element somewhere in the attached files, your edit MUST modify that declaration. Adding a new rule in a different file to "override" the existing one is wrong: it leaves stale code, splits the source of truth, and reads as clutter. Only add a new declaration when the visible behaviour has no existing declaration at all in the project.

- Prefer the most specific matching rule. CSS files commonly contain BOTH generic framework defaults (e.g. resets that use variables and never set a literal value visible to the user) AND project-specific overrides further down the file that paint the actual visible value the user sees. When more than one rule matches the target element, the rule the user is actually looking at is the one whose selector matches the most ancestor classes from the click region (e.g. .questions-area .nav-tabs button beats plain .nav-tabs .nav-link). Search the entire file before picking — the framework-default rule near the top is rarely the right edit. Skip rules that only assign CSS variables or use var() exclusively for the property in question, since they do not set a literal value the user sees.

- Diagnose the visible problem before picking a property. When the user describes a visible symptom (extra space, the element being too tall/wide/short, content cut off, overflow, misalignment), inspect ALL size-relevant declarations on the target element and its ancestors before choosing what to edit. Multiple properties can produce the same visible symptom — extra blank area below a section can come from the section's own height/min-height being forced larger than its content, from padding-bottom, from margin-bottom on the section, from margin-top on the next sibling, or from a fixed height on the section's parent. If you only touch margin/padding when the symptom is actually driven by an explicit height/min-height, the user will see no change. Read the existing values on the target and pick the property whose current value plausibly produces the visible symptom — usually the property with the most extreme or out-of-place value (e.g. an explicit large pixel height that doesn't match the content).
- No invention. Never introduce class names, wrapper elements, inline style attributes, hover states, transitions, animations, or conditional visibility that the user did not ask for. A direct static command receives a direct static edit.
- Literal execution. If the user names a concrete value, that exact value (or a syntactically equivalent form for the property) must appear in your new_block on the target property. If your reasoning describes an outcome, the new_block must produce that outcome by itself — no imagined future steps, no "the hover will pick this up", no semantic flip from the named value to its opposite.
- Cascade awareness when removing. The browser computes each property independently. If the user asks to disable something declared by multiple rules, deleting one declaration is rarely enough — either remove the property from every rule that sets it, or override with an explicit off value in the latest-loaded file. After choosing, ask yourself: "does any other rule still set this property?" If yes, your edit isn't complete.
- Same-block bundling. When a request packs several changes into one card/section/block, expand old_block to cover the whole block and apply every change inside the matching new_block. Never split into multiple JSON outputs — the runtime accepts one. Never return only the first change and ignore the rest.
- Bulk changes (all / every / each). The user is asking N elements to update. Prefer a single SHARED-SUBSTRING replace if the targets share an identical line, otherwise add or edit a CSS rule whose selector matches all of them. Don't anchor old_block to one instance's parent — that silently misses the others.
- The runtime owns "did you mean a different element?" confirmation. If the user's words name an element elsewhere in the file (by its label text, heading, or alt), emit the SHAPE A edit for that named element directly. Don't tell the user to re-click — the runtime detects the mismatch and asks the user to confirm before applying.

WHEN TO ASK INSTEAD OF EDIT (SHAPE C):

Only when you genuinely cannot pick the target with confidence:
- Multiple plausible properties could carry the value (text colour vs background vs border).
- A relative size word was used (bigger, smaller, double, half, wider, …) but the element has no explicit current measurement to compute against.
- Two or more elements at the click region could equally match the request and you cannot tell which.

The error MUST reference what you saw at the click region (heading text, class name, or surrounding element). It MUST end with a question mark and offer 2-3 concrete options the user can pick from. Never return generic phrases like "ambiguous", "cannot determine", "please clarify". Never tell the user to click directly on something — the runtime handles re-targeting.

OUTPUT SHAPES (pick ONE; return only valid JSON):

SHAPE A — in-place find-and-replace (default for edits, additions, image swaps, partial removals):
{"file_path":"<path from a FILE header>","old_block":"<exact verbatim lines>","new_block":"<replacement lines>","reasoning":"<one short user-facing sentence>"}

SHAPE A-MULTI — one user request that requires changes across MULTIPLE files (HTML + CSS together, a renamed class across files, etc.). Emit ALL edits in one response:
{"edits":[{"file_path":"<f1>","old_block":"...","new_block":"..."},{"file_path":"<f2>","old_block":"...","new_block":"..."}],"reasoning":"<one short user-facing sentence covering the whole change>"}

SHAPE B — structural move (use only when the user wants to relocate a block of markup):
{"file_path":"<path>","move":{"source_start":"<verbatim first line of block to move>","source_end":"<verbatim last line of block to move>","insert_before":"<verbatim first line of the destination>"},"reasoning":"<short>"}

SHAPE C — clarification question or unsolvable error:
{"error":"<question ending in ? with 2-3 concrete options>"}

SHAPE D — delete an entire page or blog file:
{"file_path":"<path to the page/blog blade file>","delete":true,"reasoning":"<short>"}
The runtime will automatically strip the matching Route::get('<url>', …) line from routes/web.php after the file is deleted — don't include a web.php edit yourself. SHAPE D is only for whole-file removal; partial removals are SHAPE A with an empty new_block.

SHAPE A RULES:
- old_block is copied character-for-character (whitespace, quotes, Blade directives, all verbatim). Include 1-2 surrounding lines so the match is unique within the chosen file.
- new_block changes only what the user asked for. Never invent code not present in the files.
- To ADD content, find a nearby existing block; put those lines verbatim in old_block; put the same lines PLUS your new content in new_block.
- If appending at the very end, old_block is the last 2-5 non-empty lines verbatim.

SHAPE B RULES:
- All three anchors are SINGLE lines, copied verbatim, each unique enough to identify a position. Prefer opening tags or unique comments; avoid generic closers like </div>.
- If the block is already at the requested position, return SHAPE C with that observation phrased as confirmation.

VOICE for every reasoning and error message:
- Second person. "You clicked …", "You said to …". Never "the user", "the request".
- Plain language only. No technical CSS/HTML/blade terms.
- Errors that are questions end with ?. Errors that are genuine refusals (rare) do not.

WHICH FILE TYPE:
- Visual styling (colour, spacing, size, layout, animation, transition) → the CSS file that already declares the relevant property on the target element.
- Text content, markup structure, image src, additions, removals → the Blade template.
- Interactive widgets (sliders, modals, accordions, dropdowns, lightboxes, form validation) → both blade (markup) and JS (init), via SHAPE A-MULTI.
- Project uses Bootstrap 5: prefer Bootstrap utility classes (row gutters, gap utilities, col-*-* responsive widths) over raw CSS overrides for layout-shaped requests. Don't add !important unless the user explicitly asks.`;
  }

  // Shared with warmEditCache — both callers must produce IDENTICAL bytes for cache hits.
  _buildFilesBlock(candidates) {
    return candidates.map(c =>
      `\n===== FILE: ${c.path}  [type: ${c.type}] =====\n${c.content}\n===== END FILE: ${c.path} =====\n`
    ).join('\n');
  }

  // ── Pre-warm the prompt cache for an upcoming edit. Called when the iframe lands on a
  //    new URL — by the time the user types a prompt, Anthropic has the system+files
  //    prefix cached, so the visible edit is the warm path (~2s) instead of cold (~4s).
  //    Fire-and-forget; failures are non-fatal.
  async warmEditCache({ candidates }) {
    if (!candidates?.length) return;
    const filesContext = `CANDIDATE FILES:${this._buildFilesBlock(candidates)}`;
    try {
      const t0 = Date.now();
      const response = await this.client.messages.create({
        model: this.editModel,
        max_tokens: 8,    // tiny output — we only care about populating the cache
        system: [{ type: 'text', text: this._editSystemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [
          { type: 'text', text: filesContext, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'ack' },
        ]}]
      });
      const u = response.usage || {};
      logger.info('Cache warmed', {
        ms: Date.now() - t0,
        files: candidates.map(c => c.path).join(','),
        input: u.input_tokens,
        cache_read: u.cache_read_input_tokens || 0,
        cache_create: u.cache_creation_input_tokens || 0,
      });
    } catch (e) {
      logger.warn('Cache warm failed', { error: e.message });
    }
  }

  // ─── Claude-Code-style edit: AI picks which file to edit from multiple candidates ───
  // candidates: [{ path, content, type }]  (e.g. blade, css, js)
  // onToken (optional): callback invoked with each text delta as Claude streams the response —
  //                     hook this to socket emission for live UI feedback.
  // Returns { mode: 'replace', file_path, old_block, new_block, reasoning } or { mode: 'skip', reason }
  async executeEditMulti({ prompt, selectedElement, candidates, conversation = null, imageData = null, savedImageUrl = null, onToken = null, iframeViewport = null, _ctx = null, _attempt = 1 }) {
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

    const clickCandidate = candidates.find(c => c.clickAnchor || c.clickRegion);
    const clickAnchor = clickCandidate?.clickAnchor;
    const clickLine = clickCandidate?.clickLine;
    const clickRegion = clickCandidate?.clickRegion;
    // The frontend reads data-blade-src="<path>:<line>" from the clicked DOM element —
    // an authoritative pointer to the source file the click came from.
    const clickedFilePath = (selectedElement?.bladeSrc && selectedElement.bladeSrc.includes(':'))
      ? selectedElement.bladeSrc.substring(0, selectedElement.bladeSrc.lastIndexOf(':'))
      : null;
    const elInfo = selectedElement ? `
SELECTED ELEMENT (what the user clicked):
- tag: <${selectedElement.tag || '?'}>
- classes: "${selectedElement.classes || ''}"
- heading/section: "${selectedElement.section || ''}"
- inner text (preview): "${(selectedElement.text || '').substring(0, 100)}"
- is image: ${selectedElement.isImage ? 'yes' : 'no'}${clickLine ? `
- click landed at line ${clickLine} of the file (use the CLICK REGION below to identify the exact instance when the same markup repeats)` : ''}${clickAnchor ? `
- click-landed on this exact line: ${JSON.stringify(clickAnchor.substring(0, 200))}` : ''}${clickedFilePath ? `
- EDIT TARGET FILE: ${clickedFilePath} (this is the file the click came from — set file_path to this value unless the request is purely a CSS-rule change, in which case pick the matching CSS file from the candidates)` : ''}${iframeViewport?.width ? `
- viewport at edit time: ${iframeViewport.width}×${iframeViewport.height || '?'}px (Bootstrap breakpoint: ${iframeViewport.breakpoint || '?'}). When the user describes a layout change ("3 per row", "responsive", "wider"), pick utility classes that engage AT OR BELOW this breakpoint — don't only target larger breakpoints the user can't see` : ''}` : '';

    // The click region is a numbered ~30-line window centred on the click point.
    // It's the unambiguous disambiguator when a page has multiple identical-looking
    // blocks (e.g. several testimonial cards). Tell Claude explicitly to use this
    // window to find WHICH instance to edit, then copy the verbatim text from
    // CANDIDATE FILES (which has no line numbers) into old_block.
    const clickRegionBlock = clickRegion ? `
CLICK REGION (line numbers shown for reference; the ▶ marker is the line under the user's click):
\`\`\`
${clickRegion}
\`\`\`
The user's intent is targeted at the markup AT or IMMEDIATELY ENCLOSING the marked line. When multiple similar blocks exist in the file, this region overrides any other heuristic — only edit the block that contains or surrounds line ${clickLine || '?'}. Copy old_block VERBATIM from the CANDIDATE FILES section (no line numbers there).
` : '';

    // Build the cacheable prefix (system + filesContext) using the SAME bytes as warmEditCache
    // — this is what makes pre-warming actually pay off.
    const filesContext = `CANDIDATE FILES:${this._buildFilesBlock(candidates)}`;
    const variableContent = `USER REQUEST: "${editInstruction}"${conversationNote}
${elInfo}
${clickRegionBlock}
Return ONLY valid JSON.`;

    const textBlocks = [
      { type: 'text', text: filesContext, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: variableContent },
    ];
    const userContent = imageData
      ? [{ type: 'image', source: { type: 'base64', media_type: imageData.mediaType, data: imageData.base64 } }, ...textBlocks]
      : textBlocks;

    try {
      const t0 = Date.now();
      // Stream the response so the frontend's streaming-tokens UI fills in live as Claude
      // generates. Total wall-clock time is the same; perceived latency is much better.
      const stream = this.client.messages.stream({
        model: this.editModel,           // Haiku 4.5 — fast path for surgical edits
        max_tokens: 2048,                // tighter cap; Shape A/B responses fit easily under 1K
        system: [{ type: 'text', text: this._editSystemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userContent }]
      });
      if (typeof onToken === 'function') stream.on('text', (delta) => onToken(delta));
      const finalMessage = await stream.finalMessage();
      const u = finalMessage.usage || {};
      const aiMs = Date.now() - t0;
      logger.info('Edit token usage', {
        ms: aiMs, model: this.editModel,
        input: u.input_tokens, cache_read: u.cache_read_input_tokens || 0,
        cache_create: u.cache_creation_input_tokens || 0, output: u.output_tokens,
      });
      if (_ctx?.requestId) requestLogger.recordAiCall(_ctx.requestId, { fn: 'executeEditMulti', model: this.editModel, ms: aiMs, response: finalMessage, attempt: _attempt });
      // Synthesise a response-shaped object so the rest of the function reads identically.
      const response = finalMessage;
      let result;
      try { result = this._extractJSON(response.content[0].text); }
      catch (jsonErr) {
        logger.warn('AI returned invalid JSON in executeEditMulti');
        if (_ctx?.requestId) requestLogger.recordError(_ctx.requestId, jsonErr, 'invalid_json');
        return { mode: 'skip' };
      }

      if (result?.error) {
        if (_ctx?.requestId) requestLogger.recordError(_ctx.requestId, result.error, 'ambiguous');
        return { mode: 'skip', reason: result.error };
      }

      // SHAPE D: file deletion. Claude emits { file_path, delete: true }.
      // Caller is expected to also strip any matching Route::get from web.php
      // for static_pages/blogs (deterministic post-processing in the controller).
      if (result?.delete === true && result?.file_path) {
        logger.info('File deletion requested', { file: result.file_path, reasoning: result.reasoning });
        if (_ctx?.requestId) requestLogger.recordReasoning(_ctx.requestId, result.reasoning);
        return { mode: 'delete', file_path: result.file_path, reasoning: result.reasoning };
      }

      // SHAPE A-MULTI: multiple file edits in one response. Used when a single
      // user request needs changes that span more than one file (animation
      // markup + CSS keyframes, class rename across blade + CSS, etc.). The
      // controller applies each edit sequentially using the same uniqueness
      // and apply logic as single-file SHAPE A.
      if (Array.isArray(result?.edits) && result.edits.length > 0) {
        const edits = result.edits.filter(e => e && typeof e.old_block === 'string' && typeof e.new_block === 'string');
        if (edits.length === 0) {
          return { mode: 'skip', reason: 'multi-edit response had no usable edits' };
        }
        // Backfill missing file_path on individual edits using the candidate inference helper.
        for (const e of edits) {
          if (!e.file_path) e.file_path = (() => {
            const hits = candidates.filter(c => c.content && c.content.includes(e.old_block));
            if (hits.length === 1) return hits[0].path;
            if (hits.length > 1 && clickedFilePath) {
              const preferred = hits.find(h => h.path === clickedFilePath);
              if (preferred) return preferred.path;
            }
            return null;
          })();
        }
        const missing = edits.filter(e => !e.file_path);
        if (missing.length) {
          if (_ctx?.requestId) requestLogger.recordError(_ctx.requestId, `multi-edit had ${missing.length} edit(s) with no resolvable file_path`, 'ambiguous');
          return { mode: 'skip', reason: `Multi-file edit had ${missing.length} edit(s) whose target file couldn't be determined` };
        }
        logger.info('Multi-file edit ready', { count: edits.length, files: edits.map(e => e.file_path).join(', '), reasoning: result.reasoning });
        if (_ctx?.requestId) requestLogger.recordReasoning(_ctx.requestId, result.reasoning);
        return { mode: 'multi', edits, reasoning: result.reasoning };
      }

      // Infer file_path if Claude forgot to include it: look for candidates whose content
      // contains the old_block (or move anchors). When multiple candidates match, prefer
      // the one the user clicked in (from data-blade-src).
      const inferFilePath = (needle) => {
        if (!needle) return null;
        const hits = candidates.filter(c => c.content && c.content.includes(needle));
        if (hits.length === 0) return null;
        if (hits.length === 1) return hits[0].path;
        // Tie-break: the user clicked in this specific file — prefer it over any other match
        if (clickedFilePath) {
          const preferred = hits.find(h => h.path === clickedFilePath);
          if (preferred) return preferred.path;
        }
        return null;
      };

      if (result?.move?.source_start && result?.move?.source_end && result?.move?.insert_before) {
        const filePath = result.file_path || inferFilePath(result.move.source_start) || inferFilePath(result.move.insert_before);
        if (!filePath) {
          logger.warn('Move anchors not unique to any candidate', { source_start: result.move.source_start?.substring(0, 60) });
          return { mode: 'skip', reason: 'Could not determine which file to move within' };
        }
        logger.info('Structural move ready', { file: filePath, inferred: !result.file_path, reasoning: result.reasoning });
        if (_ctx?.requestId) requestLogger.recordReasoning(_ctx.requestId, result.reasoning);
        return { mode: 'move', file_path: filePath, ...result.move, reasoning: result.reasoning };
      }
      if (result?.old_block !== undefined && result?.new_block !== undefined) {
        const filePath = result.file_path || inferFilePath(result.old_block);
        if (!filePath) {
          logger.warn('old_block not unique to any candidate — Claude must specify file_path', { old_preview: (result.old_block || '').substring(0, 80) });
          if (_ctx?.requestId) requestLogger.recordError(_ctx.requestId, 'AI edit did not specify which file', 'ambiguous');
          return { mode: 'skip', reason: 'AI edit did not specify which file, and the target text appears in multiple files' };
        }
        logger.info('Multi-file edit ready', { file: filePath, inferred: !result.file_path, reasoning: result.reasoning });
        if (_ctx?.requestId) requestLogger.recordReasoning(_ctx.requestId, result.reasoning);
        return { mode: 'replace', file_path: filePath, old_block: result.old_block, new_block: result.new_block, reasoning: result.reasoning };
      }
      logger.warn('AI returned unexpected shape in executeEditMulti', { keys: Object.keys(result || {}) });
      return { mode: 'skip' };
    } catch (error) {
      logger.error('Multi-file edit failed', { error: error.message });
      if (_ctx?.requestId) requestLogger.recordError(_ctx.requestId, error);
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
  async analyzePageChange(prompt, bladeFilePath, bladeContent, imageData = null, changeHistory = '', relatedFiles = [], _ctx = null) {
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

    const _t0_apc = Date.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 800,
      system: 'You are an expert Laravel developer. Analyze the change request for the given blade file only. Respond ONLY with valid JSON.',
      messages: [{ role: 'user', content: userContent }]
    });
    if (_ctx?.requestId) requestLogger.recordAiCall(_ctx.requestId, { fn: 'analyzePageChange', model: this.model, ms: Date.now() - _t0_apc, response });

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
  async analyzeChangeRequest(prompt, projectContext, category, imageData = null, changeHistory = '', _ctx = null) {
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
      const _t0_acr = Date.now();
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      });
      if (_ctx?.requestId) requestLogger.recordAiCall(_ctx.requestId, { fn: 'analyzeChangeRequest', model: this.model, ms: Date.now() - _t0_acr, response });

      const result = this._extractJSON(response.content[0].text);
      logger.info('AI analysis completed', { complexity: result.complexity, risk: result.risk_level });

      const messages = [
        { role: 'user', content: userContent },
        { role: 'assistant', content: response.content[0].text }
      ];

      return { result, messages };
    } catch (error) {
      logger.error('AI analysis failed', { error: error.message });
      if (_ctx?.requestId) requestLogger.recordError(_ctx.requestId, error);
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
  async generateCode(fileInfo, originalContent = null, priorMessages = [], onToken = null, pageContext = null, imageData = null, _ctx = null) {
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
          const _t0 = Date.now();
          const response = await this.client.messages.create({
            model: this.model,
            max_tokens: 4096,
            system: systemPrompt,
            messages
          });
          if (_ctx?.requestId) requestLogger.recordAiCall(_ctx.requestId, { fn: 'generateCode:image', model: this.model, ms: Date.now() - _t0, response });
          let result;
          try { result = this._extractJSON(response.content[0].text); } catch {
            logger.warn('AI response not valid JSON (image)', { response: response.content[0].text.substring(0, 300) });
            if (_ctx?.requestId) requestLogger.recordError(_ctx.requestId, 'invalid JSON', 'invalid_json');
            return { mode: 'skip' };
          }
          if (result?.old_block !== undefined && result?.new_block !== undefined) {
            return { mode: 'replace', old_block: result.old_block, new_block: result.new_block };
          }
          return { mode: 'skip' };
        }

        if (onToken) {
          let accumulated = '';
          const _t0 = Date.now();
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
          const finalMsg = await stream.finalMessage();
          if (_ctx?.requestId) requestLogger.recordAiCall(_ctx.requestId, { fn: 'generateCode:stream', model: this.model, ms: Date.now() - _t0, response: finalMsg });
          let result;
          try {
            result = this._extractJSON(accumulated);
          } catch (jsonErr) {
            logger.warn('AI response not valid JSON', { file: fileInfo.file_path, response: accumulated.substring(0, 500) });
            if (_ctx?.requestId) requestLogger.recordError(_ctx.requestId, jsonErr, 'invalid_json');
            return { mode: 'skip' };
          }
          if (result?.old_block !== undefined && result?.new_block !== undefined) {
            logger.info('Surgical block generated (streamed)', { file: fileInfo.file_path });
            return { mode: 'replace', old_block: result.old_block, new_block: result.new_block };
          }
          logger.warn('AI returned unexpected JSON shape, skipping', { file: fileInfo.file_path, keys: Object.keys(result || {}), response: accumulated.substring(0, 300) });
          return { mode: 'skip' };
        } else {
          const _t0 = Date.now();
          const response = await this.client.messages.create({
            model: this.model,
            max_tokens: 4096,
            system: systemPrompt,
            messages
          });
          if (_ctx?.requestId) requestLogger.recordAiCall(_ctx.requestId, { fn: 'generateCode:replace', model: this.model, ms: Date.now() - _t0, response });

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
        if (_ctx?.requestId) requestLogger.recordError(_ctx.requestId, error);
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
          const _t0 = Date.now();
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
          const finalMsg = await stream.finalMessage();
          if (_ctx?.requestId) requestLogger.recordAiCall(_ctx.requestId, { fn: 'generateCode:newfile-stream', model: this.model, ms: Date.now() - _t0, response: finalMsg });
          const content = this._extractCode(accumulated);
          logger.info('New file generated (streamed)', { file: fileInfo.file_path, bytes: content.length });
          return { mode: 'create', content };
        } else {
          const _t0 = Date.now();
          const response = await this.client.messages.create({
            model: this.model,
            max_tokens: 4096,
            system: newFileSystemPrompt,
            messages: [...priorMessages, { role: 'user', content: userPrompt }]
          });
          if (_ctx?.requestId) requestLogger.recordAiCall(_ctx.requestId, { fn: 'generateCode:newfile', model: this.model, ms: Date.now() - _t0, response });

          const content = this._extractCode(response.content[0].text);
          logger.info('New file generated', { file: fileInfo.file_path, bytes: content.length });
          return { mode: 'create', content };
        }
      } catch (error) {
        logger.error('Code generation failed', { file: fileInfo.file_path, error: error.message });
        if (_ctx?.requestId) requestLogger.recordError(_ctx.requestId, error);
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
