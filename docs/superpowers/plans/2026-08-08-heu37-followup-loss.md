# HEU-37 实施计划：首轮 error / aborted 收尾时排队消息丢失

> 对应设计：[2026-08-08-heu37-followup-loss-design.md](../specs/2026-08-08-heu37-followup-loss-design.md)

| # | 任务 | 状态 |
| --- | --- | --- |
| 1 | registry：Entry 加 pending/draining，接管 followUp 队列 | ✅ |
| 2 | registry：settled 后 setImmediate 调度 drain（error/aborted 都覆盖） | ✅ |
| 3 | registry：evict 时 reject 剩余 pending，不挂连接 | ✅ |
| 4 | 更新既有「followUp 同 run」测试为「各自独立 run」语义 | ✅ |
| 5 | 新增验收测试：error / aborted 首轮 + 并发第二条 → 有回答且落库 | ✅ |
| 6 | chat 路由层端到端验收（SSE + PGlite 落库） | ✅ |
| 7 | review 修复：drain 纳入 chain、overflow 兜底、请求配置随队列条目保存 | ✅ |
| 8 | review 回归：顺序、运输异常 SSE error、排队 overflow 与配置应用 | ✅ |
| 9 | 文档与全量 typecheck / lint / test / build | ✅ |

最终验证结果以 PR 描述为准，避免测试总数随主分支新增用例后失真。
