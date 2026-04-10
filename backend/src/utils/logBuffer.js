// In-memory log buffer per project (last 500 lines)
// Lets late WebSocket subscribers catch up on missed output
const buffers = new Map();

module.exports = {
  push(projectId, entry) {
    if (!buffers.has(projectId)) buffers.set(projectId, []);
    const buf = buffers.get(projectId);
    buf.push(entry);
    if (buf.length > 500) buf.shift();
  },
  get(projectId) {
    return buffers.get(projectId) || [];
  },
  clear(projectId) {
    buffers.delete(projectId);
  }
};
