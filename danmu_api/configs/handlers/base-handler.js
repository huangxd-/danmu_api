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
}