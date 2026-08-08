# PR 复盘：HEU-9 与 HEU-40 的 review 受阻（2026-08-06）

本文件是 GLM-5.2（主实现）与 gpt-5.6-sol（最终回看）对两个 PR 受阻过程的联合复盘，
目的是把「本地全绿但 review 仍暴雷」的系统性根因沉淀为本项目今后提 PR 的固定门禁。
不是事后辩解，是可执行的预防清单。

## 事实经过

- **PR#5（HEU-9 补全 model provider）**：本地 415 测试全绿、DeepSeek 与 Ollama 真实调用跑通。
  组织者 review 指出 2 条必须修：`VLLM_BASE_URL` 从未被读取（硬编码恰为默认值）、
  `findModel` 重名歧义由本 PR 扩注册表引入（用户只配 QWEN key 时选中 kimi-k2.6 会解析到
  没配 key 的 moonshotai，运行报错）。
- **PR#6（HEU-40 配额与计量）**：本地 448 测试全绿。组织者 review 指出 3 条必须修：
  `secondsUntilUnderLimit` 硬编码 24h 与可配置窗口脱钩、`nonNegativeInt` 空串静默归零
  （`Number("")===0` → 全员被拒或配额永不生效）、`.env.template` 缺 QUOTA_* 三项；
  另有 Retry-After 测试空转（`if(x!==undefined) expect(...)`）、滚动窗口核心语义零覆盖。
- **范围污染**：PR#6 从 PR#5 分支拉出来，把 HEU-9 的 `packages/ai`/`.env.template` 改动
  带进了 HEU-40 PR，reviewer 被迫审无关代码，两个 PR 改同批文件互相 conflict。

两个 PR 的核心设计都被组织者认可（isDefault 双判、事务双写 + entry_id 幂等 +
session_id 无级联外键防绕过），**受阻不在「不会实现」，在「验证与交付流程」**。

## 系统性根因（gpt-5.6-sol 独立判断，GLM 已本地复核）

### 根因 1：验证粒度 < 需求粒度

需求是**跨层声明**（env → config → 下游消费 → 最终行为），测试却只覆盖某一局部
（如 config parser 返回正确值），然后把局部通过外推为整条声明成立。
415/448 passed 的绿灯无法拦住「VLLM_BASE_URL 完全没读」「空串静默归零」——
因为它们都不影响编译、类型、形状，只影响**语义**。

### 根因 2：默认值遮蔽（本项目本轮最致命的故障模式）

多个 bug 的硬编码值**恰好等于默认值**：vLLM 硬编码 `:8000`（默认值）、
24h 硬编码（默认窗口）。在默认场景下「正确读配置」与「完全没读配置」**观测等价**，
默认值测试天然无法区分。本轮修复时又踩了一个变体：`WINDOW_MS = env.quotaWindowHours * 因子`
作为模块级常量在 import 时固化成默认 24h，测试用 getter 动态改 `windowHours=1` 改不动它
——派生常量复制了默认值，形成第二层遮蔽。**这个 bug 是「非默认窗口测试」当场抓出的，
不是我自己发现的**，足见默认值遮蔽的隐蔽。

### 根因 3：测试 oracle 空转 / 过弱

`if (err.retryAfterSeconds !== undefined) expect(...)` —— `undefined` 时无条件通过，
把全 PR 唯一一段手写 raw SQL + 跨驱动代码变成零覆盖。「存在且 >0」的强断言虽消除空转，
**在默认窗口下仍不能区分正确的小时结果与错误的 24 小时结果**。测试有 expect ≠ 有 oracle。

### 根因 4：真实调用被错误外推

Ollama 跑通是 **representative** 证据（公共 adapter），不是 **exact** 证据（vLLM 专属接线），
却被当成了 vLLM 验收。真实调用心理权重高，反而让实现者停止检查未执行的邻近路径。

### 根因 5：PR 范围污染 = 缺 base-aware scope 门禁

从兄弟分支拉新分支本身不绝对错（合法 stacked PR 需显式 base/依赖/合并顺序），
错在 PR#6 当作独立 PR 面向 main、却未隔离 HEU-9 历史、PR 描述未披露。真正的不变量是
**「PR 相对其声明 base 的全部 commits/diff 必须与 PR 声明一致」**。

## 本轮已落地的修复（留存本地，未 push）

### PR#5（feat/models-catalog-providers，2 commits）
- rebase 到 main；🔴#1 `VLLM_BASE_URL` 走 `@petrel/config` 的 `vllmBaseUrl`；
  🔴#2 `listConfiguredModels` 按 `findModel` 解析结果去重；补 3 条测试均 mutation check。
- 本地 CI：lint(0 error)/typecheck(7 包)/test(503 passed|2 skipped)/build。

### PR#6（feat/quota-usage-metering，2 commits）
- `rebase --onto origin/main b4b3556` 隔离 HEU-9（先验证 8bd599d 不依赖 HEU-9 新符号）；
  解决与 #7 上下文压缩的 4 处冲突（config/harness-registry/chat/chat.test）。
