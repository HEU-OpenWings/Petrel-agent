# petrel-agent

Petrel 智能体平台。TypeScript monorepo，agent 内核用 [pi](https://github.com/earendil-works/pi)，
前端 Vue 3，一条命令起全栈。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 运行时 | Node 24 · pnpm workspace |
| Agent | `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` |
| 后端 | Hono + @hono/node-server · pino · Biome · vitest |
| 前端 | Vue 3 + Vite + Ant Design Vue + pinia（样式 less，图标 lucide-vue-next） |

## 快速开始

```bash
cp .env.template .env   # 对话功能需要填 SILICONFLOW_API_KEY
docker compose up -d
```

- 前端 http://localhost:5173/agent
- 后端 http://localhost:5050/api/system/health

```bash
docker logs petrel-api-dev --tail 100
docker logs petrel-web-dev --tail 100
```

> **改了 `.env` 要用 `docker compose up -d`，不能用 `restart`**。容器的环境变量在创建时固定，
> `restart` 不重新加载 `env_file`。源码有热重载，环境变量没有。

宿主机可以跑构建与检查，但**不要在宿主机起前端 dev server**，统一走 compose：

```bash
pnpm install
pnpm run build       # 后端 tsc + 前端 vite，一次跑完
pnpm run typecheck
pnpm run lint        # Biome，当前不含 apps/web
pnpm run test
pnpm run dev         # 仅后端，宿主机调试用
```

## 目录

```
petrel-agent/
├─ apps/
│  ├─ api/                     # Hono HTTP 应用（@petrel/api）
│  │  └─ src/http/routes/      # system · chat（SSE）
│  └─ web/                     # Vue 3 前端（@petrel/web）
│     └─ src/
│        ├─ composables/useAgentStream.js   # AgentEvent → 消息状态归约
│        ├─ components/chat/                # 对话流与工具调用渲染
│        └─ views/ChatView.vue
├─ packages/
│  ├─ agent-core/              # pi Agent 装配与内置工具（@petrel/agent-core）
│  ├─ ai/                      # 模型 provider 注册（@petrel/ai）
│  ├─ config/                  # 环境配置；全仓唯一读取 process.env（@petrel/config）
│  └─ logger/                  # pino 日志与请求日志（@petrel/logger）
├─ docs/                       # backend-plan.md · frontend-plan.md
├─ pnpm-workspace.yaml
└─ tsconfig.base.json
```

依赖方向固定为 `apps → packages`，package 之间只允许指向更底层的 package。当前是
`api → agent-core → ai → config` 与 `api → logger → config`。

**pi 的接线只出现在 `agent-core` 与 `ai`**，上层只依赖 `createAgent()` 与 Agent 的事件流，
将来换 agent 内核不影响 HTTP 层与前端。

`agent-core` 的测试用 pi 自带的 faux provider 跑真实 agent loop，不需要模型凭据。

后续 package（`knowledge` · `database` · 前后端共享的 `contracts` 等）在对应业务首次落地时
创建，不提前维护空 package。

## 对话接口

`POST /api/chat` 返回 SSE，事件体是 pi 的 `AgentEvent` 原样透传：

```bash
curl -N -X POST http://localhost:5050/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"现在几点"}'
```

## 文档

- [docs/backend-plan.md](docs/backend-plan.md) — 后端计划、pi 事件契约、踩坑记录
- [docs/frontend-plan.md](docs/frontend-plan.md) — 前端计划、组件处置清单、与后端的契约

本仓库由 `agent-server` 与 `agent-web` 两个仓库合并而来，合并前的历史在那两个仓库里。
