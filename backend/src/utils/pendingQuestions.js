// Map of projectId → { resolve, timeout }
// Used to await interactive answers from the frontend during setup
const pending = new Map();

module.exports = pending;
