import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/**
 * 加载 cwd 下的 .env(存在时);不覆盖已存在的环境变量。
 * 密钥仍只通过环境变量进入进程,不写入 YAML(AGENTS §4)。
 */
function loadDotEnvInto(envMap: Record<string, string | undefined>): void {
  const candidates = [".env", "../.env"];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8");
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq <= 0) continue;
        const key = t.slice(0, eq).trim();
        let value = t.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!(key in envMap) && !(key in process.env)) envMap[key] = value;
      }
      return; // 只加载第一个找到的 .env
    } catch {
      continue;
    }
  }
}
import { Provider } from "@mistake-book/shared";

export interface ModelSlotConfig {
  provider: Provider;
  protocol: "openai" | "anthropic"; // anthropic:Messages 协议(如 Kimi 端点)
  baseUrl: string;
  apiKey: string | null; // 来自 api_key_env 指定的环境变量
  model: string;
}

export interface AppConfig {
  port: number;
  dataDir: string;
  env: "development" | "production" | "test";
  /** 唯一模型槽位:错误分析/出题/判分/总结;普通文本模型即可(识题在豆包侧) */
  textModel: ModelSlotConfig;
  /** 危险区解锁口令(设置页「一键清空」需输入;来自 .env 的 APP_AUTH_TOKEN,空 = 清空功能锁定) */
  appAuthToken: string | null;
  warnings: string[];
}

export class ConfigError extends Error {}

const ALLOWED_PROVIDERS = new Set<string>(Provider.options);

/** 展开 base_url 中的 ${VAR} 占位 */
function expandEnvVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => env[name] ?? "");
}

function loadSlot(
  raw: unknown,
  slotName: string,
  env: AppConfig["env"],
  envMap: Record<string, string | undefined>,
  warnings: string[],
): ModelSlotConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError(`models.yaml 中缺少 ${slotName} 配置`);
  }
  const raw_ = raw as Record<string, unknown>;
  const provider = String(raw_.provider ?? "");
  if (!ALLOWED_PROVIDERS.has(provider)) {
    throw new ConfigError(`${slotName}.provider 非法: ${provider}(只允许 deepseek/glm/kimi/mock)`);
  }
  const protocolRaw = raw_.protocol ? String(raw_.protocol) : "openai";
  if (protocolRaw !== "openai" && protocolRaw !== "anthropic") {
    throw new ConfigError(`${slotName}.protocol 非法: ${protocolRaw}(只允许 openai/anthropic)`);
  }
  const model = String(raw_.model ?? "");
  if (!model) throw new ConfigError(`${slotName}.model 不能为空`);
  const baseUrl = expandEnvVars(String(raw_.base_url ?? ""), envMap);

  const apiKeyEnv = raw_.api_key_env ? String(raw_.api_key_env) : null;
  let apiKey: string | null = null;
  if (provider !== "mock") {
    if (!apiKeyEnv) throw new ConfigError(`${slotName}.api_key_env 不能为空`);
    apiKey = envMap[apiKeyEnv] ?? null;
    if (!apiKey) {
      if (env === "production") {
        throw new ConfigError(`生产环境缺少环境变量 ${apiKeyEnv}(${slotName})`);
      }
      warnings.push(`环境变量 ${apiKeyEnv} 未设置,${slotName} 降级为 mock provider(仅限开发)`);
      return { provider: "mock", protocol: "openai", baseUrl: "", apiKey: null, model };
    }
  }
  return { provider: provider as Provider, protocol: protocolRaw, baseUrl, apiKey, model };
}

export function loadConfig(options?: {
  env?: AppConfig["env"];
  configPath?: string;
  /** 注入的环境变量;缺省读 process.env。不做任何全局修改。 */
  envMap?: Record<string, string | undefined>;
}): AppConfig {
  const env = options?.env ?? (process.env.NODE_ENV as AppConfig["env"]) ?? "development";
  let envMap: Record<string, string | undefined> = options?.envMap ?? process.env;
  if (!options?.envMap) {
    // 运行时默认:把 .env 合入进程环境(已设置的不覆盖);测试可注入 envMap 隔离
    loadDotEnvInto(envMap);
  }
  const warnings: string[] = [];

  const configPath =
    options?.configPath ??
    fileURLToPath(new URL("../../../config/models.yaml", import.meta.url));
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new ConfigError(`无法读取模型配置 ${configPath}: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError("models.yaml 内容非法");
  }
  const root = raw as Record<string, unknown>;

  return {
    port: Number(envMap.PORT ?? 8787),
    dataDir: envMap.DATA_DIR ?? "./data",
    env,
    textModel: loadSlot(root.text_model, "text_model", env, envMap, warnings),
    appAuthToken: (envMap.APP_AUTH_TOKEN ?? "").trim() || null,
    warnings,
  };
}
