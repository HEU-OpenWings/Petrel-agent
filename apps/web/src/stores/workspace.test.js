// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "./workspace.js";

const SNAPSHOT = { id: "call_1", name: "get_current_time", state: "running", args: {}, result: null };

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("useWorkspaceStore", () => {
  it("初始没有选中的工具调用", () => {
    const workspace = useWorkspaceStore();
    expect(workspace.activeToolCall).toBe(null);
    expect(workspace.activeToolCallId).toBe(null);
  });

  it("openToolCall 记录快照并暴露 id", () => {
    const workspace = useWorkspaceStore();
    workspace.openToolCall(SNAPSHOT);
    expect(workspace.activeToolCallId).toBe("call_1");
    expect(workspace.activeToolCall.state).toBe("running");
  });

  it("syncToolCall 只更新同一个 id 的快照", () => {
    const workspace = useWorkspaceStore();
    workspace.openToolCall(SNAPSHOT);
    workspace.syncToolCall({ ...SNAPSHOT, state: "done", ms: 12 });
    expect(workspace.activeToolCall.state).toBe("done");
    expect(workspace.activeToolCall.ms).toBe(12);
  });

  it("syncToolCall 忽略不是当前选中项的更新", () => {
    const workspace = useWorkspaceStore();
    workspace.openToolCall(SNAPSHOT);
    workspace.syncToolCall({ id: "call_2", name: "other", state: "done" });
    expect(workspace.activeToolCall.name).toBe("get_current_time");
  });

  it("未选中任何项时 syncToolCall 不写入", () => {
    const workspace = useWorkspaceStore();
    workspace.syncToolCall(SNAPSHOT);
    expect(workspace.activeToolCall).toBe(null);
  });

  it("clear 清空选中项", () => {
    const workspace = useWorkspaceStore();
    workspace.openToolCall(SNAPSHOT);
    workspace.clear();
    expect(workspace.activeToolCall).toBe(null);
  });
});
