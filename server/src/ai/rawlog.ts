import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, basename } from "node:path";

/**
 * 模型原始响应落盘与缓存(data/ai-raw/,私有目录,.gitignore 内)。
 *
 * 目的(用户 2026-08-29 决策):
 * 1. 调试看文件,不在网页上反复请求模型——省 token、省时间;
 * 2. 按 文件内容哈希 + 模型 + 提示词版本 缓存识别结果(HLD §12.1),
 *    同一张图重试/重看零成本;缓存命中不写 model_runs(无调用发生)。
 *
 * 注意:这里保存的是用户私有数据(题目原文),不属于 AGENTS §4 禁止记录
 * 正文的"日志"(model_runs/控制台);删除账号数据时一并清理。
 */
export interface RawRunRecord {
  taskType: string;
  provider: string;
  model: string;
  promptVersion: string;
  createdAt: string;
  /** 缓存键组成部分 */
  key: string;
  /** 模型原始输出文本 */
  rawText: string;
  /** 解析+校验后的结构化结果;校验失败时为 null */
  parsed: unknown | null;
  /** ok | schema_fail | api_error */
  status: "ok" | "schema_fail" | "api_error";
  error?: string;
}

export class RawRunStore {
  private readonly root: string;

  constructor(filesDir: string) {
    this.root = resolve(resolve(filesDir, ".."), "ai-raw");
    mkdirSync(this.root, { recursive: true });
  }

  cacheKey(input: {
    contentSha256: string;
    model: string;
    promptVersion: string;
  }): string {
    return `${input.contentSha256}@${input.model}@${input.promptVersion}`;
  }

  private pathFor(taskType: string, key: string): string {
    // key 已由受控部分组成;basename 防御拼接
    return join(this.root, taskType, `${basename(key)}.json`);
  }

  load(taskType: string, key: string): RawRunRecord | null {
    const p = this.pathFor(taskType, key);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as RawRunRecord;
    } catch {
      return null;
    }
  }

  save(taskType: string, key: string, record: RawRunRecord): void {
    const p = this.pathFor(taskType, key);
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(record, null, 2));
  }

  /** 强制重试:删除缓存(含失败缓存),下次重新调用模型 */
  invalidate(taskType: string, key: string): void {
    try {
      rmSync(this.pathFor(taskType, key));
    } catch {
      /* 不存在则忽略 */
    }
  }

  /** 列出原始记录文件名(调试接口用,只暴露文件名) */
  list(taskType: string): string[] {
    const dir = join(this.root, taskType);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }

  read(taskType: string, file: string): RawRunRecord | null {
    if (!/^[A-Za-z0-9@._-]+\.json$/.test(file)) return null; // 防路径穿越
    const p = join(this.root, taskType, file);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as RawRunRecord;
    } catch {
      return null;
    }
  }

  hashContent(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex");
  }
}
