/**
 * Handler工厂类 - 根据部署平台返回相应的Handler实例
 */
export class HandlerFactory {
  static async getHandler(deployPlatform) {
    switch (deployPlatform?.toLowerCase()) {
      case 'cloudflare':
        const { CloudflareHandler } = await import('./cloudflare-handler.js');
        return new CloudflareHandler();
      case 'vercel':
        const { VercelHandler } = await import('./vercel-handler.js');
        return new VercelHandler();
      case 'netlify':
        const { NetlifyHandler } = await import('./netlify-handler.js');
        return new NetlifyHandler();
      case 'edgeone':
        const { EdgeoneHandler } = await import('./edgeone-handler.js');
        return new EdgeoneHandler();
      case 'node':
        const { NodeHandler } = await import(['./node-handler', '.js'].join(''));
        return new NodeHandler();
      default:
        // 默认返回NodeHandler，适用于本地开发或无法识别的平台
        const { NodeHandler: DefaultNodeHandler } = await import(['./node-handler', '.js'].join(''));
        return new DefaultNodeHandler();
    }
  }

  /**
   * 获取所有支持的平台列表
   */
  static getSupportedPlatforms() {
    return ['cloudflare', 'vercel', 'netlify', 'edgeone', 'node'];
  }
}
