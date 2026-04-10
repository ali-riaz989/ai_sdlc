const { execFile } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

async function validatePhpSyntax(content) {
  const tmpPath = path.join('/tmp', `blade_check_${crypto.randomUUID()}.php`);
  try {
    await fs.writeFile(tmpPath, content, 'utf-8');
    return await new Promise(resolve => {
      execFile('php', ['-l', tmpPath], (err, stdout, stderr) => {
        const output = (stdout + stderr).trim();
        resolve({ valid: !err, output });
      });
    });
  } finally {
    await fs.rm(tmpPath).catch(() => {});
  }
}

module.exports = { validatePhpSyntax };
