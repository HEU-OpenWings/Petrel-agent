import { del, get } from "./http";

/** 当前用户的全部记忆，按创建时间倒序。响应不含 embedding */
export const listMemories = () => get("/api/memories");

/** 删一条。不存在或不属于自己都会得到 404 */
export const deleteMemory = (id) => del(`/api/memories/${id}`);
