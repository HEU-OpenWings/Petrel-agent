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
