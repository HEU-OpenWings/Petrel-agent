# 前端三栏 Shell 改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/web` 从单栏对话流改造为 codex 形态的三栏工作台（Sessions / Conversation / Workspace），布局状态持久化，非对话功能作为独立路由页挂进同一 shell。

**Architecture:** `AppShell.vue` 承担三栏骨架，布局状态（折叠、右栏宽度）由 `stores/layout.js` 持有并持久化到 localStorage，右栏内容由 `stores/workspace.js` 驱动，形成单向数据流。已验证过的 AgentEvent 归约层（`useAgentStream.js` / `chat_api.js`）一行不动，本次只换渲染层。

**Tech Stack:** Vue 3（`<script setup>`）· Vite 7 · pinia 3 · less · lucide-vue-next · vitest 4（仅覆盖纯逻辑单元）

设计文档：[2026-07-31-web-three-column-shell-design.md](../specs/2026-07-31-web-three-column-shell-design.md)

## Global Constraints

每个任务的要求都隐含包含本节。

- **语言是 JavaScript，禁止引入 TypeScript**。设计文档里写的 `api/http.ts` 实际落地为 `api/http.js`
- **`composables/useAgentStream.js` 与 `apis/chat_api.js` 一行不改**——已端到端验证过的归约逻辑
- **现有 `--gray-*` / `--main-*` CSS 变量一个不改**——它们同时被 ant-design-vue 兼容变量和全部旧页面使用
- **图标统一 `lucide-vue-next`**，尺寸只用 14 / 16 / 18 三档
- **无悬停位移**：hover 只允许改 `background-color` 与 `color`，禁止 `transform`、`margin`、`padding` 变化
- **零 `box-shadow`**，唯一例外是 `CommandPalette` 浮层，用现有 `--shadow-2`
- **不引入新色值**：错误态一律用 `--color-error-*`，不要硬编码 `#c04a4a` 这类字面量
- 样式一律 `<style lang="less" scoped>`
- 注释用中文，解释「为什么」而不是「做了什么」
- **每次 commit 的 message 结尾必须加一行**：
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```
- 仓库统一 LF 换行，不要引入 CRLF

### 运行测试

```bash
pnpm vitest run apps/web                      # 跑本次新增的全部前端测试
pnpm vitest run apps/web/src/stores/layout.test.js -t "用例名"   # 跑单个用例
pnpm --filter @petrel/web run build           # 前端构建，每个组件任务的验证手段
```

> **若测试报 `Cannot find package 'pinia'`**：vitest 从根目录运行，但依赖解析基于测试文件所在
> 路径向上查找，`apps/web/node_modules/pinia` 应当能被找到。若确实解析失败，先执行
> `pnpm install` 确认 workspace 链接完好，不要去根 `package.json` 加 pinia 依赖。

---

## 文件结构

### 新增

| 文件 | 职责 |
| --- | --- |
| `apps/web/src/stores/layout.js` | 三栏折叠状态与右栏宽度，含 localStorage 持久化与钳制 |
| `apps/web/src/stores/layout.test.js` | 上者的单元测试 |
| `apps/web/src/stores/workspace.js` | 右栏当前展示的工具调用快照 |
| `apps/web/src/stores/workspace.test.js` | 上者的单元测试 |
| `apps/web/src/composables/useResizePanel.js` | 右栏拖拽：pointer 事件、宽度计算、清理 |
| `apps/web/src/composables/useResizePanel.test.js` | 上者的单元测试 |
| `apps/web/src/composables/useCommandPalette.js` | `/` 命令的过滤与键盘导航（纯逻辑，可测） |
| `apps/web/src/composables/useCommandPalette.test.js` | 上者的单元测试 |
| `apps/web/src/apis/http.js` | fetch 封装 + JWT 注入 + 401 处理 |
| `apps/web/src/apis/http.test.js` | 上者的单元测试 |
| `apps/web/src/layouts/AppShell.vue` | 三栏骨架，只管布局 |
| `apps/web/src/components/shell/SessionSidebar.vue` | 左栏 |
| `apps/web/src/utils/toolCall.js` | 工具调用的状态文案与参数/结果格式化，中栏右栏共用 |
| `apps/web/src/utils/toolCall.test.js` | 上者的单元测试 |
| `apps/web/src/components/shell/WorkspacePanel.vue` | 右栏 |
| `apps/web/src/components/chat/CommandPalette.vue` | `/` 命令面板（纯渲染，逻辑在 composable 里） |
| `apps/web/src/views/EvalView.vue` | 评测页空态 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `vitest.config.ts` | 加 `@` alias 指向 `apps/web/src` |
| `package.json`（根） | 加 `jsdom` devDependency |
| `apps/web/src/assets/css/base.css` | 追加 9 个 shell 变量 |
| `apps/web/src/assets/css/base.dark.css` | 追加同名变量的暗色值 |
| `apps/web/src/assets/css/main.css` | 追加全局 `.icon-btn` |
| `apps/web/src/main.js` | 注册 401 处理器 |
| `apps/web/src/router/index.js` | 路由表重写、守卫关闭 |
| `apps/web/src/views/ChatView.vue` | 去掉自带顶栏，Composer 重做 |
| `apps/web/src/components/chat/MessageItem.vue` | 气泡形态改造 |
| `apps/web/src/components/chat/ToolCallBlock.vue` | 摘要行降噪 + 送右栏入口 |
| `apps/web/src/apis/base.js` | 只加一行文件头注释 |

---

## Task 1: layout store 与前端测试基础设施

**Files:**
- Modify: `package.json`（根，devDependencies）
- Modify: `vitest.config.ts`
- Create: `apps/web/src/stores/layout.js`
- Test: `apps/web/src/stores/layout.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `clampWidth(width: number) => number` — 钳制到 `[280, 560]`，非有限数回落 `360`
  - `useLayoutStore()` — state: `leftCollapsed: boolean`、`rightCollapsed: boolean`、`rightWidth: number`；actions: `toggleLeft()`、`toggleRight()`、`expandRight()`、`setRightWidth(w)`、`resetRightWidth()`
  - 常量导出：`MIN_RIGHT_WIDTH = 280`、`MAX_RIGHT_WIDTH = 560`、`DEFAULT_RIGHT_WIDTH = 360`、`NARROW_VIEWPORT = 1024`、`STORAGE_KEY = 'petrel.layout'`

- [ ] **Step 1: 装 jsdom 并配好 alias**

根 `package.json` 的 `devDependencies` 加一行（保持字母序，放在 `@types/node` 之后）：

```json
    "jsdom": "^28.0.0",
```

`vitest.config.ts` 的 `alias` 块追加一条（放在四个 `@petrel/*` 之后）：

```ts
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
```

然后执行：

```bash
pnpm install
```

- [ ] **Step 2: 写失败的测试**

创建 `apps/web/src/stores/layout.test.js`：

```js
// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clampWidth,
  DEFAULT_RIGHT_WIDTH,
  MAX_RIGHT_WIDTH,
  MIN_RIGHT_WIDTH,
  STORAGE_KEY,
  useLayoutStore
} from './layout.js'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('clampWidth', () => {
  it('把超出范围的宽度钳制到边界', () => {
    expect(clampWidth(9999)).toBe(MAX_RIGHT_WIDTH)
    expect(clampWidth(10)).toBe(MIN_RIGHT_WIDTH)
    expect(clampWidth(400)).toBe(400)
  })

  it('非有限数回落到默认宽度', () => {
    expect(clampWidth(Number.NaN)).toBe(DEFAULT_RIGHT_WIDTH)
    expect(clampWidth(undefined)).toBe(DEFAULT_RIGHT_WIDTH)
  })
})

describe('useLayoutStore', () => {
  it('没有持久化数据时用默认值', () => {
    const layout = useLayoutStore()
    expect(layout.leftCollapsed).toBe(false)
    expect(layout.rightWidth).toBe(DEFAULT_RIGHT_WIDTH)
  })

  it('首次加载时视口窄于 1024 则默认折叠右栏', () => {
    vi.stubGlobal('innerWidth', 800)
    const layout = useLayoutStore()
    expect(layout.rightCollapsed).toBe(true)
    vi.unstubAllGlobals()
  })

  it('持久化数据损坏时静默回落默认值', () => {
    localStorage.setItem(STORAGE_KEY, '{ 这不是 JSON')
    const layout = useLayoutStore()
    expect(layout.rightWidth).toBe(DEFAULT_RIGHT_WIDTH)
  })

  it('schema 版本不符时丢弃旧数据', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 99, rightWidth: 500 }))
    const layout = useLayoutStore()
    expect(layout.rightWidth).toBe(DEFAULT_RIGHT_WIDTH)
  })

  it('读回上次持久化的状态', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ v: 1, leftCollapsed: true, rightCollapsed: false, rightWidth: 420 })
    )
    const layout = useLayoutStore()
    expect(layout.leftCollapsed).toBe(true)
    expect(layout.rightWidth).toBe(420)
  })

  it('toggleLeft 立刻写入 localStorage', () => {
    const layout = useLayoutStore()
    layout.toggleLeft()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).leftCollapsed).toBe(true)
  })

  it('setRightWidth 写入前先钳制', () => {
    const layout = useLayoutStore()
    layout.setRightWidth(9999)
    expect(layout.rightWidth).toBe(MAX_RIGHT_WIDTH)
  })

  it('localStorage 不可写时不抛异常', () => {
    const layout = useLayoutStore()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => layout.toggleRight()).not.toThrow()
    vi.restoreAllMocks()
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run apps/web/src/stores/layout.test.js`
Expected: FAIL，报无法解析 `./layout.js`

- [ ] **Step 4: 实现 layout store**

创建 `apps/web/src/stores/layout.js`：

