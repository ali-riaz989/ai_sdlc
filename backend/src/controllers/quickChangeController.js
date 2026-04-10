/**
 * Quick change endpoint — three tiers:
 *
 * Tier 1 (<1s)  — regex direct match, zero AI, text replace in blade file
 * Tier 2 (<3s)  — one small AI call with DOM context only, then text replace
 * Tier 3        — returns { fallback: true } — caller falls back to full pipeline
 */

const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const logger = require('../utils/logger');
const routeResolver = require('../services/routeResolver');
const { tryDirectMatch } = require('../services/directMatcher');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

class QuickChangeController {
  async handle(req, res, next) {
    const { project, prompt, current_page_url, page_context } = req.body;
    if (!project || !prompt) return res.status(400).json({ error: 'project and prompt required' });

    const projectPath = project.local_path;
    const projectUrl  = project.project_url;

    try {
      // ── Resolve current page → blade file ───────────────────────────────
      let bladeFile = null;
      if (current_page_url) {
        const resolved = await routeResolver.resolve(projectPath, current_page_url);
        if (resolved) {
          try { await fs.access(resolved.abs_path); bladeFile = resolved; } catch {}
        }
      }

      // ── Tier 1: pure regex, ZERO AI ─────────────────────────────────────
      const directMatch = tryDirectMatch(prompt, page_context);
      if (directMatch?.old_text) {
        const result = await this._applyTextChange(projectPath, bladeFile, directMatch.old_text, directMatch.new_value);
        if (result.applied) {
          await this._clearViewCache(projectPath);
          logger.info('Tier 1 applied', { file: result.file, old: directMatch.old_text, new: directMatch.new_value });
          return res.json({
            tier: 1,
            applied: true,
            file: result.file,
            dom_update: {
              old_text: directMatch.old_text,
              new_value: directMatch.new_value,
              section_id: directMatch.section_id || null,
              field: directMatch.field || null
            }
          });
        }
      }

      // ── Tier 2: one small AI call, DOM context only ──────────────────────
      const tier2 = await this._tier2AI(prompt, page_context, bladeFile, projectPath);
      if (tier2) {
        const result = await this._applyTextChange(projectPath, bladeFile, tier2.old_text, tier2.new_value);
        if (result.applied) {
          await this._clearViewCache(projectPath);
          logger.info('Tier 2 applied', { file: result.file });
          return res.json({
            tier: 2,
            applied: true,
            file: result.file,
            dom_update: { old_text: tier2.old_text, new_value: tier2.new_value }
          });
        }
      }

      // ── Tier 3: can't handle quickly — tell frontend to fall back ────────
      logger.info('Quick change fallback to full pipeline', { prompt });
      return res.json({ tier: 3, fallback: true });

    } catch (error) {
      logger.error('Quick change error', { error: error.message });
      return res.json({ tier: 3, fallback: true });
    }
  }

  // ── Tier 2: send only DOM context + prompt, get back {old_text, new_value} ─
  async _tier2AI(prompt, pageContext, bladeFile, projectPath) {
    try {
      // Build a slim context — no file contents, just visible text from DOM
      const domSummary = this._summarizeDom(pageContext);

      // Optionally include the first 3000 chars of the resolved blade file
      let bladeSnippet = '';
      if (bladeFile) {
        try {
          const raw = await fs.readFile(bladeFile.abs_path, 'utf-8');
          bladeSnippet = `\n\nBlade file (${bladeFile.blade_file}):\n${raw.substring(0, 3000)}`;
        } catch {}
      }

      const response = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        system: 'You are a web content editor. Return ONLY valid JSON, no explanation.',
        messages: [{
          role: 'user',
          content: `Page content visible to user:\n${domSummary}${bladeSnippet}\n\nUser request: "${prompt}"\n\nFind the EXACT text that needs to change and what it should become.\nJSON only: {"old_text":"exact current text","new_value":"new text"}\nIf this is a structural/layout change reply: {"structural":true}`
        }]
      });

      const text = response.content[0].text.trim();
      const json = this._extractJSON(text);
      if (json?.structural) return null;
      if (json?.old_text && json?.new_value) return json;
    } catch (err) {
      logger.warn('Tier 2 AI call failed', { error: err.message });
    }
    return null;
  }

  // ── Apply: find old_text in resolved blade file, then all blade files ──────
  async _applyTextChange(projectPath, bladeFile, oldText, newText) {
    // If we resolved the current page — ONLY touch that file. Never scan others.
    if (bladeFile) {
      const applied = await this._replaceInFile(bladeFile.abs_path, oldText, newText);
      if (applied) return { applied: true, file: bladeFile.blade_file };
      // Text not found in the resolved file → do NOT fall back to other views
      return { applied: false };
    }

    // No page resolved (no current_page_url sent) — scan only frontend views,
    // explicitly excluding admin/, auth/, and vendor/ directories.
    const viewsDir = path.join(projectPath, 'resources/views');
    const allViews = await this._findBladeFiles(viewsDir, ['admin', 'auth', 'vendor', 'layouts', 'emails']);
    for (const fp of allViews) {
      const applied = await this._replaceInFile(fp, oldText, newText);
      if (applied) return { applied: true, file: path.relative(projectPath, fp) };
    }

    return { applied: false };
  }

  async _replaceInFile(filePath, oldText, newText) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (!content.includes(oldText)) return false;
      await fs.writeFile(filePath, content.split(oldText).join(newText), 'utf-8');
      return true;
    } catch { return false; }
  }

  async _findBladeFiles(dir, excludeDirs = []) {
    const files = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && excludeDirs.includes(e.name)) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) files.push(...await this._findBladeFiles(fp, excludeDirs));
        else if (e.name.endsWith('.blade.php')) files.push(fp);
      }
    } catch {}
    return files;
  }

  _summarizeDom(pageContext) {
    if (!pageContext) return 'No DOM context available.';
    const lines = [];
    if (pageContext.title) lines.push(`Page title: ${pageContext.title}`);
    if (pageContext.headings?.length) {
      lines.push('Headings: ' + pageContext.headings.map(h => `[${h.tag}] "${h.text}"`).join(', '));
    }
    if (pageContext.buttons?.length) {
      lines.push('Buttons/links: ' + pageContext.buttons.map(b => `"${b.text}"`).join(', '));
    }
    if (pageContext.paragraphs?.length) {
      lines.push('Paragraphs (first): ' + pageContext.paragraphs.slice(0, 3).map(p => `"${p.substring(0, 100)}"`).join(' | '));
    }
    if (pageContext.sections?.length) {
      pageContext.sections.forEach(s => {
        const fields = (s.fields || []).map(f => `${f.field}="${f.text}"`).join(', ');
        lines.push(`Section[${s.section_slug || s.section_id}]: ${fields || s.current_text?.substring(0, 100)}`);
      });
    }
    return lines.join('\n');
  }

  _extractJSON(text) {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }

  _clearViewCache(projectPath) {
    return new Promise(resolve => {
      exec('php artisan view:clear', { cwd: projectPath }, () => resolve());
    });
  }
}

module.exports = new QuickChangeController();
