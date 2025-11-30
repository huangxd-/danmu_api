import { globals } from '../globals.js';
import { log } from "../../utils/log-util.js";

// =====================
// 环境变量处理基类
// =====================

export default class BaseHandler {
  constructor() {
    // 构造函数，初始化通用配置
  }

  // 更新本地环境变量
  updateLocalEnv(key, value) {
    // 立即更新 (避免重新加载文件的开销)
    if (typeof globals.env !== 'undefined') {
      globals.env[key] = value;
    } else if (typeof process !== 'undefined') {
      process.env[key] = value;
    }

    // 重新初始化全局配置
    globals.reInit();

    log("info", `[server] ✓ Environment variable updated successfully: ${key}`);
    return true;
  }


  delLocalEnv(key) {
    // 删除
    if (typeof globals.env !== 'undefined' && globals.env[key]) {
      delete globals.env[key];
    } else if (typeof process !== 'undefined' && process.env?.[key]) {
      delete process.env[key];
    }

    // 重新初始化全局配置
    globals.reInit();

    log("info", `[server] ✓ Environment variable deleted successfully: ${key}`);
    return true;
  }

  // 获取所有环境变量
  getAllEnv() {
    // 获取原始环境变量
    const originalEnvVars = globals.originalEnvVars;
    
    // 获取环境变量配置信息
    const envVarConfig = globals.envVarConfig;
    
    // 构建带类型信息的环境变量对象
    const envWithTypes = {};
    
    // 遍历所有环境变量
    for (const [key, value] of Object.entries(originalEnvVars)) {
      // 获取该环境变量的配置信息
      const config = envVarConfig[key] || { category: 'system', type: 'text', description: '未分类配置项' };
      
      // 构建带类型信息的对象
      envWithTypes[key] = {
        value: value,
        category: config.category,
        type: config.type,
        description: config.description,
        options: config.options // 仅对 select 和 multi-select 类型有效
      };
    }
    
    return envWithTypes;
  }

  // 获取某个环境变量
  getEnv(key) {
    return this.getAllEnv()[key];
  }

  // 设置环境变量的值
  async setEnv(key, value) {
    throw new Error("Method 'setEnv' must be implemented");
  }

  // 添加环境变量
  async addEnv(key, value) {
    throw new Error("Method 'addEnv' must be implemented");
  }

  // 删除环境变量
  async delEnv(key) {
    throw new Error("Method 'delEnv' must be implemented");
  }

  // 校验必填参数
  async checkParams(accountId, projectId, token) {
    throw new Error("Method 'checkParams' must be implemented");
  }

  // 部署
  async deploy(accountId, projectId, token) {
    throw new Error("Method 'deploy' must be implemented");
  }
}
