/**
 * agent-server 的对话接口。
 *
 * POST /api/chat 返回 SSE，事件体是 pi 的 AgentEvent 原样透传。
 * 因为需要 POST + 自定义请求头，这里用 fetch 读流，而不是 EventSource。
 */
import { handleUnauthorized } from "@/apis/http";

const ABORT_TIMEOUT_MS = 10_000;

/** 把 SSE 帧文本解析为 { event, data }，data 解析失败时为 null。 */
function parseFrame(frame) {
  let event = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: null, raw };
  }
}

/**
 * 发起一次对话并逐帧回调。
 *
 * model 与 systemPrompt 来自 stores/preferences，缺省时后端回落到系统默认值。
 * JSON.stringify 会丢掉值为 undefined 的键，所以不传等于没这个字段。
 *
 * skill 存在时是 /skill: 显式调用：后端走 harness.skill(name, args)，message 只作展示。
 *
 * @param {{ message: string, sessionId: string, systemPrompt?: string, model?: string, skill?: { name: string, args?: string }, signal?: AbortSignal }} params
 * @param {(frame: { event: string, data: any }) => void} onFrame
 */
export async function streamChat({ message, sessionId, systemPrompt, model, skill, signal }, onFrame) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sessionId, systemPrompt, model, skill }),
    signal,
  });

  if (!response.ok) {
    // 401 走 http.js 的同一份处理，否则登录失效时对话界面只会显示一条错误文案，
    // 不会跳登录页。放在解析错误体之前：那份文案这一支根本用不上
    if (response.status === 401) {
      throw handleUnauthorized();
    }

    let detail = "";
    try {
      const body = await response.json();
      detail = body?.error?.message ?? "";
    } catch {
      detail = await response.text().catch(() => "");
    }

    throw new Error(detail || `请求失败（HTTP ${response.status}）`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseFrame(frame);
      if (parsed) onFrame(parsed);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

/**
 * 停止正在进行的一轮对话。
 *
 * 后端的 harness 是常驻的，关闭 SSE 连接只会断开推送、不会停止生成
 * （这是有意的：关页面不再丢回答），所以停止必须走一个显式接口。
 */
export async function abortChat(sessionId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ABORT_TIMEOUT_MS);
  let response;
  try {
    response = await fetch("/api/chat/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("停止请求超时，请重试");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw handleUnauthorized();
    }
    throw new Error(`停止失败（HTTP ${response.status}）`);
  }
}

/** 读出后端的错误文案；没有就用兜底文案。403 / 409 都带着用户该看的说明 */
async function readError(response, fallback) {
  if (response.status === 401) {
    throw handleUnauthorized();
  }
  const body = await response.json().catch(() => null);
  return new Error(body?.error?.message || `${fallback}（HTTP ${response.status}）`);
}

/**
 * 手动压缩上下文（`/compact` 命令）。
 *
 * 不是 SSE：压缩只有一个结果。返回投影后的 CompactionOutcome，
 * 形状与 SSE compaction 帧里的 outcome 完全一致。
 */
export async function compactChat(sessionId) {
  const response = await fetch("/api/chat/compact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!response.ok) throw await readError(response, "压缩失败");
  const body = await response.json();
  return body.outcome;
}

/** 当前上下文占用（`/context` 命令）→ { tokens, threshold, contextWindow } */
export async function fetchContextUsage(sessionId) {
  const response = await fetch(`/api/chat/context?sessionId=${encodeURIComponent(sessionId)}`);
  if (!response.ok) throw await readError(response, "读取上下文占用失败");
  return response.json();
}

/** 可用 skill 列表（/skill: 命令的补全）→ [{ name, description }] */
export async function fetchSkills() {
  const response = await fetch("/api/chat/skills");
  if (!response.ok) throw await readError(response, "读取 skill 列表失败");
  const body = await response.json();
  return Array.isArray(body.skills) ? body.skills : [];
}
