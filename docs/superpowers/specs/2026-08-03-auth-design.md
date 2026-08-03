# 认证系统设计

给 `apps/api` 补上邮箱密码认证，把当前硬编码的 `DEFAULT_USER_ID` 换成真实用户，
并修掉会话链路上已经埋着的三处越权。

关联文档：[backend-plan.md](../../backend-plan.md) · [frontend-plan.md](../../frontend-plan.md)
对应 Linear issue：HEU-7（最小认证）

## 1. 背景与范围

### 为什么现在做

后端目前**没有任何认证**：`app.ts` 里 auth 只是一行注释，`services/session.ts` 把所有会话
硬挂在 `DEFAULT_USER_ID` 下。前端 `apis/http.js` 按未来契约把 token 注入与 401 处理写完整了，
但 `stores/user.js` 整个是 v0.4 Python API 的遗留，路由守卫是注释状态。

更要紧的是会话路由现在就埋着越权（见 §7.2），今天所有会话同属一个默认用户所以看不出来，
认证一落地就会暴露。所以认证与越权修复必须同一轮做完，不能只落地登录。

### 目标形态

系统面向外部开放、允许自助注册。但「对外开放」真正的前置不是认证而是**配额**——
这个系统每次对话都在烧模型额度，认证只让「谁在花钱」变得可归因，并不阻止花钱。
本轮交付后系统的真实安全状态见 §12。

### 本次范围

| 做 | 不做 |
| --- | --- |
| 邮箱密码注册 / 登录 / 登出 / me | 邮箱真实性验证（需要邮件发送基础设施） |
| JWT 存 httpOnly cookie，`requireAuth` 中间件 | 密码自助重置（同上） |
| 密码强度校验 + 登录失败限流 | 配额与 token 计量（要动 chat 链路与 agent-core） |
| `role` 列 + 最小 admin（用户列表 / 禁用用户） | 注册限流与机器人防护（要 Redis） |
| 修掉会话链路的三处越权 | OAuth / 第三方登录 |
| 前端登录注册页、守卫翻开、store 重写 | v0.4 遗留页面（知识库 / Dashboard / 评测）的修复 |

### 已确认的决策

| 决策项 | 结论 |
| --- | --- |
| 使用形态 | 对外开放，自助注册，**注册端点默认开启**（无环境变量开关） |
| 登录标识 | **邮箱 + 密码**，展示名由前端取邮箱前缀，不落库 |
| token 存储 | JWT 存 **httpOnly cookie**，`SameSite=Strict` |
| token 生命周期 | 7 天固定，不滑动，到期重新登录 |
| 认证自身防护 | 密码强度校验 + 登录失败限流；**不做账户锁定** |
| 角色模型 | `role` 列 + 最小 admin 能力（列表 / 禁用），无 superadmin 二级 |
| 首个 admin | 环境变量 `ADMIN_EMAILS`，注册与每次登录时生效 |
| 实现方式 | 自己写，**零新增依赖**，代码全部落在 `apps/api` |
| 老数据 | migration 删除 `DEFAULT_USER_ID` 及其级联会话 |

## 2. 技术选型

### 为什么不接认证框架

评估过接 Better Auth 一类的框架。它能一次性省掉本轮和未来数轮（邮箱验证、密码重置、
OAuth 都是插件），但有四笔现在就要付的代价：

1. **命名冲突**：这类框架的核心概念就叫 `session`（登录会话），而本仓 `sessions` 表
   已经是「对话会话」。两套 session 会在 schema、类型名、日志字段里长期打架。
2. 它要接管 schema 并通过 drizzle adapter 管表，现有 `users` 表和会话外键要给它让位。
3. 给一个生产依赖只有 `hono` 的包引入框架级依赖。
4. 与 pi 的 SSE 链路、cookie 策略的集成成本是未知量，要先花时间验证。

本轮真正需要的东西——注册、登录、JWT、哈希、限流、role——是 Hono 加 Node 标准库
就能覆盖的量。框架的价值要到后面几轮才兑现。将来若真要接多个 OAuth provider，
届时认证已有测试护栏，再评估迁移。

### 依赖清单：零新增

已核对 `hono@4.12.32` 的类型定义（不是凭文档记忆）：