- 🔴#1 `secondsUntilUnderLimit` 加 `windowMs` 参数；🔴#2 `nonNegativeInt` 判空串；
  🔴#3 `.env.template` 补 QUOTA_* 带默认值；🟡#4 累计判据 `>=`→`>`；
  🔵 Retry-After 强断言、滚动窗口测试、admin 测试改名。
- **GPT 回看后补的缺口**（本轮最关键的增量）：config 空串回归测试、Retry-After 非默认窗口
  精确秒数测试（`windowHours=1` 断言 `<4000s`）；并据此抓出并修复 `WINDOW_MS` 模块级常量
  固化的真 bug（改成 `windowMs()` 函数）。所有新断言均 mutation check 验证非空转。
- 本地 CI：lint(0 error)/typecheck(7 包)/test(538 passed|2 skipped)/build。

## 今后提 PR 的十道门禁（gpt-5.6-sol 建议，本项目采纳）

1. **Base 与 scope**：独立 PR 从最新 target 建；stacked PR 显式 base/依赖/合并顺序；
   每个里程碑查 `target...HEAD` 完整 diff，不只看最后一条 commit。
2. **需求拆成可证伪声明**：「支持 X 配置」→「非默认值改变最终行为」；
   「滚动窗口」→「59 分钟计入、61 分钟排除」。
3. **改前探索**：入口、config 来源、producer/consumer、持久化、依赖库已有 API、回滚路径。
4. **状态空间增量分析**：扩容后 id 是否仍唯一、顺序是否有语义、一层接受的值下层能否消费、
   feature flag 是否覆盖所有新副作用。
5. **测试矩阵**：配置 missing/empty/whitespace/invalid/default/non-default/boundary；
   时间 <、==、> 边界；身份 重复/单 provider/顺序置换/GET-PUT round-trip；
   flag on/off × dependency healthy/failed。
6. **精准 fault-seeding**：对每个高风险不变量恢复一个**贴近 reviewer 指出的原始缺陷**
   的错误实现（恢复硬编码 24h、删空串判断、`>`改`>=`），确认测试因**目标语义**变红，
   不是因无关编译错误。
7. **证据分级**：exact / representative / proxy / unverified，禁止用 proxy 替代 exact 验收。
8. **验证阶梯**：先需求级测试（非默认配置、边界、失败路径、flag off-state、UI 渲染），
   再仓库级 lint/typecheck/test/build。仓库级全绿不能替代需求级。
9. **从最终 diff 反向核对 PR 描述**：最后一次 rebase/修改/验证后重写 PR body，
   核对行为变化、配置闭环、无关 commits、未验证项。
10. **review 逐项 ledger**：每条必须修/建议/新需求标记 fixed/deferred/rejected+理由，
    未处置项存在时不得写「全部修复」。

## 尚存的未决项（需团队/用户决策，非 GLM 可自决）

1. **重名 model id 的公共身份语义**：provider-qualified selector / 全局 key / ambiguity error
   会影响 API、UI 与已保存偏好——PR#5 的去重是止血，不是长期方案。
2. **`QUOTA_ENFORCEMENT` 的完整 off-state**：fail-closed 503 不受开关控制，
   kill switch 无法完整回滚旧行为。需明确「可用性优先恢复旧行为」还是
   「成本/安全优先仍 fail-closed（但不能叫 kill switch）」。这是 review 🟡#7，本轮未处理。
3. **reviewer 追加的前端 provider 配置界面**（PR#5 📋）：是否进当前 PR 还是 follow-up。
4. **PR#6 其余 🟡 建议**（全量拉行 JS 累加、SQL running 未用、无 usage 也开事务、
   DELETE 不校验用户存在、拒绝无日志）：可延期但须进 review ledger，不能静默消失。
5. **远端 CI 验证**：修复未 push（遵用户「仅留存本地」指令），
   最终 rebased SHA 的 GitHub Actions 结果尚未得到。

## 关于经验沉淀的如实说明

gpt-5.6-sol 给出了 5 个 error-lesson 指纹（默认值遮蔽 / 条件断言假绿 / PR base 不一致 /
跨层 selector 无法 round-trip / feature flag off-state 不完整）。
其中**指纹 A（默认值遮蔽）和指纹 B（条件断言假绿）本轮被真实复现并修复验证**，
符合结构化沉淀标准。

但本项目的 error-lessons 沉淀流程要求 GPT 在 `gpt-root-cause`/`gpt-final-reviewer` 报告里
输出 candidate → `lesson-candidate-capture.js` 捕获生成 pendingId → 主 GLM 验证确认。
本轮是 ad-hoc 回看，未走 capture hook，无 pending 文件，故**未能写入全局 error-lessons.jsonl**
（`record-error-lesson.js` 正确拒绝了绕过 provenance 的写入）。
本文件即为该经验的替代载体——项目级文档，下次正规 root-cause/final-review 流程触发时
可据此正式沉淀。
