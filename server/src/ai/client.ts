import { randomUUID } from "node:crypto";
import type { ModelSlotConfig } from "../config/index.js";
import type { Provider, TaskType } from "@mistake-book/shared";

export type ModelSlot = "text";

export interface ChatRequest {
  taskType: TaskType;
  system: string;
  /** user/assistant 消息序列;图片以 data URL 放入 content */
  messages: { role: "user" | "assistant"; content: string }[];
  /** 期望模型返回 JSON 时提供 */
  jsonMode?: boolean;
  jobId?: string;
}

export interface ModelRunMeta {
  id: string;
  taskType: TaskType;
  provider: Provider;
  model: string;
  promptVersion: string;
  status: "ok" | "schema_fail" | "api_error" | "timeout";
  durationMs: number;
  usageJson: string | null;
}

export interface ChatResult {
  text: string;
  run: ModelRunMeta;
}

export interface ProviderClient {
  chat(slot: ModelSlotConfig, req: ChatRequest): Promise<ChatResult>;
}

// 推理模型(k3/deepseek-v4)带思考链,耗时显著更长
const TIMEOUT_MS = 300_000;
const ANTHROPIC_MAX_TOKENS = 16384;

/**
 * OpenAI-compatible Chat Completions 客户端(deepseek/glm/kimi 共用协议)。
 * promptVersion 由调用方传入 prompts/ 中的常量;这里不持久化,持久化在调用方写 model_runs。
 */
export interface ChatClient {
  chat(slot: ModelSlot, req: ChatRequest): Promise<ChatResult>;
}

