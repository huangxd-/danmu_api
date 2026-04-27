FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY danmu_api/ ./danmu_api/
COPY config/ ./config/

EXPOSE 9321

ENV PORT=9321
ENV HOST=0.0.0.0

CMD ["node", "danmu_api/server.js"]
