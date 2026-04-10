function validateChangeRequest(req, res, next) {
  const { project_id, title, prompt } = req.body;

  if (!project_id || typeof project_id !== 'string') {
    return res.status(400).json({ error: 'project_id is required' });
  }
  if (!title || title.trim().length === 0) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (!prompt || prompt.trim().length < 10) {
    return res.status(400).json({ error: 'prompt must be at least 10 characters' });
  }
  if (prompt.length > 5000) {
    return res.status(400).json({ error: 'prompt must not exceed 5000 characters' });
  }

  next();
}

function validateProject(req, res, next) {
  const { name, display_name, repo_url } = req.body;

  if (!name || !/^[a-z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: 'name must be lowercase alphanumeric with hyphens/underscores' });
  }
  if (!display_name || display_name.trim().length === 0) {
    return res.status(400).json({ error: 'display_name is required' });
  }
  if (!repo_url || repo_url.trim().length === 0) {
    return res.status(400).json({ error: 'repo_url is required' });
  }

  next();
}

module.exports = { validateChangeRequest, validateProject };
