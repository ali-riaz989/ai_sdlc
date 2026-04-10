const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { validateChangeRequest } = require('../middleware/validation');
const changeRequestController = require('../controllers/changeRequestController');
const quickChangeController = require('../controllers/quickChangeController');
const { sequelize } = require('../config/database');

const router = express.Router();

// Tier 1/2 fast path — tried first by frontend
router.post('/quick', authenticateToken, (req, res, next) =>
  quickChangeController.handle(req, res, next)
);

router.post('/', authenticateToken, validateChangeRequest, (req, res, next) =>
  changeRequestController.create(req, res, next)
);

router.get('/', authenticateToken, (req, res, next) =>
  changeRequestController.list(req, res, next)
);

router.get('/:id', authenticateToken, (req, res, next) =>
  changeRequestController.getById(req, res, next)
);

// Accept — files are already on disk from the preview step, just mark as accepted
router.post('/:id/apply', authenticateToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const [requests] = await sequelize.query(
      'SELECT cr.*, p.project_url FROM change_requests cr JOIN projects p ON cr.project_id = p.id WHERE cr.id = $1',
      { bind: [id] }
    );
    if (!requests.length) return res.status(404).json({ error: 'Not found' });
    const cr = requests[0];
    if (cr.status !== 'pending_review') return res.status(400).json({ error: 'Not in pending_review state' });

    const io = req.app.get('io');
    const emit = (status, message) => {
      if (io) io.to(`cr-${id}`).emit(`change-request:${id}`, { status, message });
    };

    await sequelize.query("UPDATE change_requests SET status = 'review', updated_at = NOW() WHERE id = $1", { bind: [id] });
    emit('review', `Changes accepted`);
    res.json({ message: 'Accepted' });
  } catch (error) {
    next(error);
  }
});

// Restore a change request's files to their original content (DB-based undo, no git)
router.post('/:id/restore', authenticateToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const [requests] = await sequelize.query(
      'SELECT cr.*, p.local_path FROM change_requests cr JOIN projects p ON cr.project_id = p.id WHERE cr.id = $1',
      { bind: [id] }
    );
    if (!requests.length) return res.status(404).json({ error: 'Not found' });
    const cr = requests[0];
    if (cr.status !== 'review') return res.status(400).json({ error: 'Can only restore applied changes' });

    const [files] = await sequelize.query(
      'SELECT file_path, original_content FROM generated_code WHERE change_request_id = $1',
      { bind: [id] }
    );

    const fsp = require('fs').promises;
    const nodePath = require('path');
    for (const file of files) {
      if (file.original_content != null) {
        await fsp.writeFile(nodePath.join(cr.local_path, file.file_path), file.original_content, 'utf-8');
      }
    }

    await new Promise(resolve => require('child_process').exec('php artisan view:clear', { cwd: cr.local_path }, () => resolve()));
    await sequelize.query("UPDATE change_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1", { bind: [id] });

    const io = req.app.get('io');
    if (io) io.to(`cr-${id}`).emit(`change-request:${id}`, { status: 'rejected', message: 'Change restored to original' });

    res.json({ message: 'Restored to original' });
  } catch (error) {
    next(error);
  }
});

// Reject — restore original files from DB since the preview wrote them to disk
router.post('/:id/reject', authenticateToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const [requests] = await sequelize.query(
      'SELECT cr.*, p.local_path FROM change_requests cr JOIN projects p ON cr.project_id = p.id WHERE cr.id = $1',
      { bind: [id] }
    );
    if (!requests.length) return res.status(404).json({ error: 'Not found' });
    const cr = requests[0];

    // Restore originals
    const [files] = await sequelize.query(
      'SELECT file_path, original_content FROM generated_code WHERE change_request_id = $1',
      { bind: [id] }
    );
    const fsp = require('fs').promises;
    const nodePath = require('path');
    for (const file of files) {
      if (file.original_content != null) {
        await fsp.writeFile(nodePath.join(cr.local_path, file.file_path), file.original_content, 'utf-8');
      }
    }
    await new Promise(resolve => require('child_process').exec('php artisan view:clear', { cwd: cr.local_path }, () => resolve()));

    await sequelize.query("UPDATE change_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1", { bind: [id] });
    const io = req.app.get('io');
    if (io) io.to(`cr-${id}`).emit(`change-request:${id}`, { status: 'rejected', message: 'Change rejected — files restored' });
    res.json({ message: 'Rejected and restored' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
