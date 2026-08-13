import { computed, ref, toValue } from "vue";

/**
 * `/` 命令的过滤与键盘导航。
 *
 * 命令的具体行为由调用方定义，本模块只认 { name, description, run } 这个形状，
 * 因此可以脱离组件单测。
 *
 * @typedef {{ name: string, description: string, keywords?: string[], run: () => void }} Command
 */

/**
 * @param {Command[]} commands
 * @param {string} query 不含前导斜杠
 * @param {{ searchAll?: boolean }} options
 */
export function filterCommands(commands, query, { searchAll = false } = {}) {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return commands;
  if (!searchAll) {
    return commands.filter((command) => command.name.toLowerCase().startsWith(keyword));
  }
  return commands.filter((command) => {
    const fields = [command.name, command.description, ...(command.keywords ?? [])];
    return fields.some((field) => field.toLowerCase().includes(keyword));
  });
}

/**
 * 解析 /skill: 显式调用命令。
 *
 * `/skill:name` 或 `/skill:name args` → { name, args }；args 去空白，空则为 undefined。
 * 不是 /skill: 开头返回 null（按普通消息处理）。
 *
 * @param {string} text 已 trim 的整段输入
 * @returns {{ name: string, args?: string } | null}
 */
export function parseSkillCommand(text) {
  const match = text.match(/^\/skill:(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1], args: match[2]?.trim() || undefined };
}

/** 只认 Ctrl/Cmd+K 本身，不吞掉浏览器的 Ctrl+Shift+K / Ctrl+Alt+K。 */
export function isCommandPaletteShortcut(event) {
  return (
    (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k"
  );
}

/**
 * @param {Command[] | (() => Command[]) | import("vue").Ref<Command[]>} commands
 *   命令列表，或返回列表的 getter/ref——skill 补全项是异步拉来的，需要响应式来源。
 * @param {{ searchAll?: boolean }} options
 */
export function useCommandPalette(commands, { searchAll = false } = {}) {
  const open = ref(false);
  const query = ref("");
  const activeIndex = ref(0);

  // toValue 兼容三种入参：纯数组（原有调用）、ref、getter。数组时等价于原行为。
  const filtered = computed(() => filterCommands(toValue(commands), query.value, { searchAll }));

  function close() {
    open.value = false;
    query.value = "";
    activeIndex.value = 0;
  }

  function openWith(nextQuery, { keepOpen = false } = {}) {
    query.value = nextQuery;
    activeIndex.value = 0;
    // 没有匹配项就直接关掉：用户在输入 /usr/bin 这类内容时，
    // 面板不该赖着不走并抢走回车键。Ctrl+K 面板有自己的搜索框，
    // 它用 keepOpen 保留空结果态，避免每次输错一个字符就整张面板消失。
    open.value = keepOpen || filtered.value.length > 0;
  }

  function moveDown() {
    if (!filtered.value.length) return;
    activeIndex.value = (activeIndex.value + 1) % filtered.value.length;
  }

  function moveUp() {
    if (!filtered.value.length) return;
    activeIndex.value = (activeIndex.value - 1 + filtered.value.length) % filtered.value.length;
  }

  function pick(index = activeIndex.value) {
    if (!open.value) return false;
    const command = filtered.value[index];
    if (!command) return false;
    command.run();
    close();
    return true;
  }

  return { open, query, filtered, activeIndex, openWith, close, moveDown, moveUp, pick };
}
