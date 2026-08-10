/**
 * API模块索引文件
 * 导出所有API模块，方便统一引入
 */

export * from "./agent_api"; // 智能体API
// 导出基础工具函数
export {
  apiAdminDelete,
  apiAdminGet,
  apiAdminPost,
  apiAdminPut,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  apiSuperAdminDelete,
  apiSuperAdminGet,
  apiSuperAdminPost,
  apiSuperAdminPut,
} from "./base";
export * from "./knowledge_api"; // 知识库管理API
// 导出API模块
export * from "./system_api"; // 系统管理API
export * from "./tasker"; // 任务管理API

/**
 * API模块说明:
 *
 * 1. system_api.js: 系统管理API
 *    - 健康检查、配置管理、信息管理、OCR服务
 *    - 权限要求: 部分公开，部分需要管理员权限
 *
 * 2. knowledge_api.js: 知识库管理API
 *    - 数据库管理、文档管理、查询接口、文件管理
 *    - 权限要求: 管理员权限
 *
 *
 * 4. tools.js: 工具API
 *    - 工具信息获取
 *
 * 6. agent.js: 智能体API
 *    - 智能体管理、聊天、配置等功能
 *
 * 注意：API模块已处理权限验证和请求头，使用时无需再手动添加认证头
 */
