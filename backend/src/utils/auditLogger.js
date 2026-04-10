const { sequelize } = require('../config/database');
const logger = require('./logger');

async function log(data) {
  try {
    const {
      change_request_id = null,
      user_id = null,
      action,
      entity_type = null,
      entity_id = null,
      old_value = null,
      new_value = null,
      ip_address = null,
      user_agent = null
    } = data;

    await sequelize.query(
      `INSERT INTO audit_logs
       (change_request_id, user_id, action, entity_type, entity_id,
        old_value, new_value, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      {
        bind: [
          change_request_id,
          user_id,
          action,
          entity_type,
          entity_id,
          old_value ? JSON.stringify(old_value) : null,
          new_value ? JSON.stringify(new_value) : null,
          ip_address,
          user_agent
        ]
      }
    );

    logger.info('Audit log created', { action, user_id });
  } catch (error) {
    logger.error('Failed to create audit log', { error: error.message, data });
  }
}

module.exports = { log };