- `hono/jwt` 导出 `sign(payload, key, alg?)` / `verify(token, key, algOrOptions)`，
  以及中间件 `jwt({ secret, cookie, alg, headerName?, verification? })`——
  `cookie` 选项存在，可直接从 cookie 取 token
- `hono/cookie` 导出 `getCookie` / `setCookie` / `deleteCookie`
- 密码哈希用 Node 内置 `node:crypto` 的 `scrypt` 与 `timingSafeEqual`

不引入 bcrypt / argon2：它们是原生模块，在 Docker + pnpm 环境下要处理编译与预编译
二进制，而 scrypt 是 OWASP 认可的密码哈希算法，Node 直接内置。

## 3. 数据模型

### `users` 表改造

```ts
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),                 // 新增：登录标识
  passwordHash: text("password_hash").notNull(),           // 新增
  role: text("role").notNull().default("user"),            // 新增：'user' | 'admin'
  disabled: boolean("disabled").notNull().default(false),  // 新增
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // username 列删除
});
```

`role` 用 `text` 而不是 pg enum：enum 加值要 migration，text 加 CHECK 或在应用层收窄
更灵活，且本仓 `messages.role` 已经是同样的处理方式。

`sessions` 与 `messages` 表结构不变。

### 邮箱大小写

**注册与登录一律先 `toLowerCase()` 再存储/查询**。否则 `A@x.com` 与 `a@x.com`
能各注册一次，`unique` 索引拦不住——这是必须写进实现的细节，不是可选优化。

### 老数据处置

migration 中删除 `DEFAULT_USER_ID` 那一行，`sessions` 的外键是 `onDelete: "cascade"`，
挂在它下面的开发期会话与消息一并删除。

理由：这条记录没有密码，永远登不进来，留着就是谁也看不见的垃圾数据。删掉之后
`DEFAULT_USER_ID` / `DEFAULT_USERNAME` 两个常量可以整个消失，`testing.ts` 的 seed
改为创建测试用户。

**代价：开发者本地现有的对话记录会全部丢失。** 这是开发期数据，已确认可接受。

### 配置项

`packages/config` 新增（仍是全仓唯一读 `process.env` 的位置）：

| 变量 | 说明 |
| --- | --- |
| `JWT_SECRET` | **生产环境缺失时启动即抛错**；开发/测试回落到固定开发密钥并打一条 warn |
| `ADMIN_EMAILS` | 逗号分隔，解析时统一小写并去空白；缺省为空列表 |

`JWT_SECRET` 绝不能有能进生产的默认值——这是 `env` 校验函数要覆盖的第一件事。
`.env.template` 同步补上这两项。

## 4. 密码哈希

存储格式：`scrypt$<salt_base64>$<hash_base64>`，参数写死在代码常量里。
校验用 `timingSafeEqual`，不用 `===`。

参数 N=2^16（65536）、r=8、p=1，keylen 64，salt 16 字节随机。

**实现时的坑**：Node 的 `scrypt` 默认 `maxmem` 是 32MB，而 N=65536、r=8 需要
`128 * N * r` = 64MB，不显式把 `maxmem` 调高会直接抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`。

密码强度：最小长度 8，不做字符类别强制（复杂度规则的实际收益低于长度，且会推动用户
写出可预测的变体）。上限 200 字符——scrypt 对超长输入没有额外成本，但挡住无意义的巨大请求体。

## 5. 认证流程

### 端点

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/api/auth/register` | `{email, password}` → 201，种 cookie，返回用户 |
| POST | `/api/auth/login` | `{email, password}` → 200，种 cookie，返回用户 |
| POST | `/api/auth/logout` | 清 cookie → 200 |
| GET | `/api/auth/me` | 返回当前用户；未登录 401 |

返回的用户对象统一为 `{ id, email, role }`，不含 `passwordHash`——这个投影在
repository 层做，不依赖每个调用点自觉，避免哪天漏掉一处就把哈希吐给前端。

`me` 不是可有可无的：token 在 httpOnly cookie 里，**前端 JS 读不到它**，
刷新页面后没有任何本地状态能回答「我是谁」。这是 cookie 方案相对 localStorage
多出来的一次往返。

### Cookie 与 JWT

- 名字 `petrel_token`
- `httpOnly: true`、`sameSite: 'Strict'`、`path: '/'`、`maxAge` 7 天
- `secure: isProduction`——**本地 `http://localhost` 下设 `secure: true`
  浏览器会静默丢弃 cookie**，表现为「登录接口返回 200 但下一个请求仍是未登录」，
  是这类方案最常见的排查陷阱
