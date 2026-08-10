import { computed, ref } from "vue";

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

/** 只认 Ctrl/Cmd+K 本身，不吞掉浏览器的 Ctrl+Shift+K / Ctrl+Alt+K。 */
export function isCommandPaletteShortcut(event) {
  return (
    (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k"
  );
}

/** @param {Command[]} commands @param {{ searchAll?: boolean }} options */
export function useCommandPalette(commands, { searchAll = false } = {}) {
  const open = ref(false);
  const query = ref("");
  const activeIndex = ref(0);

  const filtered = computed(() => filterCommands(commands, query.value, { searchAll }));

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
