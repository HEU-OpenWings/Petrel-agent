/**
 * HEU-9 验收脚本：对每个「已配置」的 provider 跑一次真实模型调用，打印 token / 成本统计。
 *
 * 用法（仓库根）：
 *   pnpm tsx packages/ai/scripts/verify-providers.ts
 *
 * 默认只跑「已配置」的 provider（getAuth 能解析出凭据的）。想验证某家厂商，
 * 就在环境变量里填它的 API key（见 .env.template）。
 *
 * 组织者 HEU-9 的验收要求是「脚本对 DeepSeek 与本地 vLLM 各跑一次 streamSimple
 * 成功，并读到 token / 成本统计」。本地用 Ollama（同为 OpenAI 兼容端点）替代
 * vLLM——RTX 4060 8GB 上 vLLM 镜像过重，Ollama 验证的是同一套 openai-completions
 * 适配器。要跑 Ollama：先 `OLLAMA_API_KEY=ollama`（任意非空占位，见 .env.template 注释）。
 *
 * 凭据仍由 pi-ai 的 auth 机制从环境变量解析（DEEPSEEK_API_KEY / OPENAI_API_KEY / …），
 * 这是「@petrel/config 是唯一读 env 的位置」的既有例外，与运行时一致。
 */
import { models } from "../src/index.ts";

interface ProviderResult {
  provider: string;
  model: string;
  ok: boolean;
  /** 文本回复片段，截断到 80 字符，仅作「确实收到回答」的佐证 */
  reply?: string;
  usage?: {
    input: number;
    output: number;
    totalTokens: number;
    costTotal: number;
  };
  error?: string;
}

async function probeProvider(providerId: string, modelId: string): Promise<ProviderResult> {
  const model = models.getModel(providerId, modelId);
  if (!model) {
    return { provider: providerId, model: modelId, ok: false, error: "模型未在注册表中找到" };
  }
  try {
    const message = await models.completeSimple(model, {
      systemPrompt: "你是一个测试助手，用一句话回答。",
      messages: [{ role: "user", content: "用一句话介绍你自己。", timestamp: 0 }],
    });
    if (message.stopReason === "error") {
      return {
        provider: providerId,
        model: modelId,
        ok: false,
        error: `模型返回错误：${message.errorMessage ?? "(无错误信息)"}`,
      };
    }
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
    return {
      provider: providerId,
      model: modelId,
      ok: true,
      reply: text.slice(0, 80),
      usage: {
        input: message.usage.input,
        output: message.usage.output,
        totalTokens: message.usage.totalTokens,
        costTotal: message.usage.cost.total,
      },
    };
  } catch (err) {
    return {
      provider: providerId,
      model: modelId,
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

async function main() {
  // 只跑已配置的 provider：getAuth 能解析出凭据的才纳入
  const configured: { provider: string; model: string }[] = [];
  for (const provider of models.getProviders()) {
    const auth = await models.getAuth(provider.id);
    if (!auth) continue;
    const first = provider.getModels()[0];
    if (first) configured.push({ provider: provider.id, model: first.id });
  }

  if (configured.length === 0) {
    console.error("没有任何已配置的 provider。请在环境变量里至少填一个 API key（如 DEEPSEEK_API_KEY）。");
    process.exit(1);
  }

  console.log(
    `将验证 ${configured.length} 个已配置的 provider：${configured.map((c) => c.provider).join(", ")}\n`,
  );

  const results: ProviderResult[] = [];
  for (const { provider, model } of configured) {
    process.stdout.write(`▶ ${provider} / ${model} … `);
    const result = await probeProvider(provider, model);
    results.push(result);
    console.log(result.ok ? "OK" : `FAIL`);
  }

  console.log("\n=== 结果 ===");
  for (const r of results) {
    const status = r.ok ? "✅" : "❌";
    console.log(`${status} ${r.provider}/${r.model}`);
    if (r.reply) console.log(`   回复：${r.reply}`);
    if (r.usage) {
      console.log(
        `   用量：input=${r.usage.input} output=${r.usage.output} total=${r.usage.totalTokens} cost=$${r.usage.costTotal.toFixed(6)}`,
      );
    }
    if (r.error) console.log(`   错误：${r.error}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} 个 provider 失败。`);
    process.exit(1);
  }
  console.log(`\n全部 ${results.length} 个已配置 provider 验证通过。`);
}

main().catch((err) => {
  console.error("脚本异常退出：", err);
  process.exit(1);
});
