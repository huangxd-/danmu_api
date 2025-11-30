import { CloudflareHandler } from './cloudflare-handler.js';
import { VercelHandler } from './vercel-handler.js';
import { NetlifyHandler } from './netlify-handler.js';
import { EdgeoneHandler } from './edgeone-handler.js';
import { NodeHandler } from './node-handler.js';

/**
 * Handler工厂类 - 根据部署平台返回相应的Handler实例
 */
export class HandlerFactory {
  static getHandler(deployPlatform) {
    switch (deployPlatform?.toLowerCase()) {
      case 'cloudflare':
        return new CloudflareHandler();
      case 'vercel':
        return new VercelHandler();
      case 'netlify':
        return new NetlifyHandler();
      case 'edgeone':
        return new EdgeoneHandler();
      case 'node':
      case 'docker':
        return new NodeHandler();
      default:
        // 默认返回NodeHandler，适用于本地开发或无法识别的平台
        return new NodeHandler();
    }
  }

  /**
   * 获取所有支持的平台列表
   */
  static getSupportedPlatforms() {
    return ['cloudflare', 'vercel', 'netlify', 'edgeone', 'node'];
  }
}