```js
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const STORAGE_KEY = 'petrel.layout'
const SCHEMA_VERSION = 1

export const MIN_RIGHT_WIDTH = 280
export const MAX_RIGHT_WIDTH = 560
export const DEFAULT_RIGHT_WIDTH = 360
/** 首次加载时视口窄于此值，右栏默认折叠 */
export const NARROW_VIEWPORT = 1024

export function clampWidth(width) {
  if (!Number.isFinite(width)) return DEFAULT_RIGHT_WIDTH
  return Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, Math.round(width)))
}

/** 读取失败一律返回 null，由调用方回落默认值：布局偏好丢了不值得打断应用启动 */
function readPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed?.v !== SCHEMA_VERSION) return null
    return {
      leftCollapsed: parsed.leftCollapsed === true,
      rightCollapsed: parsed.rightCollapsed === true,
      rightWidth: clampWidth(parsed.rightWidth)
    }
  } catch {
    return null
  }
}

export const useLayoutStore = defineStore('layout', () => {
  const persisted = readPersisted()

  const leftCollapsed = ref(persisted?.leftCollapsed ?? false)
  // 只在首次加载（无持久化偏好）时看视口。之后完全听用户的，
  // 否则窄屏下用户点展开会被响应式规则立刻覆盖，表现为「点了没反应」。
  const rightCollapsed = ref(persisted?.rightCollapsed ?? window.innerWidth < NARROW_VIEWPORT)
  const rightWidth = ref(persisted?.rightWidth ?? DEFAULT_RIGHT_WIDTH)

  function persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          v: SCHEMA_VERSION,
          leftCollapsed: leftCollapsed.value,
          rightCollapsed: rightCollapsed.value,
          rightWidth: rightWidth.value
        })
      )
    } catch {
      // 隐私模式下 localStorage 不可写，静默降级为「本次会话内有效」
    }
  }

  function toggleLeft() {
    leftCollapsed.value = !leftCollapsed.value
    persist()
  }

  function toggleRight() {
    rightCollapsed.value = !rightCollapsed.value
    persist()
  }

  function expandRight() {
    if (!rightCollapsed.value) return
    rightCollapsed.value = false
    persist()
  }

  function setRightWidth(width) {
    rightWidth.value = clampWidth(width)
    persist()
  }

  function resetRightWidth() {
    rightWidth.value = DEFAULT_RIGHT_WIDTH
    persist()
  }

  return {
    leftCollapsed,
    rightCollapsed,
    rightWidth,
    toggleLeft,
    toggleRight,
    expandRight,
    setRightWidth,
    resetRightWidth
  }
})
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run apps/web/src/stores/layout.test.js`
Expected: PASS，9 个用例全绿

- [ ] **Step 6: 确认没有破坏已有测试**

Run: `pnpm test`
Expected: PASS，`agent-core` 与 `api` 的 4 个用例仍然通过

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts apps/web/src/stores/layout.js apps/web/src/stores/layout.test.js
git commit -m "feat(web): 三栏布局状态 store 与持久化"
```

---

## Task 2: workspace store

**Files:**
- Create: `apps/web/src/stores/workspace.js`
- Test: `apps/web/src/stores/workspace.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `useWorkspaceStore()`
  - state: `activeToolCall: ToolCallSnapshot | null`
  - getter: `activeToolCallId: string | null`
  - actions: `openToolCall(snapshot)`、`syncToolCall(snapshot)`、`clear()`
  - `ToolCallSnapshot` 形状：`{ id, name, state, args, result, ms }`

**为什么存快照而不是只存 id**：`ChatView` 与 `WorkspacePanel` 都是 `AppShell` 的子组件，
是兄弟关系。`provide` 只向后代传递，兄弟之间注入不到，所以右栏没法从 ChatView 那里拿
`useAgentStream` 的 `toolCalls`。让 `ToolCallBlock` 把快照写进 store 是唯一不改动
`useAgentStream.js` 的做法，`syncToolCall` 负责在工具仍在执行时把后续状态同步过去。

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/stores/workspace.test.js`：

```js
// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkspaceStore } from './workspace.js'

const SNAPSHOT = { id: 'call_1', name: 'get_current_time', state: 'running', args: {}, result: null }

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useWorkspaceStore', () => {
  it('初始没有选中的工具调用', () => {
    const workspace = useWorkspaceStore()
    expect(workspace.activeToolCall).toBe(null)
    expect(workspace.activeToolCallId).toBe(null)
  })

  it('openToolCall 记录快照并暴露 id', () => {
    const workspace = useWorkspaceStore()
    workspace.openToolCall(SNAPSHOT)
    expect(workspace.activeToolCallId).toBe('call_1')
    expect(workspace.activeToolCall.state).toBe('running')
  })

  it('syncToolCall 只更新同一个 id 的快照', () => {
    const workspace = useWorkspaceStore()
    workspace.openToolCall(SNAPSHOT)
    workspace.syncToolCall({ ...SNAPSHOT, state: 'done', ms: 12 })
    expect(workspace.activeToolCall.state).toBe('done')
    expect(workspace.activeToolCall.ms).toBe(12)
  })

  it('syncToolCall 忽略不是当前选中项的更新', () => {
    const workspace = useWorkspaceStore()
    workspace.openToolCall(SNAPSHOT)
    workspace.syncToolCall({ id: 'call_2', name: 'other', state: 'done' })
    expect(workspace.activeToolCall.name).toBe('get_current_time')
  })

  it('未选中任何项时 syncToolCall 不写入', () => {
    const workspace = useWorkspaceStore()
    workspace.syncToolCall(SNAPSHOT)
    expect(workspace.activeToolCall).toBe(null)
  })

  it('clear 清空选中项', () => {
    const workspace = useWorkspaceStore()
    workspace.openToolCall(SNAPSHOT)
    workspace.clear()
    expect(workspace.activeToolCall).toBe(null)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run apps/web/src/stores/workspace.test.js`
Expected: FAIL，无法解析 `./workspace.js`

- [ ] **Step 3: 实现 workspace store**

创建 `apps/web/src/stores/workspace.js`：

```js
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * 右栏展示什么。
 *
 * 存的是工具调用的完整快照而不是一个 id：右栏的 WorkspacePanel 与产生数据的
 * ChatView 是兄弟组件，provide/inject 传不过去，而把 useAgentStream 改成单例
 * 又会动到已验证过的归约层。由 ToolCallBlock 写入快照是代价最小的做法。
 *
 * @typedef {{ id: string, name: string, state: string, args: unknown, result: unknown, ms?: number }} ToolCallSnapshot
 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const activeToolCall = ref(null)

  const activeToolCallId = computed(() => activeToolCall.value?.id ?? null)

  /** @param {ToolCallSnapshot} snapshot */
  function openToolCall(snapshot) {
    activeToolCall.value = snapshot
  }

  /** 工具还在执行时后续状态会变，只同步当前选中的那一个 */
  function syncToolCall(snapshot) {
    if (!activeToolCall.value || activeToolCall.value.id !== snapshot.id) return
    activeToolCall.value = snapshot
  }

  function clear() {
    activeToolCall.value = null
  }

  return { activeToolCall, activeToolCallId, openToolCall, syncToolCall, clear }
})
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run apps/web/src/stores/workspace.test.js`
Expected: PASS，6 个用例通过

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/stores/workspace.js apps/web/src/stores/workspace.test.js
git commit -m "feat(web): 右栏内容 store"
```

---

## Task 3: useResizePanel

**Files:**
- Create: `apps/web/src/composables/useResizePanel.js`
- Test: `apps/web/src/composables/useResizePanel.test.js`

**Interfaces:**
- Consumes: `clampWidth` 由调用方（layout store 的 `setRightWidth`）负责，本 composable 不钳制
- Produces: `useResizePanel({ getWidth, setWidth })` => `{ onPointerDown(event) }`

右栏在屏幕右侧，把手向**左**拖动时变宽，所以 `新宽度 = 起始宽度 + (起始 X - 当前 X)`。

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/composables/useResizePanel.test.js`：

```js
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { useResizePanel } from './useResizePanel.js'

/** 构造一个带 pointer capture 桩的把手元素 */
function createHandle() {
  const handle = document.createElement('div')
  handle.setPointerCapture = vi.fn()
  handle.releasePointerCapture = vi.fn()
  return handle
}

function pointerEvent(type, clientX) {
  const event = new Event(type, { bubbles: true })
  event.clientX = clientX
  event.pointerId = 1
  return event
}

