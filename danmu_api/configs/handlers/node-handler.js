import BaseHandler from "./base-handler.js";
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';

// =====================
// Node环境变量处理类
// =====================

export class NodeHandler extends BaseHandler {
  // 在本地配置文件中设置环境变量
  updateConfigValue(key, value) {
    // 在 ES6 模块中获取 __dirname 和 __filename
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const envPath = path.join(__dirname, '..', '..', '..', '.env');
    const yamlPath = path.join(__dirname, '..', '..', '..', 'config.yaml');

    const envExists = fs.existsSync(envPath);
    const yamlExists = fs.existsSync(yamlPath);

    if (!envExists && !yamlExists) {
      throw new Error('Neither .env nor config.yaml found');
    }

    let updated = false;

    try {
      // 更新 .env 文件
      if (envExists) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const lines = envContent.split('\n');
        let keyFound = false;

        // 查找并更新现有键
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          if (trimmed && !trimmed.startsWith('#')) {
            const match = trimmed.match(/^([^=]+)=/);
            if (match && match[1] === key) {
              lines[i] = `${key}=${value}`;
              keyFound = true;
              break;
            }
          }
        }

        // 如果键不存在，添加到文件末尾
        if (!keyFound) {
          // 确保文件末尾有换行符
          if (lines[lines.length - 1] !== '') {
            lines.push('');
          }
          lines.push(`${key}=${value}`);
        }

        fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
        console.log(`[server] Updated ${key} in .env`);
        updated = true;
      }

      // 更新 config.yaml 文件
      if (yamlExists) {
        const yamlContent = fs.readFileSync(yamlPath, 'utf8');
        const yamlConfig = yaml.parse(yamlContent) || {};

        // 将扁平的环境变量键转换为嵌套对象路径
        // 例如: API_KEY -> apiKey, DATABASE_HOST -> database.host
        const keys = key.toLowerCase().split('_');
        let current = yamlConfig;

        // 遍历到倒数第二层
        for (let i = 0; i < keys.length - 1; i++) {
          const k = keys[i];
          if (!current[k] || typeof current[k] !== 'object') {
            current[k] = {};
          }
          current = current[k];
        }

        // 设置最后一层的值
        const lastKey = keys[keys.length - 1];
        current[lastKey] = value;

        // 写回文件
        fs.writeFileSync(yamlPath, yaml.stringify(yamlConfig), 'utf8');
        console.log(`[server] Updated ${key} in config.yaml`);
        updated = true;
      }

      if (updated) {
        // 更新 process.env
        process.env[key] = value;
        console.log(`[server] Configuration updated successfully: ${key}=${value}`);
        return true;
      }

      return false;
    } catch (error) {
      console.error('[server] Error updating configuration:', error.message);
      throw error;
    }
  }

  async setEnv(key, value) {
    console.log('set env: ', key, value);
    this.updateConfigValue(key, value);
  }
}