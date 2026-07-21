FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY tsconfig.json tsup.config.ts ./
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
# 使用阿里云 apk 源加速安装
RUN sed -i 's#dl-cdn.alpinelinux.org#mirrors.aliyun.com#g' /etc/apk/repositories
# 常用网络调试工具：curl/wget、dig/nslookup、ss/ip、nc
RUN apk add --no-cache curl wget bind-tools iproute2 netcat-openbsd
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/logs && chown -R node:node /app/logs
ENV NODE_ENV=production PORT=12345
USER node
EXPOSE 12345
CMD ["node", "dist/index.js", "--port", "12345", "--host", "0.0.0.0"]
