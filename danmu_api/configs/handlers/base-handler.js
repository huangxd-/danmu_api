import { globals } from '../globals.js';

// =====================
// 环境变量处理基类
// =====================

export default class BaseHandler {
  constructor() {
    // 构造函数，初始化通用配置
  }

  // 获取所有环境变量
  getAllEnv() {
    return globals.originalEnvVars;
  }

  async getEnv(key) {
    throw new Error("Method 'getEnv' must be implemented");
  }

  async setEnv(key, value) {
    throw new Error("Method 'setEnv' must be implemented");
  }

  async addEnv(key, value) {
    throw new Error("Method 'addEnv' must be implemented");
  }

  async delEnv(key) {
    throw new Error("Method 'delEnv' must be implemented");
  }
}