export function createHttpProvider(): ProviderClient {
  return {
    async chat(slot, req) {
      const started = Date.now();
      const runId = randomUUID();
      const finish = (status: ModelRunMeta["status"], text: string, usage: unknown = null) => ({
        text,
        run: {
          id: runId,
          taskType: req.taskType,
          provider: slot.provider,
          model: slot.model,
          promptVersion: "v0",
          status,
          durationMs: Date.now() - started,
          usageJson: usage ? JSON.stringify(usage) : null,
        } satisfies ModelRunMeta,
      });

      if (!slot.baseUrl || !slot.apiKey) {
        return finish("api_error", "", { error: "缺少 base_url 或 api key" });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${slot.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${slot.apiKey}`,
          },
          body: JSON.stringify({
            model: slot.model,
            messages: [{ role: "system", content: req.system }, ...req.messages],
            ...(req.jsonMode ? { response_format: { type: "json_object" } } : {}),
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          return finish("api_error", "", { httpStatus: res.status });
        }
        const body = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: unknown;
        };
        const text = body.choices?.[0]?.message?.content ?? "";
        return finish(text ? "ok" : "api_error", text, body.usage ?? null);
      } catch (e) {
        const isTimeout = (e as Error).name === "AbortError";
        return finish(isTimeout ? "timeout" : "api_error", "", { error: (e as Error).message });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Anthropic Messages 协议客户端(如 Kimi Coding 端点 https://api.kimi.com/coding)。
 * data URL 形式的图片内容转为 base64 image 块;无 response_format,JSON 靠提示词约束。
 */
export function createAnthropicProvider(): ProviderClient {
  return {
    async chat(slot, req) {
      const started = Date.now();
      const runId = randomUUID();
      const finish = (status: ModelRunMeta["status"], text: string, usage: unknown = null) => ({
        text,
        run: {
          id: runId,
          taskType: req.taskType,
          provider: slot.provider,
          model: slot.model,
          promptVersion: "v0",
          status,
          durationMs: Date.now() - started,
          usageJson: usage ? JSON.stringify(usage) : null,
        } satisfies ModelRunMeta,
      });

      if (!slot.baseUrl || !slot.apiKey) {
        return finish("api_error", "", { error: "缺少 base_url 或 api key" });
      }

      const messages = req.messages.map((m) => ({
        role: m.role,
        content: Array.from(splitDataUrls(m.content)),
      }));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${slot.baseUrl.replace(/\/$/, "")}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": slot.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: slot.model,
            max_tokens: ANTHROPIC_MAX_TOKENS,
            system: req.system,
            messages,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          return finish("api_error", "", { httpStatus: res.status });
        }
        const body = (await res.json()) as {
          content?: { type: string; text?: string }[];
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        // 只拼接 text 块,跳过 thinking 块
        const text = (body.content ?? [])
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("");
        const usage = body.usage
          ? { promptTokens: body.usage.input_tokens, completionTokens: body.usage.output_tokens }
          : null;
        return finish(text ? "ok" : "api_error", text, usage);
      } catch (e) {
        const isTimeout = (e as Error).name === "AbortError";
        return finish(isTimeout ? "timeout" : "api_error", "", { error: (e as Error).message });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 把 "text … data:<mime>;base64,<data>" 形式的字符串拆成 Anthropic 内容块 */
function* splitDataUrls(content: string): Generator<
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
> {
  const re = /data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const before = content.slice(last, m.index).trim();
    if (before) yield { type: "text", text: before };
    const mime = m[1] === "image/jpg" ? "image/jpeg" : m[1];
    yield { type: "image", source: { type: "base64", media_type: mime, data: m[2] } };
    last = re.lastIndex;
  }
  const rest = content.slice(last).trim();
  if (rest) yield { type: "text", text: rest };
  if (last === 0 && !rest) yield { type: "text", text: content };
}

/**
 * mock provider:按 taskType 返回最小合法 JSON,供开发与测试。
 * 真实任务实现(阶段 1/2)会为每个 taskType 提供更完整的 fixture。
 */
export function createMockProvider(): ProviderClient {
  const fixtures: Record<TaskType, string> = {
    analyze_mistake: JSON.stringify({
      results: [
        {
          index: 0,
          primaryErrorType: "unconfirmed",
          secondaryErrorTypes: [],
          concepts: [{ name: "示例概念", category: null, isPrimary: true, confidence: 0.3 }],
          improvementSuggestions: [],
          methodAdvice: [],
          cognitiveAdvice: [],
          habitIssues: [],
          profileInferred: false,
          needsFollowUp: false,
          confidence: 0.2,
        },
      ],
    }),
    generate_questions: JSON.stringify({
      questions: [
        {
          type: "fill_blank",
          stemMd: "(mock)示例生成题",
          answer: "42",
          explanationMd: "(mock)解析",
          concepts: ["示例概念"],
          difficulty: 3,
          acceptableAnswers: [],
        },
      ],
    }),
    verify_question: JSON.stringify({ answerCorrect: true, issues: [], confidence: 0.5 }),
    judge_answer: JSON.stringify({
      verdict: "correct",
      basis: "(mock)与标准答案一致",
      comment: "(mock)继续保持",
    }),
    select_topics: JSON.stringify({
      targetConcepts: ["示例概念"],
      rationale: "(mock)掌握分最低",
    }),
    summarize_learner: JSON.stringify({ summaryMd: "(mock)总结", recurringPatterns: [] }),
    consolidate_concepts: JSON.stringify({ assignments: [], merges: [] }),
  };

  return {
    async chat(slot, req) {
      const started = Date.now();
      return {
        text: fixtures[req.taskType] ?? "{}",
        run: {
          id: randomUUID(),
          taskType: req.taskType,
          provider: slot.provider,
          model: slot.model,
          promptVersion: "v0",
          status: "ok",
          durationMs: Date.now() - started,
          usageJson: null,
        },
      };
    },
  };
}

/**
 * 统一入口:按槽位取配置,按 provider 分发(mock 或 OpenAI-compatible HTTP)。
 * 真实供应商只需修改 config/models.yaml,代码不变(LLD §7)。
 */
export function createChatClient(config: { textModel: ModelSlotConfig }): ChatClient {
  const openai = createHttpProvider();
  const anthropic = createAnthropicProvider();
  const mock = createMockProvider();
  const pick = (_slot: ModelSlot): { slot: ModelSlotConfig; client: ProviderClient } => {
    const slotConfig = config.textModel;
    const client =
      slotConfig.provider === "mock"
        ? mock
        : slotConfig.protocol === "anthropic"
          ? anthropic
          : openai;
    return { slot: slotConfig, client };
  };
  return {
    async chat(slot, req) {
      const { slot: slotConfig, client } = pick(slot);
      return client.chat(slotConfig, req);
    },
  };
}
