# build context 是仓库根目录
FROM node:24-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

# pnpm fetch 只依据 lockfile 预取依赖到 store。
# 好处：新增 package 时不需要回来改这个文件（逐个 COPY package.json 的写法漏改过一次，
# 表现为容器启动即崩 Cannot find package）。
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# 开发镜像：源码由 compose 挂载进来，nodemon 轮询提供热重载
FROM deps AS development
ENV NODE_ENV=development
COPY . .
RUN pnpm install --offline --frozen-lockfile
CMD ["pnpm", "dev"]

FROM deps AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @petrel/server... run build

FROM base AS production
ENV NODE_ENV=production
COPY --from=build /app ./
CMD ["pnpm", "start"]
