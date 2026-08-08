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
| 7 | 文档：CLAUDE.md / backend-plan | ✅ |
| 8 | 全量 typecheck / lint / test / build | ✅ |

全量检查：typecheck ✅ · lint ✅（2 个既有警告）· test **631 passed / 2 skipped** ✅ · build ✅。
