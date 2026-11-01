FROM node:18-alpine

WORKDIR /app

# 本网关为 0 第三方依赖架构，仅使用 Node.js 原生标准库，无需 npm install
COPY package.json ./
COPY src/ ./src/
COPY gateway.mjs ./
COPY config.example.json ./
COPY accounts.example.json ./

EXPOSE 8317

ENV NODE_ENV=production

CMD ["node", "gateway.mjs"]
