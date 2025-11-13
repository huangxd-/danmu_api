import BaseHandler from "./base-handler.js";
import { log } from "../../utils/log-util.js";
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

// =====================
// Node环境变量处理类
// =====================

export class NodeHandler extends BaseHandler {
  /**
   * 在本地配置文件中设置环境变量
   */
  updateConfigValue(key, value) {
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
            if (match && match[1].trim() === key) {
              lines[i] = `${key}=${value}`;
              keyFound = true;
              break;
            }
          }
        }

        // 如果键不存在,添加到文件末尾
        if (!keyFound) {
          if (lines[lines.length - 1] !== '') {
            lines.push('');
          }
          lines.push(`${key}=${value}`);
        }

        fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
        log("info", `[server] Updated ${key} in .env`);
        updated = true;
      }

      // 更新 config.yaml 文件
      if (yamlExists) {
        const yamlContent = fs.readFileSync(yamlPath, 'utf8');
        let yamlConfig = yaml.load(yamlContent) || {};

        // 将扁平的环境变量键转换为嵌套对象路径
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

        // 设置最后一层的值,尝试智能转换类型
        const lastKey = keys[keys.length - 1];
        let parsedValue = value;

        // 尝试转换为数字
        if (!isNaN(value) && value !== '') {
          parsedValue = Number(value);
        }
        // 尝试转换为布尔值
        else if (value === 'true') {
          parsedValue = true;
        } else if (value === 'false') {
          parsedValue = false;
        }

        current[lastKey] = parsedValue;

        // 写回文件
        fs.writeFileSync(yamlPath, yaml.dump(yamlConfig), 'utf8');
        log("info", `[server] Updated ${key} in config.yaml`);
        updated = true;
      }

      return updated;
    } catch (error) {
      log("error", '[server] Error updating configuration:', error.message);
      throw error;
    }
  }

  /**
   * 设置环境变量并重新初始化全局配置
   */
  async setEnv(key, value) {
    log("info", '[server] Setting environment variable:', key, '=', value);

    try {
      // 更新配置文件
      const updated = this.updateConfigValue(key, value);

      if (!updated) {
        throw new Error('Failed to update configuration files');
      }

      return this.updateLocalEnv(key, value);
    } catch (error) {
      log("error", '[server] ✗ Failed to set environment variable:', error.message);
    }
  }

  /**
   * 添加新的环境变量
   */
  async addEnv(key, value) {
    // addEnv 和 setEnv 在这个场景下逻辑相同
    return await this.setEnv(key, value);
  }

  /**
   * 删除环境变量
   */
  async delEnv(key) {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const envPath = path.join(__dirname, '..', '..', '..', '.env');
    const yamlPath = path.join(__dirname, '..', '..', '..', 'config.yaml');

    let deleted = false;

    try {
      // 从 .env 文件删除
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const lines = envContent.split('\n');
        const filteredLines = lines.filter(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return true;
          const match = trimmed.match(/^([^=]+)=/);
          return !(match && match[1].trim() === key);
        });

        fs.writeFileSync(envPath, filteredLines.join('\n'), 'utf8');
        log("info", `[server] Deleted ${key} from .env`);
        deleted = true;
      }

      // 从 config.yaml 文件删除
      if (fs.existsSync(yamlPath)) {
        const yamlContent = fs.readFileSync(yamlPath, 'utf8');
        let yamlConfig = yaml.load(yamlContent) || {};

        const keys = key.toLowerCase().split('_');
        let current = yamlConfig;

        // 遍历到倒数第二层
        for (let i = 0; i < keys.length - 1; i++) {
          const k = keys[i];
          if (!current[k]) return;
          current = current[k];
        }

        // 删除最后一层的键
        const lastKey = keys[keys.length - 1];
        if (current && lastKey in current) {
          delete current[lastKey];
          fs.writeFileSync(yamlPath, yaml.dump(yamlConfig), 'utf8');
          log("info", `[server] Deleted ${key} from config.yaml`);
          deleted = true;
        }
      }

      if (deleted) {
        return this.delLocalEnv(key);
      }

      return false;
    } catch (error) {
      log("error", '[server] ✗ Failed to delete environment variable:', error.message);
    }
  }
}