- payload 只放 `{ sub: userId, role, exp }`，算法 HS256

### requireAuth 中间件：每请求查一次库

校验 JWT 签名与过期后，**再按 `sub` 查一次用户，确认存在且 `disabled === false`**，
然后把 `{ id, email, role }` 注入 context 供下游使用。

这牺牲了 JWT 的无状态性，换来的是 admin 禁用滥用者时**立即生效**，而不是等对方 token
自然过期（最长 7 天）。对一个开放注册、每次对话都在烧模型额度的系统，7 天延迟不可接受。
顺带解决「用户已删除但 token 仍可用」。代价是每请求一次主键查询，这个规模下可忽略。

### ADMIN_EMAILS 的生效时机

**注册时和每次登录时**检查：邮箱在名单里但 `role !== 'admin'` 就提升为 admin 并落库。

这样改完 `.env` 重启，已存在的账号下次登录自动提权，不需要改库或跑脚本。
配套前提是 CLAUDE.md 里那条坑——**改 `.env` 后要 `docker compose up -d` 而不是 `restart`**。

不做反向降级：邮箱从名单里移除不会自动把 admin 降回 user，避免误编辑 `.env`
把管理权限一次性清空。降级走 admin 界面或改库。

## 6. 登录失败限流

内存 `Map`，key 是小写邮箱，value 是 `{ count, firstFailAt }`。
连续失败 5 次 → 该邮箱 15 分钟内直接返回 429，**不再校验密码**；登录成功清零。

限流的响应文案与普通登录失败一致（见 §10），不暴露「这个账号正在被攻击」。

### 两个必须记录的局限

1. **可被用来短时锁别人的账号**——故意打错 5 次，对方 15 分钟内登不上。
   这与账户锁定是同一类问题，只是轻得多（纯内存、15 分钟自动解除、不落库、重启即清）。

   之所以仍选「到阈值就不验密码」而不是「照常验密码、对了就放行」：后者会让攻击者
   能无限触发 scrypt，每次 64MB 内存，并发一拉就是内存耗尽——那是比短时锁号更严重的问题。

2. **单实例内存**，重启失效，多副本部署下形同虚设。正式修法在风控那一轮（Redis）。

计数表需要惰性清理（写入时顺带清掉过期条目），否则被大量不同邮箱打一遍就是无界增长。

## 7. 路由保护与越权修复

### 7.1 挂载顺序

```ts
app.route("/api/system", system);   // 公开：health
app.route("/api/auth", auth);       // 公开：register / login / logout / me

app.use("/api/*", requireAuth);     // ← 这行以下全部需要登录

app.route("/api/chat", chat);
app.route("/api/sessions", sessions);
app.use("/api/admin/*", requireAdmin);
app.route("/api/admin", admin);
```

默认全保护、显式放行：将来新增业务路由只要挂在这行下面就自动受保护，
不会因为忘了加中间件而裸奔。

代价是这个顺序语义必须靠测试守住——见 §11 的第 4 组。

`/api/auth/me` 需要认证，但它挂在 `requireAuth` 之前，所以由该路由自己校验并在
未登录时返回 401，而不是依赖全局中间件。

为避免两份校验逻辑各自漂移，把「读 cookie → 验签 → 查库 → 得到用户或 null」
抽成一个 `resolveUser(c)` 函数：`requireAuth` 在拿到 null 时抛 401，`me` 在拿到 null 时
返回 401 响应。两者共用同一份实现，禁用用户的判定不会只在其中一条路径上生效。

### 7.2 三处越权

前两处 `docs/backend-plan.md:261` 已有记录，第三处是本次设计过程中新发现的。

**（a）`findById` / `rename` / `remove` 不按 userId 收窄**

三个方法签名改为按 `(id, userId)` 收窄。`listByUser` 本来就是对的。
service 层从 context 拿当前用户 id 传下去，route 层不再接受任何客户端传来的用户标识。

**（b）`loadHistory` 读消息时不校验会话归属**

它走的是 `messageRepo.listBySession(sessionId)`，这条路上没有 userId。
service 先用 `findById(id, userId)` 确认归属，不属于自己就按会话不存在处理
（返回空历史，与现有「新会话后端还没有这一行」的行为一致，见 `routes/sessions.ts:63` 的注释）。

