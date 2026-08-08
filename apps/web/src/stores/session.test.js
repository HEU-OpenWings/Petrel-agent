// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSession, listSessions, renameSession } from "@/apis/session_api";
import { useSessionStore } from "./session.js";

vi.mock("@/apis/session_api", () => ({
  listSessions: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
}));

const A = { id: "a3f1c2d4-0000-4000-8000-00000000000a", title: "会话 A" };
const B = { id: "a3f1c2d4-0000-4000-8000-00000000000b", title: "会话 B" };

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("useSessionStore", () => {
  it("startNew 生成一个新的 uuid 并切过去", () => {
    const store = useSessionStore();
    const first = store.startNew();

    expect(first).toBe(store.currentId);
    // 后端 requireUuid 只认这个格式，本地生成的 id 必须过得了这一关
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(store.startNew()).not.toBe(first);
  });

  it("startNew 不调任何接口：会话要等第一条消息才落库", () => {
    const store = useSessionStore();
    store.startNew();

    expect(listSessions).not.toHaveBeenCalled();
    expect(renameSession).not.toHaveBeenCalled();
  });

  it("select 切换当前会话", () => {
    const store = useSessionStore();
    store.select(A.id);

    expect(store.currentId).toBe(A.id);
  });

  it("refresh 写入列表并复位 loading", async () => {
    listSessions.mockResolvedValue([A, B]);
    const store = useSessionStore();

    await store.refresh();

    expect(store.list).toEqual([A, B]);
    expect(store.loading).toBe(false);
  });

  it("refresh 失败时保留上一次的列表，不清空左栏", async () => {
    listSessions.mockResolvedValueOnce([A, B]).mockRejectedValueOnce(new Error("网络错误"));
    const store = useSessionStore();

    await store.refresh();
    await store.refresh();

    expect(store.list).toEqual([A, B]);
    expect(store.loading).toBe(false);
  });

  it("rename 调接口并就地改标题", async () => {
    listSessions.mockResolvedValue([{ ...A }, { ...B }]);
    renameSession.mockResolvedValue({ ok: true });
    const store = useSessionStore();
    await store.refresh();

    await store.rename(A.id, "新标题");

    expect(renameSession).toHaveBeenCalledWith(A.id, "新标题");
    expect(store.list[0].title).toBe("新标题");
    expect(store.list[1].title).toBe("会话 B");
  });

  it("rename 一个不在列表里的会话不会报错", async () => {
    renameSession.mockResolvedValue({ ok: true });
    const store = useSessionStore();

    await expect(store.rename(A.id, "新标题")).resolves.toBeUndefined();
  });

  it("remove 调接口并把该项移出列表", async () => {
    listSessions.mockResolvedValue([{ ...A }, { ...B }]);
    deleteSession.mockResolvedValue({ ok: true });
    const store = useSessionStore();
    await store.refresh();
    store.select(B.id);

    await store.remove(A.id);

    expect(deleteSession).toHaveBeenCalledWith(A.id);
    expect(store.list.map((item) => item.id)).toEqual([B.id]);
    // 删的不是当前会话，选中态不该被动
    expect(store.currentId).toBe(B.id);
  });

  it("remove 删掉的是当前会话时把 currentId 置空", async () => {
    listSessions.mockResolvedValue([{ ...A }, { ...B }]);
    deleteSession.mockResolvedValue({ ok: true });
    const store = useSessionStore();
    await store.refresh();
    store.select(A.id);

    await store.remove(A.id);

    expect(store.currentId).toBe(null);
  });

  it("remove 接口失败时列表原样保留", async () => {
    listSessions.mockResolvedValue([{ ...A }, { ...B }]);
    deleteSession.mockRejectedValue(new Error("会话不存在"));
    const store = useSessionStore();
    await store.refresh();
    store.select(A.id);

    await expect(store.remove(A.id)).rejects.toThrow("会话不存在");
    expect(store.list).toHaveLength(2);
    expect(store.currentId).toBe(A.id);
  });
});
