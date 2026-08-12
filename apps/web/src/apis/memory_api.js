import { del, get } from "./http";

/**
 * 当前用户的全部记忆，按创建时间倒序。响应不含 embedding。
 * 一并返回 configured：未配置 embedding 时列表必然为空，面板要能跟「还没记下东西」区分开。
 */
export const listMemories = () => get("/api/memories");

/** 删一条。不存在或不属于自己都会得到 404 */
export const deleteMemory = (id) => del(`/api/memories/${id}`);