describe('useResizePanel', () => {
  it('向左拖动把手时宽度增加', () => {
    let width = 360
    const { onPointerDown } = useResizePanel({
      getWidth: () => width,
      setWidth: (next) => {
        width = next
      }
    })

    const handle = createHandle()
    const down = pointerEvent('pointerdown', 1000)
    Object.defineProperty(down, 'target', { value: handle })
    onPointerDown(down)

    window.dispatchEvent(pointerEvent('pointermove', 900))
    expect(width).toBe(460)
  })

  it('向右拖动把手时宽度减少', () => {
    let width = 360
    const { onPointerDown } = useResizePanel({
      getWidth: () => width,
      setWidth: (next) => {
        width = next
      }
    })

    const handle = createHandle()
    const down = pointerEvent('pointerdown', 1000)
    Object.defineProperty(down, 'target', { value: handle })
    onPointerDown(down)

    window.dispatchEvent(pointerEvent('pointermove', 1050))
    expect(width).toBe(310)
  })

  it('松开后继续移动不再改变宽度', () => {
    let width = 360
    const { onPointerDown } = useResizePanel({
      getWidth: () => width,
      setWidth: (next) => {
        width = next
      }
    })

    const handle = createHandle()
    const down = pointerEvent('pointerdown', 1000)
    Object.defineProperty(down, 'target', { value: handle })
    onPointerDown(down)

    window.dispatchEvent(pointerEvent('pointermove', 900))
    window.dispatchEvent(pointerEvent('pointerup', 900))
    window.dispatchEvent(pointerEvent('pointermove', 700))

    expect(width).toBe(460)
  })

  it('拖动结束后恢复文本选中', () => {
    const { onPointerDown } = useResizePanel({ getWidth: () => 360, setWidth: () => {} })

    const handle = createHandle()
    const down = pointerEvent('pointerdown', 1000)
    Object.defineProperty(down, 'target', { value: handle })
    onPointerDown(down)
    expect(document.body.style.userSelect).toBe('none')

    window.dispatchEvent(pointerEvent('pointerup', 1000))
    expect(document.body.style.userSelect).toBe('')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run apps/web/src/composables/useResizePanel.test.js`
Expected: FAIL，无法解析 `./useResizePanel.js`

- [ ] **Step 3: 实现 composable**

创建 `apps/web/src/composables/useResizePanel.js`：

```js
import { onUnmounted } from 'vue'

/**
 * 右栏拖拽。
 *
 * 监听挂在 window 而不是把手元素上：指针移出把手甚至移出窗口时拖拽仍要继续，
 * 这是拖拽交互的基本预期。
 *
 * @param {{ getWidth: () => number, setWidth: (width: number) => void }} options
 */
export function useResizePanel({ getWidth, setWidth }) {
  let startX = 0
  let startWidth = 0

  function onPointerMove(event) {
    // 右栏贴在屏幕右侧，把手左移 = 变宽
    setWidth(startWidth + (startX - event.clientX))
  }

  function stop() {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', stop)
    document.body.style.userSelect = ''
  }

  function onPointerDown(event) {
    startX = event.clientX
    startWidth = getWidth()
    event.target?.setPointerCapture?.(event.pointerId)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stop)
    // 拖拽过程中禁止选中，否则光标扫过文字会拉出一片蓝色高亮
    document.body.style.userSelect = 'none'
  }

  onUnmounted(stop)

  return { onPointerDown }
}
```

> `onUnmounted` 在组件外调用（比如测试里）会打印警告但不报错。测试里不挂载组件，
> 如果警告干扰输出，说明实现正确，忽略即可。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run apps/web/src/composables/useResizePanel.test.js`
Expected: PASS，4 个用例通过

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/composables/useResizePanel.js apps/web/src/composables/useResizePanel.test.js
git commit -m "feat(web): 右栏拖拽 composable"
```

---

## Task 4: shell 色彩变量与 AppShell 三栏骨架

**Files:**
- Modify: `apps/web/src/assets/css/base.css`（末尾 `:root` 块内）
- Modify: `apps/web/src/assets/css/base.dark.css`（`:root.dark` 块内）
- Modify: `apps/web/src/assets/css/main.css`
- Create: `apps/web/src/layouts/AppShell.vue`

**Interfaces:**
- Consumes: `useLayoutStore()`（Task 1）、`useResizePanel()`（Task 3）
- Produces:
  - CSS 变量 `--surface-app` `--surface-sunken` `--surface-subtle` `--surface-hover` `--border-subtle` `--text-strong` `--text-muted` `--text-faint` `--radius-lg`
  - 全局 class `.icon-btn`
  - `AppShell.vue`，读取路由 `meta.workspace`（布尔）与 `meta.title`（字符串）

本任务结束时 `SessionSidebar` / `WorkspacePanel` 还不存在，先用占位 div，Task 5 / 6 再替换。

- [ ] **Step 1: 加亮色变量**

`apps/web/src/assets/css/base.css`，在 `--min-width: 400px;` 那一行之前插入：

```css
  /* Shell Surfaces - 三栏 shell 专用暖中性色，与冷青灰的 --gray-* 阶梯并存 */
  --surface-app: #ffffff;
  --surface-sunken: #f9f9f7;
  --surface-subtle: #f4f4f2;
  --surface-hover: #ececea;
  --border-subtle: #ecece8;
  --text-strong: #1f1f1e;
  --text-muted: #6e6e69;
  --text-faint: #9b9b95;
  --radius-lg: 12px;
```

- [ ] **Step 2: 加暗色变量**

`apps/web/src/assets/css/base.dark.css` 的 `:root.dark` 块内，在 `--gray-0: #030303;` 之后插入：

```css

  /* Shell Surfaces - 与亮色同名，暗色下同样保持暖中性 */
  --surface-app: #1a1a19;
  --surface-sunken: #141413;
  --surface-subtle: #262624;
  --surface-hover: #302f2d;
  --border-subtle: #2e2d2b;
  --text-strong: #ececea;
  --text-muted: #a3a29c;
  --text-faint: #6e6e69;
```

`--radius-lg` 不随主题变化，只在亮色定义即可。

- [ ] **Step 3: 加全局 icon-btn**

`apps/web/src/assets/css/main.css` 末尾追加：

```css
/* shell 里的无边框图标按钮，三栏共用 */
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.icon-btn:hover {
  background: var(--surface-hover);
  color: var(--text-strong);
}

.icon-btn:disabled {
  color: var(--text-faint);
  cursor: not-allowed;
}

.icon-btn:disabled:hover {
  background: transparent;
  color: var(--text-faint);
}
```

- [ ] **Step 4: 实现 AppShell**

创建 `apps/web/src/layouts/AppShell.vue`：

```vue
<template>
  <div class="app-shell">
    <aside v-if="!layout.leftCollapsed" class="sidebar">
      <div class="placeholder">SessionSidebar</div>
    </aside>

    <div class="main">
      <header class="toolbar">
        <button
          class="icon-btn"
          type="button"
          :title="layout.leftCollapsed ? '展开侧栏' : '收起侧栏'"
          @click="layout.toggleLeft()"
        >
          <PanelLeft :size="16" />
        </button>
        <span class="title">{{ title }}</span>
        <button
          v-if="hasWorkspace"
          class="icon-btn right"
          type="button"
          :title="layout.rightCollapsed ? '展开工作区' : '收起工作区'"
          @click="layout.toggleRight()"
        >
          <PanelRight :size="16" />
        </button>
      </header>

      <div class="content">
        <router-view />
      </div>
    </div>

    <template v-if="hasWorkspace && !layout.rightCollapsed">
      <div
        class="resizer"
        title="拖动调整宽度，双击复位"
        @pointerdown="onPointerDown"
        @dblclick="layout.resetRightWidth()"
      />
      <aside class="workspace" :style="{ width: `${layout.rightWidth}px` }">
        <div class="placeholder">WorkspacePanel</div>
      </aside>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { PanelLeft, PanelRight } from 'lucide-vue-next'
import { useRoute } from 'vue-router'
import { useResizePanel } from '@/composables/useResizePanel'
import { useLayoutStore } from '@/stores/layout'

const route = useRoute()
const layout = useLayoutStore()

// 右栏只属于对话页，由路由 meta 决定，非对话页自动只剩两栏
const hasWorkspace = computed(() => route.meta.workspace === true)
const title = computed(() => route.meta.title ?? '')

const { onPointerDown } = useResizePanel({
  getWidth: () => layout.rightWidth,
  setWidth: (width) => layout.setRightWidth(width)
})
</script>

<style lang="less" scoped>
.app-shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
  background: var(--surface-app);
  color: var(--text-strong);
}

.sidebar {
  flex: 0 0 240px;
  width: 240px;
  height: 100%;
  overflow: hidden;
  background: var(--surface-sunken);
}

.main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  height: 100%;
  // 没有 min-width: 0 的话 flex 子项不会收缩到内容宽度以下，窄屏会顶出横向滚动
  min-width: 0;
}

.toolbar {
  display: flex;
  flex: 0 0 44px;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
}

.title {
  color: var(--text-muted);
  font-size: 13px;
}

.icon-btn.right {
  margin-left: auto;
}

.content {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.resizer {
  flex: 0 0 4px;
  background: transparent;
  cursor: col-resize;
  transition: background-color 0.15s ease;

  &:hover {
    background: var(--border-subtle);
  }
}

.workspace {
  flex: 0 0 auto;
  height: 100%;
  overflow: hidden;
  border-left: 1px solid var(--border-subtle);
  background: var(--surface-app);
}

.placeholder {
  padding: 16px;
  color: var(--text-faint);
  font-size: 13px;
}
</style>
```

- [ ] **Step 5: 构建验证**

Run: `pnpm --filter @petrel/web run build`
Expected: 构建成功。此时 `AppShell` 还没有被任何路由引用，只验证它能编译。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/assets/css/base.css apps/web/src/assets/css/base.dark.css apps/web/src/assets/css/main.css apps/web/src/layouts/AppShell.vue
git commit -m "feat(web): shell 色彩变量与三栏骨架"
```

---

## Task 5: SessionSidebar

**Files:**
- Create: `apps/web/src/components/shell/SessionSidebar.vue`
- Modify: `apps/web/src/layouts/AppShell.vue`（替换左栏占位）

**Interfaces:**
- Consumes: `useLayoutStore()`、`useUserStore()`（现有，用 `isLoggedIn` / `username` / `avatar`）
- Produces: `SessionSidebar.vue`，emit `new-chat`——由 ChatView 在 Task 12 接管；本任务先由 `AppShell` 转成 router push 到 `/agent`

**不要复用 `UserInfoComponent`**：它 `inject('settingsModal')` 依赖 `AppLayout` 提供的注入，挂在 AppShell 下会拿到空对象，点设置即崩。左栏自己写一个只读用户区。

- [ ] **Step 1: 实现 SessionSidebar**

创建 `apps/web/src/components/shell/SessionSidebar.vue`：

```vue
<template>
  <nav class="session-sidebar">
    <button class="new-chat" type="button" @click="onNewChat">
      <SquarePen :size="16" />
      <span>新对话</span>
    </button>

    <div class="sessions">
      <div class="group-title">会话</div>
      <div class="empty">暂无历史会话</div>
    </div>

    <div class="bottom">
      <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="nav-item">
        <component :is="item.icon" :size="16" />
        <span>{{ item.label }}</span>
      </RouterLink>

      <div class="user">
        <template v-if="userStore.isLoggedIn">
          <img v-if="userStore.avatar" class="avatar" :src="userStore.avatar" alt="" />
          <span v-else class="avatar fallback">{{ initial }}</span>
          <span class="name">{{ userStore.username || '已登录' }}</span>
        </template>
        <RouterLink v-else to="/login" class="login">
          <LogIn :size="16" />
          <span>未登录</span>
        </RouterLink>
      </div>
    </div>
  </nav>
</template>

<script setup>
import { computed } from 'vue'
import { BarChart3, CircleCheck, LibraryBig, LogIn, SquarePen } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import { useUserStore } from '@/stores/user'

const emit = defineEmits(['new-chat'])

const userStore = useUserStore()

const navItems = [
  { label: '知识库', path: '/knowledge', icon: LibraryBig },
  { label: 'Dashboard', path: '/dashboard', icon: BarChart3 },
  { label: '评测', path: '/eval', icon: CircleCheck }
]

const initial = computed(() => (userStore.username || '?').slice(0, 1).toUpperCase())

function onNewChat() {
  emit('new-chat')
}
</script>

<style lang="less" scoped>
.session-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 8px;
  font-size: 14px;
}

.new-chat {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-strong);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;

  &:hover {
    background: var(--surface-hover);
  }
}

.sessions {
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 16px;
  overflow-y: auto;
}

.group-title {
  padding: 0 10px;
  color: var(--text-faint);
  font-size: 12px;
}

.empty {
  padding: 8px 10px;
  color: var(--text-faint);
  font-size: 13px;
}

.bottom {
  flex: 0 0 auto;
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  color: var(--text-muted);
  text-decoration: none;
  transition: background-color 0.15s ease, color 0.15s ease;

  &:hover {
    background: var(--surface-hover);
    color: var(--text-strong);
  }

  &.router-link-active {
    background: var(--surface-hover);
    color: var(--text-strong);
  }
}

.user {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 8px 10px;
  color: var(--text-muted);
}

.avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;

  &.fallback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-hover);
    color: var(--text-muted);
    font-size: 12px;
  }
}

