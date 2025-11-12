import BaseHandler from "./base-handler.js";
import { httpGet } from "../../utils/http-util.js";

// =====================
// Vercel环境变量处理类
// =====================

export class VercelHandler extends BaseHandler {
  async setEnv(key, value) {
    console.log('set env: ', key, value);
    const url = 'https://api.vercel.com/v9/projects/project_name/custom-environments/TOKEN';
    const options = {
      method: 'PATCH',
      headers: {Authorization: 'Bearer <string>', 'Content-Type': 'application/json'},
      body: '{"slug":"<string>","description":"<string>","branchMatcher":{"type":"equals","pattern":"<string>"}}'
    };
    await httpGet(url, options);
  }
}