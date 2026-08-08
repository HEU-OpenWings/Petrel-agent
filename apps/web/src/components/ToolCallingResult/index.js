// 工具调用结果组件导出
//
// KnowledgeGraphResult 不在此导出：知识图谱功能已从产品下线，且它依赖
// GraphCanvas（1.16 MB 的图谱渲染），从这里导出会把它一并打进对话页的 chunk。

export { default as CalculatorResult } from "./CalculatorResult.vue";
export { default as KnowledgeBaseResult } from "./KnowledgeBaseResult.vue";
export { default as TodoListResult } from "./TodoListResult.vue";
export { default as ToolResultRenderer } from "./ToolResultRenderer.vue";
export { default as WebSearchResult } from "./WebSearchResult.vue";