.name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.login {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  text-decoration: none;

  &:hover {
    color: var(--text-strong);
  }
}
</style>
```

- [ ] **Step 2: 接进 AppShell**

`apps/web/src/layouts/AppShell.vue`：把左栏占位替换掉。

模板里：

```vue
    <aside v-if="!layout.leftCollapsed" class="sidebar">
      <SessionSidebar @new-chat="onNewChat" />
    </aside>
```

同时给 `<router-view>` 加上 key：

```vue
      <div class="content">
        <router-view :key="viewKey" />
      </div>
```

script 里加 import 与 handler：

```js
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SessionSidebar from '@/components/shell/SessionSidebar.vue'

const router = useRouter()

// 已经在对话页时 router.push('/agent') 不会重新挂载组件，点「新对话」会毫无反应。
// 递增 key 强制重挂载 ChatView，「全新对话」的语义正好等于「组件重新来过」，
// 连输入框草稿和错误提示一起清干净。
const chatKey = ref(0)
const viewKey = computed(() => (route.path === '/agent' ? `agent#${chatKey.value}` : route.path))

function onNewChat() {
  if (route.path === '/agent') {
    chatKey.value += 1
  } else {
    router.push('/agent')
  }
}
```

注意两处合并：`useRouter` 加进原有的 `vue-router` import，`ref` 加进原有的 `vue` import。

- [ ] **Step 3: 构建验证**

Run: `pnpm --filter @petrel/web run build`
Expected: 构建成功

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/shell/SessionSidebar.vue apps/web/src/layouts/AppShell.vue
git commit -m "feat(web): 左栏 SessionSidebar"
```

---

## Task 6: WorkspacePanel

**Files:**
- Create: `apps/web/src/utils/toolCall.js`
- Test: `apps/web/src/utils/toolCall.test.js`
- Create: `apps/web/src/components/shell/WorkspacePanel.vue`
- Modify: `apps/web/src/layouts/AppShell.vue`（替换右栏占位）

**Interfaces:**
- Consumes: `useWorkspaceStore()`（Task 2）、`useLayoutStore()`（Task 1）
- Produces:
  - `TOOL_STATE_TEXT` — `{ running, done, error, pending }` 到中文文案的映射
  - `formatToolArgs(args) => string`
  - `extractToolResultText(result) => string`
  - `WorkspacePanel.vue`，**无 props**，全部数据来自 workspace store

组件不接 props 是有意的：右栏与产生数据的 ChatView 是兄弟组件，只能通过 store 通信。
好处是这个组件给一份 store 状态就能独立渲染。

格式化逻辑抽进 `utils/toolCall.js` 是因为 Task 10 的 `ToolCallBlock` 要用同一套——
中栏内联展开和右栏细读展示的是同一份数据，两处各写一遍迟早会漂移。

- [ ] **Step 1: 写 toolCall 工具函数的失败测试**

创建 `apps/web/src/utils/toolCall.test.js`：

```js
import { describe, expect, it } from 'vitest'
import { extractToolResultText, formatToolArgs, TOOL_STATE_TEXT } from './toolCall.js'

describe('TOOL_STATE_TEXT', () => {
  it('覆盖四种执行状态', () => {
    expect(TOOL_STATE_TEXT).toEqual({
      running: '执行中',
      done: '完成',
      error: '失败',
      pending: '待执行'
    })
  })
})

describe('formatToolArgs', () => {
  it('空参数显示占位文案', () => {
    expect(formatToolArgs(null)).toBe('(无)')
    expect(formatToolArgs(undefined)).toBe('(无)')
  })

  it('字符串参数原样返回', () => {
    expect(formatToolArgs('raw')).toBe('raw')
  })

  it('对象参数格式化为缩进 JSON', () => {
    expect(formatToolArgs({ a: 1 })).toBe('{\n  "a": 1\n}')
  })
})

describe('extractToolResultText', () => {
  it('没有结果时返回空串', () => {
    expect(extractToolResultText(null)).toBe('')
  })

  it('从 pi 的 content block 数组里取文本并按行拼接', () => {
    const result = {
      content: [
        { type: 'text', text: '第一行' },
        { type: 'image', data: 'ignored' },
        { type: 'text', text: '第二行' }
      ]
    }
    expect(extractToolResultText(result)).toBe('第一行\n第二行')
  })

  it('没有文本块时回退到原始 JSON', () => {
    const result = { content: [{ type: 'image', data: 'x' }] }
    expect(extractToolResultText(result)).toContain('"type": "image"')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run apps/web/src/utils/toolCall.test.js`
Expected: FAIL，无法解析 `./toolCall.js`

- [ ] **Step 3: 实现 toolCall 工具函数**

创建 `apps/web/src/utils/toolCall.js`：

```js
/**
 * 工具调用的展示格式化。
 *
 * 中栏的 ToolCallBlock 内联展开与右栏的 WorkspacePanel 细读用的是同一份数据，
 * 格式化逻辑放这里共用，避免两处各写一遍后慢慢漂移。
 */

export const TOOL_STATE_TEXT = {
  running: '执行中',
  done: '完成',
  error: '失败',
  pending: '待执行'
}

export function formatToolArgs(args) {
  if (args === undefined || args === null) return '(无)'
  return typeof args === 'string' ? args : JSON.stringify(args, null, 2)
}

/** pi 的工具结果是 content block 数组，取其中的文本；一个文本块都没有就退回原始 JSON */
export function extractToolResultText(result) {
  if (!result) return ''
  const blocks = Array.isArray(result.content) ? result.content : []
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return text || JSON.stringify(result, null, 2)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run apps/web/src/utils/toolCall.test.js`
Expected: PASS，7 个用例通过

- [ ] **Step 5: 实现 WorkspacePanel**

创建 `apps/web/src/components/shell/WorkspacePanel.vue`：

```vue
<template>
  <div class="workspace-panel">
    <header class="head">
      <span class="head-title">工作区</span>
      <button class="icon-btn" type="button" title="收起工作区" @click="layout.toggleRight()">
        <PanelRightClose :size="16" />
      </button>
    </header>

    <section class="section">
      <div class="section-title">工具调用</div>

      <div v-if="!active" class="empty">未选择工具调用</div>
      <template v-else>
        <div class="tool-head">
          <span class="tool-name">{{ active.name }}</span>
          <span class="tool-state" :class="active.state">{{ stateText }}</span>
          <span v-if="active.ms !== undefined" class="tool-ms">{{ active.ms }}ms</span>
        </div>

        <div class="block-title">参数</div>
        <pre class="block">{{ formattedArgs }}</pre>

        <template v-if="resultText">
          <div class="block-title">结果</div>
          <pre class="block">{{ resultText }}</pre>
        </template>
      </template>
    </section>

    <section class="section">
      <div class="section-title">引用</div>
      <div class="empty">暂无引用，等待知识库检索接入</div>
    </section>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { PanelRightClose } from 'lucide-vue-next'
import { useLayoutStore } from '@/stores/layout'
import { useWorkspaceStore } from '@/stores/workspace'
import { extractToolResultText, formatToolArgs, TOOL_STATE_TEXT } from '@/utils/toolCall'

const layout = useLayoutStore()
const workspace = useWorkspaceStore()

const active = computed(() => workspace.activeToolCall)
const stateText = computed(() => TOOL_STATE_TEXT[active.value?.state] ?? '')
const formattedArgs = computed(() => formatToolArgs(active.value?.args))
const resultText = computed(() => extractToolResultText(active.value?.result))
</script>

<style lang="less" scoped>
.workspace-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
}

.head {
  display: flex;
  flex: 0 0 44px;
  align-items: center;
  padding: 0 12px;
}

.head-title {
  margin-right: auto;
  color: var(--text-strong);
  font-size: 13px;
}

.section {
  padding: 12px 16px;

  & + .section {
    border-top: 1px solid var(--border-subtle);
  }
}

.section-title {
  margin-bottom: 8px;
  color: var(--text-faint);
  font-size: 12px;
}

.empty {
  color: var(--text-faint);
  font-size: 13px;
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 13px;
}

.tool-name {
  color: var(--text-strong);
  font-family: monospace;
}

.tool-state {
  color: var(--text-muted);

  &.running {
    color: var(--main-color);
  }

  &.error {
    color: var(--color-error-500);
  }
}

.tool-ms {
  margin-left: auto;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.block-title {
  margin-bottom: 4px;
  color: var(--text-faint);
  font-size: 12px;
}

.block {
  margin: 0 0 12px;
  max-height: 320px;
  padding: 8px;
  overflow: auto;
  border-radius: 8px;
  background: var(--surface-subtle);
  color: var(--text-strong);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
```

- [ ] **Step 6: 接进 AppShell**

`apps/web/src/layouts/AppShell.vue`：右栏占位替换为

```vue
      <aside class="workspace" :style="{ width: `${layout.rightWidth}px` }">
        <WorkspacePanel />
      </aside>
```

script 里加一行 import：

```js
import WorkspacePanel from '@/components/shell/WorkspacePanel.vue'
```

`AppShell` 不需要为右栏传任何数据——它只负责给右栏留出位置和宽度，内容由 store 驱动。

- [ ] **Step 7: 构建验证**

Run: `pnpm --filter @petrel/web run build`
Expected: 构建成功

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/utils/toolCall.js apps/web/src/utils/toolCall.test.js apps/web/src/components/shell/WorkspacePanel.vue apps/web/src/layouts/AppShell.vue
git commit -m "feat(web): 右栏 WorkspacePanel 与工具调用格式化"
```

---

## Task 7: apis/http.js

**Files:**
- Create: `apps/web/src/apis/http.js`
- Test: `apps/web/src/apis/http.test.js`
- Modify: `apps/web/src/main.js`
- Modify: `apps/web/src/apis/base.js`（只加文件头注释）

**Interfaces:**
- Consumes: `useUserStore()`（现有：`token`、`logout()`）
- Produces:
  - `request(url, { method, body, headers, signal, responseType }) => Promise<any>`
  - `get(url, options)`、`post(url, body, options)`、`put(url, body, options)`、`del(url, options)`
  - `setUnauthorizedHandler(handler: () => void)`

**为什么 401 用回调而不是直接 import router**：`router/index.js` 会静态引入一堆 `.vue`，
在 vitest 里（没有 vue 插件）无法解析，`http.js` 一旦 import 它就完全不可测。
由 `main.js` 在启动时注册跳转行为，`http.js` 保持对路由零依赖。

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/apis/http.test.js`：

