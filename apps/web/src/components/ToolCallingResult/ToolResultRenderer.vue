<template>
  <div class="tool-result-renderer">
    <!-- 网页搜索结果 -->
    <WebSearchResult
      v-if="isWebSearchResult"
      :data="parsedData"
    />

    <!-- 知识库检索结果 -->
    <KnowledgeBaseResult
      v-else-if="isKnowledgeBaseResult"
      :data="parsedData"
    />

    <!-- 待办事项结果 -->
    <TodoListResult
      v-else-if="isTodoListResult"
      :data="todoListData"
    />

    <!-- 计算器结果 -->
    <CalculatorResult
      v-else-if="isCalculatorResult"
      :data="parsedData"
    />

    <!-- 图片结果 -->
    <div v-else-if="isImageResult" class="image-result">
      <img :src="parsedData" />
    </div>

    <!-- 默认的原始数据展示 -->
    <div v-else class="default-result">
      <!-- <div class="default-header">
        <h4><ToolOutlined /> {{ toolName }} 执行结果</h4>
      </div> -->
      <div class="default-content">
        <pre>{{ formatData(parsedData) }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import WebSearchResult from './WebSearchResult.vue'
import KnowledgeBaseResult from './KnowledgeBaseResult.vue'
import CalculatorResult from './CalculatorResult.vue'
import TodoListResult from './TodoListResult.vue'

// v0.5 说明：
// 1. 知识图谱结果卡片已移除——该功能已从产品下线，且它 import GraphCanvas
//    会把 1.16 MB 的图谱渲染依赖重新拉进对话页的 chunk。
// 2. 原来判断知识库结果时会读 agentStore 里的工具 metadata，那要打 v0.4 的
//    Python 接口。改为纯数据结构判断，不依赖任何后端。

const props = defineProps({
  toolName: {
    type: String,
    required: true
  },
  resultContent: {
    type: [String, Object, Array, Number],
    required: true
  }
})

// 解析数据
const parsedData = computed(() => {
  if (typeof props.resultContent === 'string') {
    try {
      return JSON.parse(props.resultContent)
    } catch (error) {
      return props.resultContent
    }
  }
  return props.resultContent
})

const todoListData = computed(() => {
  if (props.toolName !== 'write_todos') return []
  
  const raw = props.resultContent
  
  // 1. Try from parsedData (JSON object)
  const data = parsedData.value
  if (data && typeof data === 'object') {
     if (Array.isArray(data)) return data
     if (data.todos && Array.isArray(data.todos)) return data.todos
  }
  
  // 2. Try parsing string if it matches specific pattern
  if (typeof raw === 'string') {
    let str = raw
    if (str.startsWith('Updated todo list to ')) {
      str = str.replace('Updated todo list to ', '')
    }
    
    // Try regex parsing for Python-like string
    const items = []
    // Matches {'content': '...', 'status': '...'} with escaped quotes support
    // content might contain escaped quotes
    const contentRegex = /'content':\s*'((?:[^'\\]|\\.)*)'/
    const statusRegex = /'status':\s*'((?:[^'\\]|\\.)*)'/
    
    // Split by "}, {" roughly, or just look for objects
    // Since it is a list of dicts, we can match individual dicts
    const dictRegex = /\{.*?\}/g
    const dictMatches = str.match(dictRegex)
    
    if (dictMatches) {
      for (const dictStr of dictMatches) {
        const contentMatch = dictStr.match(contentRegex)
        const statusMatch = dictStr.match(statusRegex)
        
        if (contentMatch && statusMatch) {
          items.push({
            content: contentMatch[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\"),
            status: statusMatch[1]
          })
        }
      }
    }
    if (items.length > 0) return items
  }
  
  return []
})

const isTodoListResult = computed(() => {
  return props.toolName === 'write_todos' && todoListData.value.length > 0
})

// 判断是否为网页搜索结果
const isWebSearchResult = computed(() => {
  const toolNameLower = props.toolName.toLowerCase()
  const isWebSearchTool = toolNameLower.includes('search') ||
                         toolNameLower.includes('tavily') ||
                         toolNameLower.includes('web')

  if (!isWebSearchTool) return false

  const data = parsedData.value
  return data &&
         typeof data === 'object' &&
         'results' in data &&
         Array.isArray(data.results) &&
         'query' in data
})

// 判断是否为知识库检索结果：只看数据长什么样，不问后端这个工具是什么
const isKnowledgeBaseResult = computed(() => {
  const data = parsedData.value
  return Array.isArray(data) &&
         data.length > 0 &&
         data.every(item =>
           item &&
           typeof item === 'object' &&
           'content' in item &&
           'score' in item &&
           'metadata' in item
         )
})

const isImageResult = computed(() => {
  // 包含 chart 且返回值是url
  const data = parsedData.value
  const toolNameLower = props.toolName.toLowerCase()
  const isImageTool = toolNameLower.includes('chart')

  if (!isImageTool) return false

  return data && typeof data === 'string' && data.startsWith('http')
})

// 判断是否为计算器结果
const isCalculatorResult = computed(() => {
  const toolNameLower = props.toolName.toLowerCase()
  const isCalculatorTool = toolNameLower.includes('calculator') ||
                          toolNameLower.includes('calc') ||
                          toolNameLower.includes('math')

  if (!isCalculatorTool) return false

  return typeof parsedData.value === 'number'
})

// 格式化数据用于默认展示
const formatData = (data) => {
  if (typeof data === 'object') {
    return JSON.stringify(data, null, 2)
  }
  return String(data)
}
</script>

<style lang="less" scoped>
.tool-result-renderer {
  width: 100%;
  height: 100%;

  .default-result {
    background: var(--gray-0);
    border-radius: 8px;

    .default-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--gray-100);
      background: var(--gray-25);

      h4 {
        margin: 0;
        color: var(--main-color);
        font-size: 14px;
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 6px;
      }
    }

    .default-content {
      background: var(--gray-0);
      padding: 12px;

      pre {
        margin: 0;
        font-size: 12px;
        line-height: 1.4;
        color: var(--gray-700);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 300px;
        overflow-y: auto;
        background: var(--gray-50);
        padding: 10px;
        border-radius: 4px;
        // border-left: 2px solid var(--main-color);
      }
    }
  }

  .image-result {
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
}
</style>