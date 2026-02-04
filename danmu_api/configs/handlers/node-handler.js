import BaseHandler from "./base-handler.js";
import { log } from "../../utils/log-util.js";
import fs from 'fs';
import path from 'path';
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

    const envPath = path.join(__dirname, '..', '..', '..', 'config', '.env');

    const envExists = fs.existsSync(envPath);

    if (!envExists) {
      throw new Error('.env not found');
    }

    let updated = false;

    try {
      // 特殊处理 BLOCKED_WORDS：对值添加双引号并对反斜杠进行转义
      let processedValue = value;
      if (key === 'BLOCKED_WORDS') {
        // 如果值不是以双引号开头和结尾，则添加双引号
        if (!processedValue.startsWith('"') && !processedValue.endsWith('"')) {
          processedValue = `"${processedValue}"`;
        }
      }

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
              lines[i] = `${key}=${processedValue}`;
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
          lines.push(`${key}=${processedValue}`);
        }

        fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
        log("info", `[server] Updated ${key} in .env`);
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

    const envPath = path.join(__dirname, '..', '..', '..', 'config', '.env');

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

      if (deleted) {
        return this.delLocalEnv(key);
      }

      return false;
    } catch (error) {
      log("error", '[server] ✗ Failed to delete environment variable:', error.message);
    }
  }
}