```js
// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUserStore } from '@/stores/user'
import { get, post, request, setUnauthorizedHandler } from './http.js'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  setUnauthorizedHandler(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('request', () => {
  it('没有 token 时不注入 Authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await get('/api/system/health')

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })

  it('有 token 时注入 Bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    useUserStore().token = 'abc123'

    await get('/api/whatever')

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer abc123')
  })

  it('对象 body 自动序列化并带 JSON Content-Type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await post('/api/chat', { message: '你好' })

    const init = fetchMock.mock.calls[0][1]
    expect(init.body).toBe('{"message":"你好"}')
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  it('FormData 不设 Content-Type，交给浏览器加 boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const form = new FormData()
    form.append('file', 'x')
    await post('/api/upload', form)

    const init = fetchMock.mock.calls[0][1]
    expect(init.headers['Content-Type']).toBeUndefined()
    expect(init.body).toBe(form)
  })

  it('401 时登出并触发未授权处理器', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ detail: '无效令牌' }, 401)))
    const userStore = useUserStore()
    userStore.token = 'expired'
    const handler = vi.fn()
    setUnauthorizedHandler(handler)

    await expect(get('/api/whatever')).rejects.toThrow('登录已失效，请重新登录')
    expect(userStore.token).toBe('')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('非 2xx 时抛出后端给的错误文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ detail: '知识库不存在' }, 404)))

    await expect(get('/api/kb/1')).rejects.toThrow('知识库不存在')
  })

  it('后端没给文案时回落到状态码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 502 })))

    await expect(get('/api/whatever')).rejects.toThrow('请求失败（HTTP 502）')
  })

  it('非 JSON 响应返回文本', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('plain', { headers: { 'Content-Type': 'text/plain' } }))
    )

    await expect(request('/api/text')).resolves.toBe('plain')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run apps/web/src/apis/http.test.js`
Expected: FAIL，无法解析 `./http.js`

- [ ] **Step 3: 实现 http.js**

创建 `apps/web/src/apis/http.js`：

```js
import { useUserStore } from '@/stores/user'

/**
 * v0.5 的 HTTP 封装。
 *
 * 与 base.js 的区别：不做 admin/superadmin 权限预检（那是 v0.4 的角色模型，
 * 等 HEU-7 定了认证范围再说），401 的跳转行为由外部注册而不是写死。
 */

let unauthorizedHandler = null

/** 由 main.js 在启动时注册。放在这里是为了让本模块对 router 零依赖，从而可测。 */
export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler
}

async function readErrorMessage(response) {
  try {
    const body = await response.json()
    return body?.error?.message ?? body?.detail ?? body?.message ?? ''
  } catch {
    return ''
  }
}

export async function request(url, options = {}) {
  const { method = 'GET', body, headers = {}, signal, responseType = 'json' } = options

  const isFormData = body instanceof FormData
  const finalHeaders = { ...headers }
  // FormData 必须让浏览器自己带 boundary，手动设 Content-Type 会让后端解析失败
  if (body !== undefined && !isFormData && finalHeaders['Content-Type'] === undefined) {
    finalHeaders['Content-Type'] = 'application/json'
  }

  const userStore = useUserStore()
  if (userStore.token) {
    finalHeaders.Authorization = `Bearer ${userStore.token}`
  }

  let payload
  if (body !== undefined) {
    payload = isFormData ? body : JSON.stringify(body)
  }

  const response = await fetch(url, { method, headers: finalHeaders, body: payload, signal })

  if (response.status === 401) {
    userStore.logout()
    unauthorizedHandler?.()
    throw new Error('登录已失效，请重新登录')
  }

  if (!response.ok) {
    throw new Error((await readErrorMessage(response)) || `请求失败（HTTP ${response.status}）`)
  }

  if (responseType === 'raw') return response
  if (responseType === 'text') return response.text()

  const contentType = response.headers.get('Content-Type') ?? ''
  return contentType.includes('application/json') ? response.json() : response.text()
}

export const get = (url, options) => request(url, { ...options, method: 'GET' })
export const post = (url, body, options) => request(url, { ...options, method: 'POST', body })
export const put = (url, body, options) => request(url, { ...options, method: 'PUT', body })
export const del = (url, options) => request(url, { ...options, method: 'DELETE' })
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run apps/web/src/apis/http.test.js`
Expected: PASS，8 个用例通过

- [ ] **Step 5: 在 main.js 注册 401 跳转**

`apps/web/src/main.js`，在 `app.use(router)` 之后、`app.mount` 之前插入：

```js
// 401 的跳转行为在这里接线，http.js 本身不依赖 router
import { setUnauthorizedHandler } from '@/apis/http'
setUnauthorizedHandler(() => {
  const redirect = router.currentRoute.value.fullPath
  router.push({ path: '/login', query: { redirect } })
})
```

- [ ] **Step 6: 给 base.js 加废弃说明**

`apps/web/src/apis/base.js` 第 1 行之前插入：

```js
/**
 * @deprecated v0.4 遗留的 HTTP 封装，仍被知识库 / Dashboard / 评测等旧页面使用。
 * 新代码请用 ./http.js。两者收敛的时机是旧页面按 HEU-21 / HEU-28 重写时。
 */
```

- [ ] **Step 7: 构建验证**

Run: `pnpm --filter @petrel/web run build`
Expected: 构建成功

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/apis/http.js apps/web/src/apis/http.test.js apps/web/src/apis/base.js apps/web/src/main.js
git commit -m "feat(web): http 封装与 401 处理"
```

---

## Task 8: 路由重写、守卫关闭与 EvalView

**Files:**
- Create: `apps/web/src/views/EvalView.vue`
- Modify: `apps/web/src/router/index.js`（整份重写）

**Interfaces:**
- Consumes: `AppShell.vue`（Task 4-6）
- Produces: 路由 `meta` 约定——`workspace: true` 表示该页需要右栏，`title` 是中栏工具条显示的标题

**`EvalView` 只能是空态页**：现有 `EvaluationBenchmarks` 声明了 `databaseId` 这个 required prop，
它是知识库详情页的子 tab，没有知识库上下文时挂载不了。

- [ ] **Step 1: 实现 EvalView**

创建 `apps/web/src/views/EvalView.vue`：

```vue
<template>
  <div class="eval-view">
    <CircleCheck :size="18" />
    <p class="title">评测功能开发中</p>
    <p class="hint">等待后端评测 runner 接口（HEU-29）落地。</p>
    <p class="hint">现阶段的基准测试在知识库详情页内使用。</p>
  </div>
</template>

<script setup>
import { CircleCheck } from 'lucide-vue-next'
</script>

<style lang="less" scoped>
.eval-view {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 100%;
  padding: 80px 20px;
  color: var(--text-faint);
}

.title {
  margin: 8px 0 0;
  color: var(--text-muted);
  font-size: 14px;
}

.hint {
  margin: 0;
  font-size: 13px;
}
</style>
```

- [ ] **Step 2: 重写路由**

`apps/web/src/router/index.js` 整份替换为：

```js
import { createRouter, createWebHistory } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import BlankLayout from '@/layouts/BlankLayout.vue'

/**
 * meta 约定：
 * - workspace: true  该页需要右栏工作区
 * - title            中栏顶部工具条显示的标题
 * - requiresAuth     HEU-7 落地前一律 false，见文件末尾的守卫说明
 */
const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'main',
      component: BlankLayout,
      children: [
        {
          path: '',
          name: 'Home',
          component: () => import('../views/HomeView.vue'),
          meta: { keepAlive: true, requiresAuth: false }
        }
      ]
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
      meta: { requiresAuth: false }
    },
    {
      path: '/agent',
      name: 'AgentMain',
      component: AppShell,
      children: [
        {
          path: '',
          name: 'Chat',
          component: () => import('../views/ChatView.vue'),
          meta: { requiresAuth: false, workspace: true, title: '新对话' }
        }
      ]
    },
    {
      path: '/knowledge',
      name: 'knowledge',
      component: AppShell,
      children: [
        {
          path: '',
          name: 'KnowledgeList',
          component: () => import('../views/DataBaseView.vue'),
          meta: { keepAlive: true, requiresAuth: false, title: '知识库' }
        },
        {
          path: ':database_id',
          name: 'KnowledgeDetail',
          component: () => import('../views/DataBaseInfoView.vue'),
          meta: { keepAlive: false, requiresAuth: false, title: '知识库' }
        }
      ]
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: AppShell,
      children: [
        {
          path: '',
          name: 'DashboardComp',
          component: () => import('../views/DashboardView.vue'),
          meta: { keepAlive: false, requiresAuth: false, title: 'Dashboard' }
        }
      ]
    },
    {
      path: '/eval',
      name: 'eval',
      component: AppShell,
      children: [
        {
          path: '',
          name: 'EvalComp',
          component: () => import('../views/EvalView.vue'),
          meta: { requiresAuth: false, title: '评测' }
        }
      ]
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'NotFound',
      component: () => import('../views/EmptyView.vue'),
      meta: { requiresAuth: false }
    }
  ]
})

/**
 * 认证守卫暂时关闭：agent-server 还没有任何认证接口（HEU-7 未做）。
 *
 * HEU-7 落地后要做的事：
 * 1. 给需要登录的路由把 meta.requiresAuth 改回 true
 * 2. 打开下面被注释的分支
 *
 * 原来的 requiresAdmin 分支已整段删除而不是注释保留：它会调
 * agentStore.initialize() 打 v0.4 的 Python API，必然抛错。留着它，
 * 关掉认证的结果不是「不校验」而是「导航时报错」。
 * 角色模型要等 HEU-7 定了范围再重写。
 */
