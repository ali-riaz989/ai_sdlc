const fs = require('fs').promises;
const path = require('path');

async function scanIncludes(bladeAbsPath, projectPath, maxDepth = 1) {
  const results = [];
  const seen = new Set([bladeAbsPath]);
  await _scan(bladeAbsPath, projectPath, results, seen, 0, maxDepth);
  return results;
}

async function _scan(absPath, projectPath, results, seen, depth, maxDepth) {
  if (depth > maxDepth) return;
  let content;
  try { content = await fs.readFile(absPath, 'utf-8'); } catch { return; }

  const refs = new Set();
  const patterns = [
    /@(?:extends|include|includeIf|includeWhen|includeFirst|component)\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(content)) !== null) refs.add(m[1]);
  }

  for (const ref of refs) {
    const relPath = 'resources/views/' + ref.replace(/\./g, '/') + '.blade.php';
    const abs = path.join(projectPath, relPath);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      const fileContent = await fs.readFile(abs, 'utf-8');
      results.push({ relative_path: relPath, content: fileContent.substring(0, 4000) });
      await _scan(abs, projectPath, results, seen, depth + 1, maxDepth);
    } catch {}
  }
}

module.exports = { scanIncludes };
