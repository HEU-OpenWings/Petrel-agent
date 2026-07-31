# build context 是仓库根目录
FROM node:24-alpine AS base
RUN corepack enable pnpm
WORKDIR /app
ENV TZ=Asia/Shanghai

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# 开发镜像：源码由 compose 挂载进来，vite 自带轮询监听
FROM deps AS development
ENV NODE_ENV=development
COPY . .
RUN pnpm install --offline --frozen-lockfile
WORKDIR /app/apps/web
EXPOSE 5173

FROM deps AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @petrel/web run build

FROM nginx:alpine AS production
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY apps/web/docker/nginx/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