router.beforeEach((to, from, next) => {
  // const userStore = useUserStore()
  // if (to.meta.requiresAuth === true && !userStore.isLoggedIn) {
  //   next({ path: '/login', query: { redirect: to.fullPath } })
  //   return
  // }
  next()
})

export default router
```

- [ ] **Step 3: 构建验证**

Run: `pnpm --filter @petrel/web run build`
Expected: 构建成功

- [ ] **Step 4: 起容器人工验证**

```bash
docker compose up -d
docker logs petrel-web-dev --tail 30
```

浏览器打开 `http://localhost:5173/agent`，确认：
- 左栏 240px 显示「新对话 / 会话 / 知识库·Dashboard·评测 / 未登录」
- 中栏顶部有两个折叠按钮与标题「新对话」
- 右栏显示「工作区 / 未选择工具调用 / 暂无引用」
- 点左栏三个入口能切页，且都套在同一 shell 内（知识库与 Dashboard 会报接口错误，属预期）
- `/eval` 显示空态页

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/views/EvalView.vue apps/web/src/router/index.js
git commit -m "feat(web): 路由接入 AppShell 并关闭认证守卫"
```

---

## Task 9: MessageItem 气泡改造

**Files:**
- Modify: `apps/web/src/components/chat/MessageItem.vue`

**Interfaces:**
- Consumes: 不变（props：`message`、`toolCalls`、`streaming`、`editorId`）
- Produces: 不变

改动：去掉消息间分隔线与角色标签；用户消息改右对齐气泡；助手消息底部加复制按钮；错误配色换成 `--color-error-*`。

- [ ] **Step 1: 改模板**

`apps/web/src/components/chat/MessageItem.vue` 的 `<template>` 整段替换为：

```vue
<template>
  <!-- toolResult 消息不单独渲染，结果已并入对应的 ToolCallBlock -->
  <div v-if="message.role !== 'toolResult'" class="message" :class="message.role">
    <div class="body">
      <template v-for="(block, index) in blocks" :key="index">
        <div v-if="block.type === 'thinking'" class="thinking">
          <button class="line-toggle" type="button" @click="showThinking = !showThinking">
            <Brain :size="14" />
            <span>思考过程</span>
            <ChevronRight class="chevron" :class="{ open: showThinking }" :size="14" />
          </button>
          <pre v-if="showThinking" class="thinking-body">{{ block.thinking }}</pre>
        </div>

        <ToolCallBlock
          v-else-if="block.type === 'toolCall'"
          :tool-call="block"
          :detail="toolCalls[block.id] ?? {}"
        />

        <MdPreview
          v-else-if="block.type === 'text' && block.text"
          :editor-id="`msg-${editorId}-${index}`"
          :model-value="block.text"
          :theme="theme"
          preview-theme="github"
          :show-code-row-number="false"
          class="markdown"
        />
      </template>

      <!-- 模型调用失败时 pi 不发 error 帧，而是把原因放在消息的 errorMessage 上 -->
      <div v-if="message.errorMessage" class="message-error">
        <TriangleAlert :size="14" />
        <span>{{ message.errorMessage }}</span>
      </div>

      <span v-if="streaming" class="cursor" />
    </div>

    <div v-if="message.role === 'assistant' && !streaming" class="actions">
      <button class="icon-btn" type="button" :title="copied ? '已复制' : '复制'" @click="copy">
        <Check v-if="copied" :size="14" />
        <Copy v-else :size="14" />
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 改 script**

`<script setup>` 整段替换为：

```js
import { computed, ref } from 'vue'
import { Brain, Check, ChevronRight, Copy, TriangleAlert } from 'lucide-vue-next'
import { MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/preview.css'
import { useThemeStore } from '@/stores/theme'
import ToolCallBlock from './ToolCallBlock.vue'

const props = defineProps({
  /** pi 的 AgentMessage */
  message: { type: Object, required: true },
  toolCalls: { type: Object, default: () => ({}) },
  streaming: { type: Boolean, default: false },
  editorId: { type: [String, Number], default: 0 }
})

const showThinking = ref(false)
const copied = ref(false)
const themeStore = useThemeStore()
const theme = computed(() => (themeStore.isDark ? 'dark' : 'light'))

/** pi 的 content 可能是字符串（用户输入）或 content block 数组 */
const blocks = computed(() => {
  const content = props.message.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
})

const plainText = computed(() =>
  blocks.value
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
)

async function copy() {
  try {
    await navigator.clipboard.writeText(plainText.value)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    // http 环境下 clipboard 不可用，静默失败好过弹一个用户无法处理的错误
  }
}
```

- [ ] **Step 3: 改样式**

`<style lang="less" scoped>` 整段替换为：

```less
.message {
  padding: 12px 0;
}

// 用户消息右对齐成气泡，助手消息全宽无气泡——这是两者最直观的区分方式，
// 比加角色标签更省视觉噪音
.user {
  display: flex;
  justify-content: flex-end;

  .body {
    max-width: 70%;
    padding: 10px 14px;
    border-radius: 18px;
    background: var(--surface-subtle);
    color: var(--text-strong);
    white-space: pre-wrap;
    word-break: break-word;
  }
}

.assistant .body {
  color: var(--text-strong);
}

.thinking {
  margin: 4px 0 8px;
}

.line-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;

  &:hover {
    background: var(--surface-hover);
    color: var(--text-strong);
  }
}

.chevron {
  transition: transform 0.15s;

  &.open {
    transform: rotate(90deg);
  }
}

.thinking-body {
  margin: 4px 0 0;
  padding: 8px;
  border-radius: 8px;
  background: var(--surface-subtle);
  color: var(--text-muted);
  font-size: 12px;
  white-space: pre-wrap;
}

.markdown {
  background: transparent;

  :deep(.md-editor-preview-wrapper) {
    padding: 0;
  }
}

.message-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--color-error-50);
  color: var(--color-error-700);
  font-size: 13px;
  word-break: break-word;
}

.actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}

.cursor {
  display: inline-block;
  width: 2px;
  height: 15px;
  vertical-align: text-bottom;
  background: var(--main-color);
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}
```

- [ ] **Step 4: 构建验证**

Run: `pnpm --filter @petrel/web run build`
Expected: 构建成功

- [ ] **Step 5: 人工验证**

浏览器打开 `/agent`，发一条消息，确认：
- 用户消息在右侧、浅灰圆角气泡、最宽 70%
- 助手消息全宽无气泡，消息之间没有横线
- 助手消息回复完成后下方出现复制按钮，点击后图标变对勾

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/chat/MessageItem.vue
git commit -m "refactor(web): 消息气泡形态改造"
```

---

## Task 10: ToolCallBlock 降噪与送右栏入口

**Files:**
- Modify: `apps/web/src/components/chat/ToolCallBlock.vue`

**Interfaces:**
- Consumes: `useWorkspaceStore()`（Task 2）、`useLayoutStore()`（Task 1）；props 不变（`toolCall`、`detail`）
- Produces: 不变

两个独立入口：点摘要行 = 中栏内联展开；点 `↗` = 送右栏。右栏折叠时点 `↗` 自动展开右栏。

- [ ] **Step 1: 改模板**

`apps/web/src/components/chat/ToolCallBlock.vue` 的 `<template>` 整段替换为：

```vue
<template>
  <div class="tool-call" :class="state">
    <div class="summary-row">
      <button class="summary" type="button" @click="expanded = !expanded">
        <ChevronRight class="chevron" :class="{ open: expanded }" :size="14" />
        <span class="name">{{ toolCall.name }}</span>
        <span class="dot">·</span>
        <span class="state-text">{{ stateText }}</span>
        <template v-if="detail.ms !== undefined">
          <span class="dot">·</span>
          <span class="ms">{{ detail.ms }}ms</span>
        </template>
      </button>

      <button class="icon-btn send" type="button" title="在工作区查看" @click="sendToWorkspace">
        <ArrowUpRight :size="14" />
      </button>
    </div>

    <div v-if="expanded" class="detail">
      <div class="section">
        <div class="label">参数</div>
        <pre>{{ formattedArgs }}</pre>
      </div>
      <div v-if="resultText" class="section">
        <div class="label">结果</div>
        <pre>{{ resultText }}</pre>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 改 script**

在现有 `<script setup>` 的 import 区加入 workspace / layout store 与新图标，并加上 `sendToWorkspace`。
整段替换为：

```js
import { computed, ref, watch } from 'vue'
import { ArrowUpRight, ChevronRight } from 'lucide-vue-next'
import { useLayoutStore } from '@/stores/layout'
import { useWorkspaceStore } from '@/stores/workspace'
import { extractToolResultText, formatToolArgs, TOOL_STATE_TEXT } from '@/utils/toolCall'

const props = defineProps({
  /** pi 的 toolCall content block：{ id, name, arguments } */
  toolCall: { type: Object, required: true },
  /** useAgentStream 里由 tool_execution_* 事件归约出的执行状态 */
  detail: { type: Object, default: () => ({}) }
})

const expanded = ref(false)
const layout = useLayoutStore()
const workspace = useWorkspaceStore()

const state = computed(() => props.detail.state ?? 'pending')
const stateText = computed(() => TOOL_STATE_TEXT[state.value])
// detail.args 来自 tool_execution_start 事件，工具还没开始执行时退回 content block 里的参数
const args = computed(() => props.detail.args ?? props.toolCall.arguments)
const formattedArgs = computed(() => formatToolArgs(args.value))
const resultText = computed(() => extractToolResultText(props.detail.result))

/** 右栏与本组件是兄弟关系，注入不到，只能把完整快照写进 store */
function snapshot() {
  return {
    id: props.toolCall.id,
    name: props.toolCall.name,
    state: state.value,
    args: args.value,
    result: props.detail.result,
    ms: props.detail.ms
  }
}

// 右栏折叠时也要能送过去，否则用户点了没有任何反馈
function sendToWorkspace() {
  workspace.openToolCall(snapshot())
  layout.expandRight()
}

// 工具执行中就被送到右栏时，后续的状态与结果要跟着更新，
// 否则右栏会一直停在「执行中」
watch(
  () => props.detail,
  () => {
    if (workspace.activeToolCallId === props.toolCall.id) {
      workspace.syncToolCall(snapshot())
    }
  },
  { deep: true }
)
```

- [ ] **Step 3: 改样式**

`<style lang="less" scoped>` 整段替换为：

