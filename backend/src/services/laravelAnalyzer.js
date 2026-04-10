const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

class LaravelAnalyzer {
  async analyzeProject(projectPath) {
    logger.info('Analyzing Laravel project', { projectPath });

    try {
      const analysis = {
        routes: await this._analyzeRoutes(projectPath),
        controllers: await this._analyzeControllers(projectPath),
        models: await this._analyzeModels(projectPath),
        views: await this._analyzeViews(projectPath),
        config: await this._analyzeConfig(projectPath)
      };

      logger.info('Laravel analysis complete', {
        routes: analysis.routes.length,
        controllers: analysis.controllers.length,
        models: analysis.models.length,
        views: analysis.views.length
      });

      return analysis;
    } catch (error) {
      logger.error('Laravel analysis failed', { error: error.message });
      throw error;
    }
  }

  async _analyzeRoutes(projectPath) {
    const routes = [];
    const routesPath = path.join(projectPath, 'routes');
    try {
      const files = await fs.readdir(routesPath);
      for (const file of files) {
        if (file.endsWith('.php')) {
          const filePath = path.join(routesPath, file);
          const content = await fs.readFile(filePath, 'utf-8');
          routes.push({
            file,
            path: filePath,
            content_preview: content.substring(0, 500)
          });
        }
      }
    } catch (error) {
      logger.warn('Could not analyze routes', { error: error.message });
    }
    return routes;
  }

  async _analyzeControllers(projectPath) {
    const controllers = [];
    const controllersPath = path.join(projectPath, 'app/Http/Controllers');
    try {
      const files = await this._getPhpFilesRecursive(controllersPath);
      for (const file of files) {
        controllers.push({
          name: path.basename(file, '.php'),
          path: file,
          relative_path: path.relative(projectPath, file)
        });
      }
    } catch (error) {
      logger.warn('Could not analyze controllers', { error: error.message });
    }
    return controllers;
  }

  async _analyzeModels(projectPath) {
    const models = [];
    const modelsPath = path.join(projectPath, 'app/Models');
    try {
      const files = await this._getPhpFilesRecursive(modelsPath);
      for (const file of files) {
        models.push({
          name: path.basename(file, '.php'),
          path: file,
          relative_path: path.relative(projectPath, file)
        });
      }
    } catch (error) {
      logger.warn('Could not analyze models', { error: error.message });
    }
    return models;
  }

  async _analyzeViews(projectPath) {
    const views = [];
    const viewsPath = path.join(projectPath, 'resources/views');
    try {
      const files = await this._getBladeFilesRecursive(viewsPath);
      for (const file of files) {
        views.push({
          name: path.basename(file),
          path: file,
          relative_path: path.relative(projectPath, file)
        });
      }
    } catch (error) {
      logger.warn('Could not analyze views', { error: error.message });
    }
    return views;
  }

  async _analyzeConfig(projectPath) {
    const config = {};
    const configPath = path.join(projectPath, 'config');
    try {
      const files = await fs.readdir(configPath);
      for (const file of files) {
        if (file.endsWith('.php')) {
          config[file] = path.join(configPath, file);
        }
      }
    } catch (error) {
      logger.warn('Could not analyze config', { error: error.message });
    }
    return config;
  }

  async _getPhpFilesRecursive(dir) {
    const files = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...await this._getPhpFilesRecursive(fullPath));
        } else if (entry.name.endsWith('.php')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Directory might not exist
    }
    return files;
  }

  async _getBladeFilesRecursive(dir) {
    const files = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...await this._getBladeFilesRecursive(fullPath));
        } else if (entry.name.endsWith('.blade.php')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Directory might not exist
    }
    return files;
  }
}

module.exports = new LaravelAnalyzer();
