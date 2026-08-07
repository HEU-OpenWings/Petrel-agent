# 认证补全设计：注册限流 · 邮箱验证 · 密码重置

对应 Linear issue（公开部署前三件必补项）。关联文档：[2026-08-03-auth-design.md](./2026-08-03-auth-design.md) · [backend-plan.md](../../backend-plan.md)

## 1. 目标与范围

在现有「邮箱密码 + JWT cookie + 登录失败限流」基础上补齐三件事：

| 事项 | 现状 | 本轮目标 |
| --- | --- | --- |
| 注册限流 | 无任何限制，可批量刷号并打满 scrypt CPU/内存 | 按 IP 固定窗口限流（默认 5 次 / 15 分钟） |
| 邮箱验证 | 注册即可用，邮箱真伪不校验 | 注册后发验证邮件，未验证不能登录 |
| 密码重置 | 忘记密码只能改库 | 邮件自助重置：`forgot-password` → 邮件链接 → 设置新密码 |

**不做**：前端完整落地页（本轮用后端渲染的最小 HTML 页面保证可用，SPA 页面留后续）；多副本共享计数（同登录限流，单列 issue，风控轮做 Redis）；OAuth。

## 2. 邮件发送通道（先定通道，再实现）

**结论：`nodemailer` + SMTP**。理由：

- SMTP 是事实标准，与具体邮件服务商解耦——Resend / SendGrid / 阿里云 DirectMail / QQ、163 / 自建 Postfix 都能用，换商只改配置不改代码；
- `nodemailer` 是 Node 生态最成熟的邮件库，纯 JS 无原生编译；
- 「零第三方认证依赖」原则只约束密码哈希与 JWT（见 2026-08-03-auth-design.md §2），邮件发送不在其列，用户已确认不冲突。

传输方式：

| 环境 | 默认 | 说明 |
| --- | --- | --- |
| development / test | `console` | 邮件打印到日志（含验证/重置链接），零外部依赖即可本地跑通 |
| production | `smtp`（缺失即启动失败） | `MAIL_TRANSPORT=smtp` + SMTP 配置，与 `JWT_SECRET` 同风格：生产环境宁肯启动失败 |

## 3. 数据模型（`users` 表新增 5 列，全部可空）

```ts
emailVerifiedAt:           timestamp("email_verified_at", { withTimezone: true })
emailVerifyTokenHash:      text("email_verify_token_hash")
emailVerifyTokenExpiresAt: timestamp("email_verify_token_expires_at", { withTimezone: true })
passwordResetTokenHash:    text("password_reset_token_hash")
passwordResetTokenExpiresAt: timestamp("password_reset_token_expires_at", { withTimezone: true })
```

- 只存 token 的 **sha256 哈希**，不存明文；验证链接 / 重置链接里才是明文 token。
- 验证 token 24h 有效，重置 token 30min 有效；各自单槽（再次申请覆盖旧的）。
- 迁移把存量用户 `email_verified_at` 回填为 `created_at`（老账号视为已验证，不锁人）。
- `PublicUser` 增加 `emailVerifiedAt: Date | null`（非敏感字段；admin 列表可见，方便运维看验证状态）。

## 4. 限流

沿用「单实例内存 + 惰性清理」的实现方式（与登录失败限流一致；多副本共享计数单列 issue，风控轮做 Redis）。

| 端点 | 维度 | 默认 | 配置 |
| --- | --- | --- | --- |
| `POST /api/auth/register` | 客户端 IP | 5 次 / 15 分钟 | `REGISTER_RATE_LIMIT_MAX` / `REGISTER_RATE_LIMIT_WINDOW_MINUTES` |
| `POST /api/auth/forgot-password` | 邮箱 | 3 次 / 15 分钟 | `AUTH_MAIL_RATE_LIMIT_MAX` / `AUTH_MAIL_RATE_LIMIT_WINDOW_MINUTES` |
| `POST /api/auth/resend-verification` | 邮箱 | 同上 | 同上 |

客户端 IP **优先取 `X-Real-IP`**（nginx 的 `proxy_set_header` 是覆盖语义，客户端伪造不了）；
兜底取 `X-Forwarded-For` 的**最后**一段（`$proxy_add_x_forwarded_for` 是追加语义，
最后一跳才是代理写入的真实 IP——取第一段等于客户端任意伪造，注册限流可被绕过），
再回退 `getConnInfo()` 的 socket 地址。

