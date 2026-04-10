/**
 * Resolves a page URL to the blade file that renders it.
 *
 * Uses a single-pass depth-tracking parser — the only reliable way to handle
 * Laravel routes files that have deeply nested groups, chained fluent calls,
 * and multiple Route::group() blocks with the same prefix.
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const projectCache = require('../utils/projectCache');

class RouteResolver {
  async resolve(projectPath, pageUrl) {
    const urlPath = this._normPath(pageUrl);
    logger.info('Resolving route', { urlPath });

    const cacheKey = `route_map:${projectPath}`;
    let routeMap = await projectCache.getRaw(cacheKey);
    if (!routeMap) {
      routeMap = await this._buildRouteMap(projectPath);
      await projectCache.setRaw(cacheKey, routeMap, 600);
      logger.info('Route map built', { total: Object.keys(routeMap).length });
    }

    if (routeMap[urlPath]) return this._toResult(projectPath, routeMap[urlPath]);

    for (const [pattern, view] of Object.entries(routeMap)) {
      if (this._matchPattern(pattern, urlPath)) return this._toResult(projectPath, view);
    }

    logger.warn('Route not resolved', { urlPath });
    return null;
  }

  // ── Route map builder ──────────────────────────────────────────────────────

  async _buildRouteMap(projectPath) {
    const map = {};
    for (const rf of ['routes/web.php']) {
      try {
        const content = await fs.readFile(path.join(projectPath, rf), 'utf-8');
        const routes = await this._parseRoutesFile(content, projectPath);
        for (const [k, v] of Object.entries(routes)) map[k] = v;
      } catch (e) {
        logger.warn('Could not read routes file', { error: e.message });
      }
    }
    return map;
  }

  /**
   * Single-pass parser. Walks the file character by character, tracking:
   * - brace depth (to know when we exit a group)
   * - prefix stack (accumulated prefix at each group level)
   *
   * At each position, we check if a Route::get/group/prefix declaration starts here.
   */
  async _parseRoutesFile(content, projectPath) {
    const map = {};
    const prefixStack = [''];  // stack of prefixes, index 0 = outermost
    let i = 0;

    while (i < content.length) {
      // Skip comments: // ... \n
      if (content[i] === '/' && content[i + 1] === '/') {
        while (i < content.length && content[i] !== '\n') i++;
        continue;
      }
      // Skip block comments: /* ... */
      if (content[i] === '/' && content[i + 1] === '*') {
        i += 2;
        while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
        i += 2;
        continue;
      }

      // Track brace depth to know when we leave a group
      if (content[i] === '}') {
        if (prefixStack.length > 1) prefixStack.pop();
        i++;
        continue;
      }

      // Check for Route:: declaration at this position
      if (content.slice(i, i + 7) === 'Route::') {
        const result = await this._parseRouteDecl(content, i, projectPath, prefixStack[prefixStack.length - 1]);
        if (result) {
          if (result.type === 'route' && result.view) {
            map[result.path] = result.view;
          } else if (result.type === 'group') {
            // Push prefix for the group body we're about to enter
            prefixStack.push(result.prefix);
            // Skip to just before the opening brace so the loop's '{' handler picks it up
            i = result.bodyStart;
            continue;
          }
          i = result.end;
          continue;
        }
      }

      i++;
    }
    return map;
  }

  /**
   * Parse a single Route:: declaration starting at `pos`.
   * Returns { type, path, view, end } for routes,
   *         { type: 'group', prefix, bodyStart, end } for groups,
   *         or null if not recognized.
   */
  async _parseRouteDecl(content, pos, projectPath, currentPrefix) {
    // Match Route::<method>( or Route::group( or Route::prefix(
    const declRe = /^Route::(get|post|put|patch|delete|match|any|group|prefix|middleware|name|namespace|where)\s*\(/;
    const decl = declRe.exec(content.slice(pos));
    if (!decl) return null;

    const method = decl[1];
    const argsStart = pos + decl[0].length;

    // Find closing ) of the immediate argument list (balanced)
    const { args, end: argsEnd } = this._readBalancedArgs(content, argsStart - 1);

    if (method === 'group') {
      const prefix = this._extractPrefixFromArgs(args);
      // Find the opening { of the callback body
      const bracePos = this._findNextBrace(content, argsEnd);
      if (bracePos === -1) return null;
      return { type: 'group', prefix: this._joinPrefix(currentPrefix, prefix), bodyStart: bracePos, end: bracePos };
    }

    // Fluent: Route::prefix('x')->...->group(function() {
    if (method === 'prefix') {
      const prefixMatch = /^\s*\(\s*['"]([^'"]+)['"]/.exec(content.slice(argsStart - 1));
      const groupPrefix = prefixMatch ? prefixMatch[1] : '';
      // Look for ->group( further along the same statement
      const lineEnd = content.indexOf(';', argsEnd);
      const chunk = content.slice(argsEnd, lineEnd === -1 ? argsEnd + 200 : lineEnd);
      const groupMatch = /->group\s*\(/.exec(chunk);
      if (groupMatch) {
        const bracePos = this._findNextBrace(content, argsEnd + groupMatch.index + groupMatch[0].length);
        if (bracePos !== -1) {
          return { type: 'group', prefix: this._joinPrefix(currentPrefix, groupPrefix), bodyStart: bracePos, end: bracePos };
        }
      }
      return null;
    }

    if (!['get', 'post', 'put', 'patch', 'delete', 'match', 'any'].includes(method)) return null;

    // Extract URL and handler from args
    const urlMatch = /^\s*['"]([^'"]+)['"]/.exec(args);
    if (!urlMatch) return null;
    const routeUrl = urlMatch[1];
    const fullPath = this._joinPrefix(currentPrefix, routeUrl);

    // Extract handler
    const afterUrl = args.slice(urlMatch[0].length).replace(/^\s*,\s*/, '');
    const view = await this._extractViewFromHandler(afterUrl, projectPath);

    return { type: 'route', path: fullPath, view, end: argsEnd };
  }

  async _extractViewFromHandler(handler, projectPath) {
    // Closure: function() { return view('x'); } or function() use(...) { ... }
    const closureRe = /^function\s*\([^)]*\)(?:\s*use\s*\([^)]*\))?\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s;
    const closureMatch = closureRe.exec(handler);
    if (closureMatch) return this._extractViewFromBody(closureMatch[1]);

    // Array: [Controller::class, 'method']
    const arrMatch = /^\[\s*([A-Za-z\\]+)::class\s*,\s*['"]([^'"]+)['"]/.exec(handler);
    if (arrMatch) {
      const ctrl = arrMatch[1].split('\\').pop();
      return await this._resolveControllerView(projectPath, ctrl, arrMatch[2]);
    }

    // String: 'Controller@method'
    const strMatch = /^['"]([A-Za-z\\]+)@([^'"]+)['"]/.exec(handler);
    if (strMatch) {
      const ctrl = strMatch[1].split('\\').pop();
      return await this._resolveControllerView(projectPath, ctrl, strMatch[2].trim());
    }

    return null;
  }

  // ── Balanced args reader ───────────────────────────────────────────────────

  _readBalancedArgs(content, openParenPos) {
    let depth = 0, i = openParenPos;
    let start = -1;
    while (i < content.length) {
      if (content[i] === '(') { if (depth === 0) start = i + 1; depth++; }
      else if (content[i] === ')') { depth--; if (depth === 0) return { args: content.slice(start, i), end: i + 1 }; }
      i++;
    }
    return { args: '', end: i };
  }

  _findNextBrace(content, from) {
    for (let i = from; i < content.length; i++) {
      if (content[i] === '{') return i;
    }
    return -1;
  }

  _extractPrefixFromArgs(args) {
    const m = /['"]prefix['"]\s*=>\s*['"]([^'"]+)['"]/.exec(args);
    return m ? m[1] : '';
  }

  // ── Controller resolver ────────────────────────────────────────────────────

  async _resolveControllerView(projectPath, controllerClass, method) {
    const dirs = ['app/Http/Controllers', 'app/Http/Controllers/Frontend', 'app/Http/Controllers/Admin'];
    for (const dir of dirs) {
      try {
        const content = await fs.readFile(path.join(projectPath, dir, `${controllerClass}.php`), 'utf-8');
        return this._extractViewFromMethod(content, method);
      } catch { /* not here */ }
    }
    try {
      const found = await this._findFile(path.join(projectPath, 'app/Http/Controllers'), `${controllerClass}.php`);
      if (found) {
        const content = await fs.readFile(found, 'utf-8');
        return this._extractViewFromMethod(content, method);
      }
    } catch {}
    return null;
  }

  async _findFile(dir, filename) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { const f = await this._findFile(fp, filename); if (f) return f; }
        else if (e.name === filename) return fp;
      }
    } catch {}
    return null;
  }

  _extractViewFromMethod(content, method) {
    const re = new RegExp(`function\\s+${method}\\s*\\([^)]*\\)[^{]*\\{`, 's');
    const start = re.exec(content);
    if (!start) return null;
    // Extract method body via balanced braces
    const body = this._extractBlock(content, start.index + start[0].length - 1);
    return body ? this._extractViewFromBody(body) : null;
  }

  _extractViewFromBody(body) {
    const m = /\breturn\s+view\s*\(\s*['"]([^'"]+)['"]/.exec(body);
    return m ? m[1] : null;
  }

  _extractBlock(str, openBraceIdx) {
    let depth = 0, start = -1;
    for (let i = openBraceIdx; i < str.length; i++) {
      if (str[i] === '{') { if (depth === 0) start = i + 1; depth++; }
      else if (str[i] === '}') { depth--; if (depth === 0) return str.slice(start, i); }
    }
    return null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _normPath(pageUrl) {
    if (!pageUrl) return '/';
    const p = pageUrl.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '').replace(/\/$/, '');
    return p || '/';
  }

  _joinPrefix(prefix, segment) {
    if (!segment || segment === '/') return prefix || '/';
    const p = ('/' + (prefix || '') + '/' + segment).replace(/\/+/g, '/');
    return p === '/' ? '/' : p.replace(/\/$/, '');
  }

  _matchPattern(pattern, url) {
    const re = new RegExp('^' + pattern.replace(/\{[^}]+\??\}/g, '[^/]+').replace(/\//g, '\\/') + '$');
    return re.test(url);
  }

  _toResult(projectPath, viewName) {
    const rel = 'resources/views/' + viewName.replace(/\./g, '/') + '.blade.php';
    return { blade_file: rel, abs_path: path.join(projectPath, rel) };
  }
}

module.exports = new RouteResolver();