```less
// 从带边框的卡片降为一行低调摘要：工具调用是过程信息，不该和回答内容抢注意力
.tool-call {
  margin: 4px 0;
  font-size: 13px;
}

.summary-row {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 6px;
  transition: background-color 0.15s ease;

  &:hover {
    background: var(--surface-hover);
  }

  // 送右栏的入口只在 hover 时出现，避免每一行都挂一个常驻图标
  .send {
    opacity: 0;
  }

  &:hover .send {
    opacity: 1;
  }
}

.summary {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 4px 6px;
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.chevron {
  flex-shrink: 0;
  transition: transform 0.15s;

  &.open {
    transform: rotate(90deg);
  }
}

.name {
  color: var(--text-strong);
  font-family: monospace;
}

.dot {
  color: var(--text-faint);
}

.running .state-text {
  color: var(--main-color);
}

.error .state-text {
  color: var(--color-error-500);
}

.ms {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.detail {
  padding: 4px 6px 8px 24px;
}

.section + .section {
  margin-top: 8px;
}

.label {
  margin-bottom: 4px;
  color: var(--text-faint);
  font-size: 12px;
}

pre {
  margin: 0;
  max-height: 240px;
  padding: 8px;
  overflow: auto;
  border-radius: 8px;
  background: var(--surface-subtle);
  color: var(--text-strong);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
```

- [ ] **Step 4: 构建验证**

Run: `pnpm --filter @petrel/web run build`
Expected: 构建成功

- [ ] **Step 5: 人工验证**

浏览器发「现在几点」触发工具调用，确认：
- 工具行是一行灰字，没有边框卡片
- 点这一行能在中栏内联展开参数与结果
- hover 时行尾出现 `↗`，点它右栏显示同一份详情
- 先收起右栏再点 `↗`，右栏自动展开
- 在工具还显示「执行中」时点 `↗`，等它跑完，右栏的状态与结果跟着更新

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/chat/ToolCallBlock.vue
git commit -m "refactor(web): 工具调用行降噪并支持送入工作区"
```

---

## Task 11: `/` 命令面板

**Files:**
- Create: `apps/web/src/composables/useCommandPalette.js`
- Test: `apps/web/src/composables/useCommandPalette.test.js`
- Create: `apps/web/src/components/chat/CommandPalette.vue`

**Interfaces:**
- Consumes: 无
- Produces:
  - `filterCommands(commands, query) => Command[]` — `query` 是不含前导 `/` 的字符串，按 `name` 前缀匹配，大小写不敏感
  - `useCommandPalette(commands)` => `{ open, query, filtered, activeIndex, openWith(query), close(), moveDown(), moveUp(), pick() }`
  - `Command` 形状：`{ name: string, description: string, run: () => void }`
  - `CommandPalette.vue` props：`commands: Array`、`query: String`、`activeIndex: Number`；emit：`pick(command)`、`hover(index)`

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/composables/useCommandPalette.test.js`：

```js
import { describe, expect, it, vi } from 'vitest'
import { filterCommands, useCommandPalette } from './useCommandPalette.js'

const COMMANDS = [
  { name: 'new', description: '新对话', run: () => {} },
  { name: 'workspace', description: '开合右栏', run: () => {} },
  { name: 'sidebar', description: '开合左栏', run: () => {} }
]

describe('filterCommands', () => {
  it('空查询返回全部命令', () => {
    expect(filterCommands(COMMANDS, '')).toHaveLength(3)
  })

  it('按前缀匹配且大小写不敏感', () => {
    expect(filterCommands(COMMANDS, 'WOR').map((c) => c.name)).toEqual(['workspace'])
  })

  it('无匹配时返回空数组', () => {
    expect(filterCommands(COMMANDS, 'zzz')).toEqual([])
  })
})

describe('useCommandPalette', () => {
  it('openWith 打开面板并重置选中项', () => {
    const palette = useCommandPalette(COMMANDS)
    palette.openWith('')
    expect(palette.open.value).toBe(true)
    expect(palette.activeIndex.value).toBe(0)
  })

  it('没有匹配项时自动关闭，避免拦截正常输入', () => {
    const palette = useCommandPalette(COMMANDS)
    palette.openWith('zzz')
    expect(palette.open.value).toBe(false)
  })

  it('moveDown 到底部后回到第一项', () => {
    const palette = useCommandPalette(COMMANDS)
    palette.openWith('')
    palette.moveDown()
    palette.moveDown()
    palette.moveDown()
    expect(palette.activeIndex.value).toBe(0)
  })

  it('moveUp 从第一项跳到最后一项', () => {
    const palette = useCommandPalette(COMMANDS)
    palette.openWith('')
    palette.moveUp()
    expect(palette.activeIndex.value).toBe(2)
  })

  it('pick 执行当前选中命令并关闭面板', () => {
    const run = vi.fn()
    const palette = useCommandPalette([{ name: 'new', description: '新对话', run }])
    palette.openWith('')
    palette.pick()
    expect(run).toHaveBeenCalledOnce()
    expect(palette.open.value).toBe(false)
  })

  it('面板关闭时 pick 不执行任何命令', () => {
    const run = vi.fn()
    const palette = useCommandPalette([{ name: 'new', description: '新对话', run }])
    palette.pick()
    expect(run).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run apps/web/src/composables/useCommandPalette.test.js`
Expected: FAIL，无法解析 `./useCommandPalette.js`

- [ ] **Step 3: 实现 composable**

创建 `apps/web/src/composables/useCommandPalette.js`：

```js
import { computed, ref } from 'vue'

/**
 * `/` 命令的过滤与键盘导航。
 *
 * 命令的具体行为由调用方定义，本模块只认 { name, description, run } 这个形状，
 * 因此可以脱离组件单测。
 *
 * @typedef {{ name: string, description: string, run: () => void }} Command
 */

/** @param {Command[]} commands @param {string} query 不含前导斜杠 */
export function filterCommands(commands, query) {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return commands
  return commands.filter((command) => command.name.toLowerCase().startsWith(keyword))
}

/** @param {Command[]} commands */
export function useCommandPalette(commands) {
  const open = ref(false)
  const query = ref('')
  const activeIndex = ref(0)

  const filtered = computed(() => filterCommands(commands, query.value))

  function close() {
    open.value = false
    query.value = ''
    activeIndex.value = 0
  }

  function openWith(nextQuery) {
    query.value = nextQuery
    activeIndex.value = 0
    // 没有匹配项就直接关掉：用户在输入 /usr/bin 这类内容时，
    // 面板不该赖着不走并抢走回车键
    open.value = filtered.value.length > 0
  }

  function moveDown() {
    if (!filtered.value.length) return
    activeIndex.value = (activeIndex.value + 1) % filtered.value.length
  }

  function moveUp() {
    if (!filtered.value.length) return
    activeIndex.value = (activeIndex.value - 1 + filtered.value.length) % filtered.value.length
  }

  function pick(index = activeIndex.value) {
    if (!open.value) return false
    const command = filtered.value[index]
    if (!command) return false
    command.run()
    close()
    return true
  }

  return { open, query, filtered, activeIndex, openWith, close, moveDown, moveUp, pick }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run apps/web/src/composables/useCommandPalette.test.js`
Expected: PASS，10 个用例通过

- [ ] **Step 5: 实现面板组件**

创建 `apps/web/src/components/chat/CommandPalette.vue`：

```vue
<template>
  <div class="command-palette">
    <button
      v-for="(command, index) in commands"
      :key="command.name"
      class="item"
      :class="{ active: index === activeIndex }"
      type="button"
      @mouseenter="emit('hover', index)"
      @click="emit('pick', index)"
    >
      <span class="name">/{{ command.name }}</span>
      <span class="description">{{ command.description }}</span>
    </button>
  </div>
</template>

<script setup>
defineProps({
  /** 已过滤好的命令列表，过滤逻辑在 useCommandPalette 里 */
  commands: { type: Array, default: () => [] },
  activeIndex: { type: Number, default: 0 }
})

const emit = defineEmits(['pick', 'hover'])
</script>

<style lang="less" scoped>
.command-palette {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  right: 0;
  z-index: 10;
  padding: 4px;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-app);
  // 全站唯一允许用阴影的地方：浮层没有层次就读不出它浮在内容之上
  box-shadow: 0 4px 16px var(--shadow-2);
}

.item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;

  &.active {
    background: var(--surface-hover);
  }
}

.name {
  color: var(--text-strong);
  font-family: monospace;
  font-size: 13px;
}

.description {
  color: var(--text-muted);
  font-size: 12px;
}
</style>
```

- [ ] **Step 6: 构建验证**

Run: `pnpm --filter @petrel/web run build`
Expected: 构建成功（组件尚未被引用，只验证能编译）

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/composables/useCommandPalette.js apps/web/src/composables/useCommandPalette.test.js apps/web/src/components/chat/CommandPalette.vue
git commit -m "feat(web): / 命令面板"
```

---

## Task 12: ChatView 整合

**Files:**
- Modify: `apps/web/src/views/ChatView.vue`（整份重写）

**Interfaces:**
- Consumes: `useAgentStream()`（不改）、`useLayoutStore()`、`useWorkspaceStore()`、`useCommandPalette()`、`CommandPalette.vue`、`MessageItem.vue`
- Produces: 无对外接口

改动要点：去掉自带顶栏（交给 AppShell 工具条）、Composer 重做、接入 `/` 命令。
右栏的数据由 `ToolCallBlock` 直接写进 workspace store，ChatView 不参与转发。

- [ ] **Step 1: 整份重写 ChatView**

`apps/web/src/views/ChatView.vue` 全文替换为：

```vue
<template>
  <div class="chat-view">
    <main ref="scrollArea" class="stream">
      <div class="inner">
        <div v-if="messages.length === 0" class="empty">
          <p>问点什么开始。</p>
          <p class="hint">试试「现在几点」，会触发一次工具调用。</p>
        </div>

        <MessageItem
          v-for="(message, index) in messages"
          :key="index"
          :message="message"
          :tool-calls="toolCalls"
          :editor-id="index"
          :streaming="running && index === messages.length - 1 && message.role === 'assistant'"
        />

        <div v-if="error" class="error">{{ error }}</div>
      </div>
    </main>

    <footer class="composer-wrap">
      <div class="inner">
        <div class="composer">
          <CommandPalette
            v-if="palette.open.value"
            :commands="palette.filtered.value"
            :active-index="palette.activeIndex.value"
            @pick="onPickCommand"
            @hover="palette.activeIndex.value = $event"
          />

          <textarea
            ref="input"
            v-model="draft"
            class="input"
            rows="1"
            placeholder="输入消息，Enter 发送，Shift+Enter 换行，/ 唤起命令"
            @input="onInput"
            @keydown="onKeydown"
          />

          <div class="actions">
            <button class="icon-btn" type="button" disabled title="附件上传待后端接口">
              <Plus :size="16" />
            </button>
            <button class="icon-btn" type="button" title="命令" @click="toggleCommands">
              <Slash :size="16" />
            </button>

            <span class="model">{{ MODEL_NAME }}</span>

            <button v-if="running" class="send stop" type="button" title="停止" @click="abort">
              <Square :size="14" />
            </button>
            <button
              v-else
              class="send"
              type="button"
              title="发送"
              :disabled="!draft.trim()"
              @click="submit"
            >
              <ArrowUp :size="16" />
            </button>
          </div>
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup>
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { ArrowUp, Plus, Slash, Square } from 'lucide-vue-next'
import CommandPalette from '@/components/chat/CommandPalette.vue'
import MessageItem from '@/components/chat/MessageItem.vue'
import { useAgentStream } from '@/composables/useAgentStream'
import { useCommandPalette } from '@/composables/useCommandPalette'
import { useLayoutStore } from '@/stores/layout'
import { useWorkspaceStore } from '@/stores/workspace'