限流 Map 有**容量上限**（默认 10 万条，满时逐出最旧 key），全表清理用**时间门控 sweep**
（至多每 60s 一次，只在撞新 key 时触发），避免「逐请求 O(n) 全扫 + 无界增长」的 DoS 面。

## 5. 认证流程

### 5.1 注册

`POST /api/auth/register` → 201：

- 先查注册限流（在 scrypt 之前，避免刷号打满 CPU）；
- 建未验证用户 → 生成验证 token → 存哈希 + 过期时间 → 发验证邮件；
- **不再自动登录**（种 cookie 会让「验证」形同虚设）：响应 `{ user, verificationSent }`；
- **邮件发送失败不使注册失败**：仍返回 201、`verificationSent: false`，
  前端据此提示走 `/api/auth/resend-verification` 重发；
- `EMAIL_VERIFICATION_ENABLED=false`（默认 true，安全默认）时直接建出**已验证**用户
  （`userRepo.create` 支持 `emailVerifiedAt`，不产生中间态）、跳过发信与登录门禁；
  仅用于开发 / 内网演示，生产关闭会打 `logger.warn` 醒目告警。

### 5.2 登录门禁

密码校验通过后、`disabled` 检查之后追加：

```text
未验证 → 403 "邮箱尚未验证，请先查收验证邮件"
```

判定排在密码校验**之后**，与 `disabled` 同位置——不构成账号枚举（攻击者只有先知道正确密码才会看到 403）。
`EMAIL_VERIFICATION_ENABLED=false` 时跳过这道闸。

### 5.3 验证邮箱

`GET /api/auth/verify-email?token=...` → 后端渲染最小 HTML 页（成功/失败）。成功即置 `email_verified_at` 并清空验证 token。

### 5.4 忘记密码

- `POST /api/auth/forgot-password`：**恒 200**（防枚举），存在且（无论是否已验证）生成重置 token 并发邮件；
- `GET /api/auth/reset-password?token=...`：后端渲染「设置新密码」表单页；
- `POST /api/auth/reset-password`：校验 token 有效未过期 → 改密 → 清空重置 token → **顺带置为已验证**（重置邮件本身就是邮箱所有权证明，也兜住「验证邮件丢了」的情况）。

`forgot-password` / `reset-password` 表单页与 API 调用共用同一对端点：body 支持 JSON 与 `application/x-www-form-urlencoded`，响应按 `Accept` 给 JSON 或 HTML。

## 6. 配置项（全部走 `@petrel/config`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MAIL_TRANSPORT` | dev/test: `console`；prod 必填 | `console` / `smtp` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_SECURE` | 无 / 587 / 空 / 空 / false | 仅 `smtp` 时用 |
| `MAIL_FROM` | `Petrel <no-reply@petrel.local>` | 发件人 |
| `PUBLIC_API_URL` | `http://localhost:5050` | 邮件里的链接前缀（生产为站点域名） |
| `PUBLIC_WEB_URL` | `http://localhost:5173` | 后端 HTML 页里的「返回登录」链接 |
| `EMAIL_VERIFICATION_ENABLED` | `true` | 关闭后注册即登录、不发验证邮件（仅开发/内网演示） |
| `REGISTER_RATE_LIMIT_MAX` / `REGISTER_RATE_LIMIT_WINDOW_MINUTES` | 5 / 15 | 注册限流 |
| `AUTH_MAIL_RATE_LIMIT_MAX` / `AUTH_MAIL_RATE_LIMIT_WINDOW_MINUTES` | 3 / 15 | 忘记密码 / 重发验证限流 |

## 7. 安全要点

- token 只存哈希；明文只出现在邮件链接里；
- 忘记密码恒 200、重发验证恒 200，不泄露账号存在性；
- 未验证判定在密码校验之后，不新增枚举向量；
- 注册限流在 scrypt 之前；
- HTML 输出做 HTML 转义（邮箱、token 都进过页面）；
- 已知取舍：重置成功不使其他设备旧 JWT 失效（需要 `tokenVersion`，已列在 CLAUDE.md 认证节的后续项）。
