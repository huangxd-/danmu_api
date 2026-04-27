# 使用官方 Node.js 22 轻量版镜像作为基础镜像
FROM node:22-alpine

# 设置工作目录为项目根目录
WORKDIR /app

# 复制 package.json 和 package-lock.json（如果存在）
COPY package*.json ./

# 安装项目依赖
RUN npm install

# 复制所有源代码
COPY danmu_api/ ./danmu_api/
COPY config/ ./config_example/

# 暴露端口
EXPOSE 9321

# 启动命令
CMD ["node", "danmu_api/server.js"]
