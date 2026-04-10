const Docker = require('dockerode');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const logger = require('../utils/logger');

const execAsync = promisify(exec);
const BASE_PATH = process.env.STAGING_BASE_PATH || path.join(__dirname, '../../../staging');

class DockerStagingService {
  constructor() {
    this.docker = new Docker();
    this.stagingDomain = process.env.STAGING_DOMAIN || 'localhost';
  }

  async createStagingEnvironment(changeRequestId, projectPath, generatedFiles) {
    const envId = changeRequestId.substring(0, 8);
    const workDir = path.join(BASE_PATH, envId);

    logger.info('Creating staging environment', { envId, workDir });

    try {
      await fs.mkdir(workDir, { recursive: true });
      await this._copyProject(projectPath, workDir);

      for (const file of generatedFiles) {
        await this._applyFileChange(workDir, file);
      }

      await this._createEnvFile(workDir, envId);
      const container = await this._startContainer(envId, workDir);
      await this._waitForContainer(container.id);
      await this._setupLaravel(container.id);

      const url = `http://localhost`;

      logger.info('Staging environment created', { url, containerId: container.id });

      return {
        containerId: container.id,
        containerName: `staging-${envId}`,
        url,
        workDir
      };
    } catch (error) {
      logger.error('Failed to create staging environment', { error: error.message, envId });
      await this._cleanup(envId);
      throw error;
    }
  }

  async _copyProject(source, destination) {
    logger.info('Copying project files', { source, destination });
    await execAsync(`cp -r ${source}/. ${destination}/`);
    await execAsync(`rm -rf ${destination}/.git`).catch(() => {});
  }

  async _applyFileChange(workDir, fileData) {
    const filePath = path.join(workDir, fileData.file_path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, fileData.generated_content, 'utf-8');
    logger.info('Applied file change', { file: fileData.file_path });
  }

  async _createEnvFile(workDir, envId) {
    const envContent = `APP_NAME=Laravel
APP_ENV=staging
APP_KEY=base64:${Buffer.from(envId.repeat(4)).toString('base64')}
APP_DEBUG=true
APP_URL=http://localhost

LOG_CHANNEL=stack

DB_CONNECTION=sqlite
DB_DATABASE=${workDir}/database/database.sqlite

CACHE_DRIVER=file
QUEUE_CONNECTION=sync
SESSION_DRIVER=file

MAIL_MAILER=log
`;
    await fs.writeFile(path.join(workDir, '.env'), envContent, 'utf-8');
    await fs.mkdir(path.join(workDir, 'database'), { recursive: true });
    await fs.writeFile(path.join(workDir, 'database/database.sqlite'), '');
  }

  async _startContainer(envId, workDir) {
    logger.info('Starting Docker container', { envId });

    const container = await this.docker.createContainer({
      Image: 'php:8.2-apache',
      name: `staging-${envId}`,
      Env: ['APACHE_DOCUMENT_ROOT=/var/www/html/public'],
      ExposedPorts: { '80/tcp': {} },
      HostConfig: {
        Binds: [`${workDir}:/var/www/html:rw`],
        PortBindings: { '80/tcp': [{ HostPort: '0' }] }
      },
      Labels: {
        'ai-sdlc.env-id': envId,
        'ai-sdlc.type': 'staging'
      }
    });

    await container.start();
    return container;
  }

  async _waitForContainer(containerId, maxRetries = 30) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const container = this.docker.getContainer(containerId);
        const info = await container.inspect();
        if (info.State.Running) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          return true;
        }
      } catch (error) {
        // Continue waiting
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Container failed to start');
  }

  async _setupLaravel(containerId) {
    logger.info('Setting up Laravel', { containerId });
    const container = this.docker.getContainer(containerId);

    await this._execInContainer(container, ['composer', 'install', '--no-interaction', '--prefer-dist']);
    await this._execInContainer(container, ['php', 'artisan', 'migrate', '--force']);
    await this._execInContainer(container, ['php', 'artisan', 'config:cache']);
    await this._execInContainer(container, [
      'chown', '-R', 'www-data:www-data',
      '/var/www/html/storage',
      '/var/www/html/bootstrap/cache'
    ]);

    logger.info('Laravel setup complete');
  }

  async _execInContainer(container, cmd) {
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true
    });

    const stream = await exec.start();

    return new Promise((resolve, reject) => {
      let output = '';
      stream.on('data', (chunk) => { output += chunk.toString(); });
      stream.on('end', () => resolve(output));
      stream.on('error', reject);
    });
  }

  async _cleanup(envId) {
    try {
      const containerName = `staging-${envId}`;
      const container = this.docker.getContainer(containerName);
      await container.stop().catch(() => {});
      await container.remove().catch(() => {});

      const workDir = path.join(BASE_PATH, envId);
      await fs.rm(workDir, { recursive: true, force: true });

      logger.info('Staging environment cleaned up', { envId });
    } catch (error) {
      logger.error('Cleanup failed', { error: error.message, envId });
    }
  }

  async getContainerLogs(containerId, tail = 100) {
    const container = this.docker.getContainer(containerId);
    const logs = await container.logs({ stdout: true, stderr: true, tail });
    return logs.toString();
  }
}

module.exports = new DockerStagingService();