**（c）`upsert` 能往别人的会话里注入内容（新发现）**

`ensureSession` 调的 `sessionRepo.upsert` 用 `id` 做冲突目标，`onConflictDoUpdate`
只更新 `updatedAt`，**完全不看 userId**。拿到别人的会话 UUID 往 `/api/chat` 发一条消息，
这条消息和模型的回复就写进了别人的会话，受害者刷新左栏即可见。

这比「能改删别人的会话」更严重——是**能往别人的会话里注入内容**。

修法：`onConflictDoUpdate` 加 `setWhere: eq(sessions.userId, userId)`，配合 `returning()`；
返回空说明该 id 已存在且不属于当前用户 → 403。

注意 `chat.ts` 的 `prepareSession` 目前把所有异常都降级成「继续对话但不持久化」
（`routes/chat.ts:63`）。**403 必须穿透这个降级**：越权要明确拒绝，不能悄悄变成
「照常对话只是不存」——那样攻击者拿不到别人的历史，但受害者的会话仍会被 touch。

## 8. admin 能力

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/admin/users` | 列表：`{id, email, role, disabled, createdAt}` |
| PATCH | `/api/admin/users/:id` | `{disabled: boolean}` |

`requireAdmin` 中间件读 context 里的当前用户，`role !== 'admin'` 返回 403。

**不能禁用自己**：否则唯一的 admin 一次误操作就把管理入口彻底关掉，
只能改库恢复。这一条在 route 层校验，返回 400。

本轮不做：改角色、删用户、分页、搜索。用户量到需要分页时再说。

## 9. 前端改造

### 9.1 `stores/user.js` 重写，保留三个兼容垫片

新 surface：`user` 对象、`isLoggedIn` / `isAdmin` 两个 computed、
`login` / `register` / `logout` / `fetchMe` 四个方法。

删除：`token`、`userId`、`userIdLogin`、`phoneNumber`、`avatar`、`userRole` 全部状态，
以及 `initialize`、`checkFirstRun`、`getUsers`、`createUser`、`updateUser`、`deleteUser`、
`validateUsernameAndGenerateUserId`、`uploadAvatar`、`getCurrentUser`、`updateProfile`
这些打 v0.4 端点的方法。所有 `localStorage` 读写消失——token 在 cookie 里，JS 碰不到。

**但必须保留三个导出作为兼容垫片**：`getAuthHeaders`（返回 `{}`）、
`checkAdminPermission`、`checkSuperAdminPermission`。

它们被 `apis/base.js`、`apis/agent_api.js`、`views/GraphView.vue`、
`components/FileUploadModal.vue`、`components/FileTable.vue` 引用着，而
**ESM 命名导入一个不存在的符号会让 Vite 在构建期直接失败**，不是运行时静默 undefined。

留着垫片，这些 v0.4 遗留页面**保持原本的坏法**（照旧打不通 Python API），
不引入新的坏法（构建失败）。它们的清理属于 frontend-plan 的组件处置清单，不在本轮。

### 9.2 各文件改动

| 文件 | 改动 |
| --- | --- |
| `apis/http.js` | 删掉 Bearer 注入那 3 行；401 处理原样保留 |
| `apis/http.test.js` | 两个依赖 `userStore.token` 的用例跟着改写 |
| `apis/auth_api.js` | 新增，走 `http.js` |
| `main.js` | mount **之前** `await userStore.fetchMe()` |
| `router/index.js` | 翻开被注释的守卫；`/agent`、`/admin` 设 `requiresAuth: true` |
| `views/LoginView.vue` | 重写：email + password，登录/注册切换 |
| `components/UserManagementComponent.vue` | 重写为 admin 页，挂 `/admin` 路由 |
| `apis/chat_api.js` | 补 401 分支，见 §9.3 |

`main.js` 的 `await` 位置很关键：放在 `app.mount()` 之后，已登录用户会先闪一下
登录页再跳回来。

`/knowledge`、`/dashboard`、`/eval` 这些 v0.4 遗留路由**保持 `requiresAuth: false` 不动**。
它们本来就是坏的，加守卫不会让它们变好，只会扩大本次改动面。

### 9.3 SSE 链路

`apis/chat_api.js` 的 `fetch` 没有设 `credentials`，默认值就是 `same-origin`——
开发走 vite proxy、生产走 nginx 反代，浏览器侧都是同源，**cookie 自动带上，
请求部分一行都不用改**。

缺口在响应侧：它不走 `http.js`，所以收到 401 时只会抛一个错误字符串给对话界面，
不会跳登录页。要在它现有的非 2xx 分支里补一次 401 判断，调用同一个 unauthorized handler。

## 10. 错误处理

| 场景 | 状态码 |
| --- | --- |
| 未登录 / token 失效 / 签名错 / 用户已禁用 | 401 |
| 非 admin 访问 `/api/admin/*` | 403 |
| 会话存在但不属于自己（`upsert` 冲突） | 403 |
| 会话不属于自己（rename / delete） | 404 |
| 会话不属于自己（读历史） | 200 + 空数组，见 §7.2(b) |
| 邮箱已注册 | 409 |
| 密码不满足强度 / 邮箱格式非法 | 400 |
| 登录失败超限 | 429 |

沿用现有 `HTTPException` + `middleware/error.ts` 的 `{ error: { message } }` 格式，
不新增错误响应结构。

**登录失败一律返回同一句文案**，不区分「邮箱不存在」与「密码错误」——
否则登录端点就成了账号枚举器，对开放注册的系统这是白送的用户名单。

rename / delete 用 404 而非 403 是有意的：这两个操作的「不存在」与「不属于你」
对调用方应当不可区分，同样是为了不泄露他人会话 id 的存在性。而 `upsert` 那处必须是 403，
因为客户端需要知道这个 id 不能用（前端应重新生成 sessionId），不能静默降级。

## 11. 测试

后端沿用现有 PGlite 内存 Postgres 模式，不需要 Docker。

1. **`services/auth.test.ts`** — 哈希往返、错密码、限流计数与 15 分钟解除、
   `ADMIN_EMAILS` 提权
2. **`routes/auth.test.ts`** — 注册、登录、重复邮箱 409、弱密码 400、
   邮箱大小写归一、cookie 属性（`httpOnly`、`sameSite`、`secure` 随环境）、
   登录失败文案不区分两种原因
3. **`middleware/auth.test.ts`** — 无 cookie、坏签名、已过期、**已禁用用户**各自 401
4. **越权回归组（本轮重点）** — 缺了这组，这次改造就没有护栏：
   - 用户 A 读 / 改 / 删用户 B 的会话，全部失败
   - **A 拿 B 的 sessionId 发消息被 403 拒绝**，且 B 的会话未被 touch、未写入消息
   - `/api/system/health` 无 cookie 返回 200，`/api/sessions` 无 cookie 返回 401
     （守住 §7.1 的挂载顺序，否则以后有人调整顺序不会有任何提示）

前端 `http.test.js` 跟着改。`apps/web` 没有 typecheck、`lint` 也不可用
（eslint 9 只认 `eslint.config.js`，仓库里是旧格式 `.eslintrc.cjs`），
前端这部分只能靠 vitest 与手动验收覆盖。

## 12. 已知缺口

本轮交付后系统的真实状态，**不是遗漏，是有意识的范围选择**：

- **没有配额，也没有注册限流**。注册开放、任何人可注册即用，模型开销完全不设防。
  注册端点同样跑 scrypt（每次 64MB 内存），有人靠刷注册就能打满 CPU 与内存。
  这两项在配额轮与风控轮。**在它们落地前，公开这个部署等于把共享钱包挂到公网上**——
  已与项目负责人确认并接受这一风险姿态。
- **邮箱不验证真实性**，只当唯一标识存下来。
- **密码无法自助重置**，用户忘记只能由 admin 改库。
- **限流是单实例内存**，重启失效，多副本部署下无效。
- **admin 能力只有列表与禁用**，改角色、删用户需要改库。
- v0.4 遗留页面（知识库、Dashboard、评测、图谱）仍然打不通，本轮不修。

## 13. 遗留给后续轮次

| 项 | 依赖 |
| --- | --- |
| 配额与 token 计量 | 要动 chat 链路与 agent-core |
| 注册限流、机器人防护 | Redis 或同类共享计数 |
| 邮箱验证、密码重置 | 邮件发送基础设施 |
| OAuth / 第三方登录 | 届时重新评估是否值得迁移到认证框架 |
| 多副本部署下的限流 | 同风控轮 |