/** packages/ai 目前只注册了这一个模型，所以这里是静态文字而不是下拉 */
const MODEL_NAME = 'DeepSeek-V3'

const { messages, toolCalls, running, error, send, abort, reset } = useAgentStream()

const layout = useLayoutStore()
const workspace = useWorkspaceStore()

// AppShell 用 key 强制重挂载来实现「新对话」，卸载时必须掐断在飞的请求，
// 否则旧对话的 SSE 会继续跑到没有组件接收它为止
onUnmounted(abort)

const draft = ref('')
const scrollArea = ref(null)
const input = ref(null)

function newChat() {
  reset()
  workspace.clear()
  draft.value = ''
}

const palette = useCommandPalette([
  { name: 'new', description: '新对话', run: newChat },
  { name: 'workspace', description: '开合右栏', run: () => layout.toggleRight() },
  { name: 'sidebar', description: '开合左栏', run: () => layout.toggleLeft() }
])

/** 只在整段输入以 / 开头时唤起面板，避免正文里的斜杠误触发 */
function onInput() {
  if (draft.value.startsWith('/')) {
    palette.openWith(draft.value.slice(1))
  } else if (palette.open.value) {
    palette.close()
  }
}

function toggleCommands() {
  if (palette.open.value) {
    palette.close()
    return
  }
  draft.value = '/'
  palette.openWith('')
  input.value?.focus()
}

function onPickCommand(index) {
  palette.pick(index)
  draft.value = ''
}

function onKeydown(event) {
  if (palette.open.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      palette.moveDown()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      palette.moveUp()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      palette.close()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      palette.pick()
      draft.value = ''
      return
    }
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
}

async function submit() {
  const text = draft.value.trim()
  if (!text || running.value) return
  draft.value = ''
  await send(text)
}

watch(
  () => [messages.value.length, messages.value.at(-1)],
  async () => {
    await nextTick()
    const el = scrollArea.value
    if (el) el.scrollTop = el.scrollHeight
  }
)
</script>

<style lang="less" scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--surface-app);
}

.stream {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

// 760px 是上限而非固定值：1280 下三栏全开时中栏只剩 680px，
// 让内容自然收窄，不挤压左右栏也不出横向滚动
.inner {
  max-width: 760px;
  margin: 0 auto;
  padding: 0 24px;
}

.empty {
  padding: 80px 0;
  color: var(--text-muted);
  text-align: center;

  .hint {
    color: var(--text-faint);
    font-size: 13px;
  }
}

.error {
  margin: 12px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-error-50);
  color: var(--color-error-700);
  font-size: 13px;
  word-break: break-word;
}

.composer-wrap {
  flex: 0 0 auto;
  padding: 8px 0 20px;
}

.composer {
  position: relative;
  padding: 10px 12px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 24px;
  background: var(--surface-app);
  transition: border-color 0.15s ease;

  &:focus-within {
    border-color: var(--text-faint);
  }
}

.input {
  display: block;
  width: 100%;
  max-height: 200px;
  border: none;
  background: transparent;
  color: var(--text-strong);
  font-family: inherit;
  font-size: 15px;
  line-height: 1.5;
  resize: none;

  &:focus {
    outline: none;
  }

  &::placeholder {
    color: var(--text-faint);
  }
}

.actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
}

.model {
  margin-left: auto;
  margin-right: 8px;
  color: var(--text-faint);
  font-size: 12px;
}

.send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 50%;
  background: var(--text-strong);
  color: var(--surface-app);
  cursor: pointer;
  transition: background-color 0.15s ease;

  &:disabled {
    background: var(--surface-hover);
    color: var(--text-faint);
    cursor: not-allowed;
  }

  &.stop {
    background: var(--text-muted);
  }
}
</style>
```

- [ ] **Step 2: 构建验证**

Run: `pnpm --filter @petrel/web run build`
Expected: 构建成功

- [ ] **Step 3: 跑全量测试**

Run: `pnpm test`
Expected: PASS，后端 4 个 + 前端 44 个用例（layout 9 · workspace 6 · resize 4 · toolCall 7 · http 8 · palette 10）全通过

- [ ] **Step 4: 人工验证**

浏览器打开 `/agent`：
- 发一条触发工具的消息，点工具行的 `↗`，右栏出现完整参数与结果
- 输入 `/`，面板列出三条命令；`↑` `↓` 能移动高亮；`Enter` 执行；`Esc` 关闭
- 输入 `/zzz`，面板消失且不拦截回车
- `+` 按钮是禁用态，hover 有 tooltip

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/views/ChatView.vue
git commit -m "feat(web): ChatView 接入三栏 shell 与命令面板"
```

---

## Task 13: 全量验收与文档更新

**Files:**
- Modify: `docs/frontend-plan.md`

- [ ] **Step 1: 全量构建与测试**

```bash
pnpm install
pnpm run build
pnpm test
```

Expected: 三条命令全部成功。构建产物里不应再有 1MB 级的 `GraphCanvas` chunk 被 `/agent` 链路引用
（图谱路由已摘除，但文件还在，会作为独立 chunk 存在——这是预期，删除是独立任务）。

- [ ] **Step 2: 起容器**

```bash
docker compose up -d
docker logs petrel-web-dev --tail 50
docker logs petrel-api-dev --tail 30
```

Expected: 两个容器都正常，浏览器控制台无报错。

- [ ] **Step 3: 逐项人工验收**

对照设计文档 §11 的清单逐项确认：

| # | 检查项 | ✓ |
| --- | --- | --- |
| 1 | 1920 三栏全开：左 240 / 右 360，中栏内容 760px 居中 | |
| 2 | 1280 三栏全开：无横向滚动，中栏自然收窄，左右栏宽度不变 | |
| 3 | 左栏折叠：中栏顶部 `PanelLeft` 按钮可再次展开 | |
| 4 | 右栏折叠：中栏占满剩余宽度，`PanelRight` 可再次展开 | |
| 5 | 双栏都折叠：中栏内容仍 760px 居中，不铺满全宽 | |
| 6 | 拖拽右栏：280 / 560 两端钳制生效，双击复位 360 | |
| 7 | 刷新页面：折叠态与右栏宽度保持 | |
| 8 | 触发工具调用：中栏点摘要可内联展开；点 `↗` 右栏展开详情 | |
| 9 | 右栏折叠时点 `↗`：右栏自动展开并显示该工具调用 | |
| 10 | 用户消息右对齐气泡，助手消息全宽无气泡，消息间无分隔线 | |
| 11 | 输入 `/` 唤起面板，三条命令均可执行；`Esc` 关闭；`/abc` 面板消失且不拦截 | |
| 12 | 左栏四个入口可达，页面套在同一 shell 内（旧页面接口报错属预期） | |
| 13 | 暗色模式下三栏配色正常，无残留亮色块 | |
| 14 | 所有可点元素 hover 无位移，仅背景/文字变色 | |

任何一项不通过，回到对应任务修复后重新验收，不要带着已知问题往下走。

- [ ] **Step 4: 更新前端计划文档**

`docs/frontend-plan.md` 的「## 2. 当前状态」一节，在「已完成：新对话链路」小节之后插入：

```markdown
### 已完成：三栏 Shell（2026-07-31）

`AppShell.vue` 三栏骨架 + `stores/layout.js`（折叠与宽度持久化）+ `stores/workspace.js`
（右栏内容）+ `apis/http.js`（JWT 注入与 401 处理）。非对话功能作为独立路由页挂进同一 shell，
入口在左栏底部。设计与验收清单见
[specs/2026-07-31-web-three-column-shell-design.md](superpowers/specs/2026-07-31-web-three-column-shell-design.md)。

本次仍是 JS，未做 TS 化；会话列表是静态骨架，等 HEU-10；`@` 引用与模型切换未做。
`/graph` 与 `/agent/:agent_id` 路由已摘除，文件保留待死代码清理时一并删除。
```

同一文件「### 近期（不依赖后端）」一节里，把「**Composer 增强（HEU-25）**」条目改为：

```markdown
- **Composer 增强（HEU-25）剩余部分**：`/` 命令面板已完成（`/new` · `/workspace` · `/sidebar`）；
  `@` 引用知识库等后端 kb 接口，模型切换等 HEU-12，附件上传等文件服务
```

- [ ] **Step 5: Commit**

```bash
git add docs/frontend-plan.md
git commit -m "docs: 记录三栏 shell 改造完成状态"
```

---

## 附：本次未做的事

以下都是有意留下的，不是遗漏：

- **TS 化**——用户明确要求本次继续用 JS
- **死代码删除**——旧对话组件约 8000 行、图谱、思维导图及 `@antv/g6` / `sigma` / `d3` / `markmap-*` 依赖
- **eslint 修复**——`.eslintrc.cjs` 是旧格式，eslint 9 不认
- **会话的增删改查**——等 HEU-10 消息落库
- **`@` 引用、模型切换、附件上传**——分别等 HEU-21、HEU-12、文件服务
- **`base.js` 与 `http.js` 的收敛**——等旧页面按 HEU-21 / HEU-28 重写
