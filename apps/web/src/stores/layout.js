import { defineStore } from "pinia";
import { ref } from "vue";

export const STORAGE_KEY = "petrel.layout";
const SCHEMA_VERSION = 1;

export const MIN_RIGHT_WIDTH = 280;
export const MAX_RIGHT_WIDTH = 560;
export const DEFAULT_RIGHT_WIDTH = 360;
/** 首次加载时视口窄于此值，右栏默认折叠 */
export const NARROW_VIEWPORT = 1024;

export function clampWidth(width) {
  if (!Number.isFinite(width)) return DEFAULT_RIGHT_WIDTH;
  return Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, Math.round(width)));
}

/** 读取失败一律返回 null，由调用方回落默认值：布局偏好丢了不值得打断应用启动 */
function readPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.v !== SCHEMA_VERSION) return null;
    return {
      leftCollapsed: parsed.leftCollapsed === true,
      rightCollapsed: parsed.rightCollapsed === true,
      rightWidth: clampWidth(parsed.rightWidth),
    };
  } catch {
    return null;
  }
}

export const useLayoutStore = defineStore("layout", () => {
  const persisted = readPersisted();

  const leftCollapsed = ref(persisted?.leftCollapsed ?? false);
  // 只在首次加载（无持久化偏好）时看视口。之后完全听用户的，
  // 否则窄屏下用户点展开会被响应式规则立刻覆盖，表现为「点了没反应」。
  const rightCollapsed = ref(persisted?.rightCollapsed ?? window.innerWidth < NARROW_VIEWPORT);
  const rightWidth = ref(persisted?.rightWidth ?? DEFAULT_RIGHT_WIDTH);

  function persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          v: SCHEMA_VERSION,
          leftCollapsed: leftCollapsed.value,
          rightCollapsed: rightCollapsed.value,
          rightWidth: rightWidth.value,
        }),
      );
    } catch {
      // 隐私模式下 localStorage 不可写，静默降级为「本次会话内有效」
    }
  }

  function toggleLeft() {
    leftCollapsed.value = !leftCollapsed.value;
    persist();
  }

  function toggleRight() {
    rightCollapsed.value = !rightCollapsed.value;
    persist();
  }

  function expandRight() {
    if (!rightCollapsed.value) return;
    rightCollapsed.value = false;
    persist();
  }

  function setRightWidth(width) {
    rightWidth.value = clampWidth(width);
    persist();
  }

  function resetRightWidth() {
    rightWidth.value = DEFAULT_RIGHT_WIDTH;
    persist();
  }

  return {
    leftCollapsed,
    rightCollapsed,
    rightWidth,
    toggleLeft,
    toggleRight,
    expandRight,
    setRightWidth,
    resetRightWidth,
  };
});
