import { jsonResponse } from '../utils/http-util.js';
import { HandlerFactory } from '../configs/handlers/handler-factory.js';
import { globals } from '../configs/globals.js';
import AIClient from '../utils/ai-util.js';

/**
 * 处理设置环境变量的请求
 */
export async function handleSetEnv(request) {
  try {
    const { key, value } = await request.json();
    
    if (!key) {
      return jsonResponse({ success: false, message: '缺少环境变量名称' }, 400);
    }

    // 获取当前部署平台
    const deployPlatform = globals.deployPlatform;
    
    // 根据部署平台获取相应的handler
    const handler = await HandlerFactory.getHandler(deployPlatform);
    
    // 调用handler的setEnv方法
    const result = await handler.setEnv(key, value);
    
    if (result) {
      return jsonResponse({ success: true, message: `环境变量 ${key} 设置成功` });
    } else {
      return jsonResponse({ success: false, message: `环境变量 ${key} 设置失败` }, 500);
    }
  } catch (error) {
    console.error('设置环境变量失败:', error);
    return jsonResponse({ success: false, message: `设置环境变量失败: ${error.message}` }, 500);
  }
}

/**
 * 处理添加环境变量的请求
 */
export async function handleAddEnv(request) {
  try {
    const { key, value } = await request.json();
    
    if (!key) {
      return jsonResponse({ success: false, message: '缺少环境变量名称' }, 400);
    }

    // 获取当前部署平台
    const deployPlatform = globals.deployPlatform ;
    
    // 根据部署平台获取相应的handler
    const handler = await HandlerFactory.getHandler(deployPlatform);
    
    // 调用handler的addEnv方法
    const result = await handler.addEnv(key, value);
    
    if (result) {
      return jsonResponse({ success: true, message: `环境变量 ${key} 添加成功` });
    } else {
      return jsonResponse({ success: false, message: `环境变量 ${key} 添加失败` }, 500);
    }
  } catch (error) {
    console.error('添加环境变量失败:', error);
    return jsonResponse({ success: false, message: `添加环境变量失败: ${error.message}` }, 500);
  }
}

/**
 * 处理删除环境变量的请求
 */
export async function handleDelEnv(request) {
  try {
    const { key } = await request.json();
    
    if (!key) {
      return jsonResponse({ success: false, message: '缺少环境变量名称' }, 400);
    }

    // 获取当前部署平台
    const deployPlatform = globals.deployPlatform;
    
    // 根据部署平台获取相应的handler
    const handler = await HandlerFactory.getHandler(deployPlatform);
    
    // 调用handler的delEnv方法
    const result = await handler.delEnv(key);
    
    if (result) {
      return jsonResponse({ success: true, message: `环境变量 ${key} 删除成功` });
    } else {
      return jsonResponse({ success: false, message: `环境变量 ${key} 删除失败` }, 500);
    }
  } catch (error) {
    console.error('删除环境变量失败:', error);
    return jsonResponse({ success: false, message: `删除环境变量失败: ${error.message}` }, 500);
  }
}

/**
 * 处理AI连通性验证请求
 */
export async function handleAiVerify(request) {
  try {
    const body = await request.json();
    
    // 从请求体获取配置，如果没有则使用全局配置
    const aiBaseUrl = body.aiBaseUrl || globals.aiBaseUrl || 'https://api.openai.com/v1';
    const aiModel = body.aiModel || globals.aiModel || 'gpt-4o';
    const aiApiKey = body.aiApiKey || globals.aiApiKey;
    
    if (!aiApiKey) {
      return jsonResponse({ 
        success: false, 
        ok: false,
        message: 'AI_API_KEY 未配置' 
      }, 400);
    }
    
    // 创建 AI 客户端
    const ai = new AIClient({
      baseURL: aiBaseUrl,
      model: aiModel,
      apiKey: aiApiKey,
      systemPrompt: '回答尽量简洁',
    });
    
    // 执行验证
    const status = await ai.verify();
    
    if (status.ok) {
      return jsonResponse({ 
        success: true, 
        ok: true,
        message: 'AI 服务连通性测试成功' 
      });
    } else {
      return jsonResponse({ 
        success: false, 
        ok: false,
        message: `AI 服务连通性测试失败: ${status.error}` 
      }, 200);
    }
  } catch (error) {
    console.error('AI 连通性验证失败:', error);
    return jsonResponse({ 
      success: false, 
      ok: false,
      message: `AI 连通性验证失败: ${error.message}` 
    }, 500);
  }
}
