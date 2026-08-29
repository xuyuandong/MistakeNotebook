import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripFrontmatter, FrontmatterFormatError } from "@mistake-book/shared";

/**
 * llm_prompts/ markdown 提示词文件加载器(LLD §7.5)。
 * system 提示词文本维护在仓库根 llm_prompts/<id>.md(唯一真源),frontmatter 携带
 * id 与版本号;本模块只在启动时读取一次,任何缺失/格式错误直接抛错(fail-fast)。
 */

export class PromptLoadError extends Error {}

/** 仓库根 llm_prompts/ 目录;src 与 dist 布局下相对层级一致 */
export const DEFAULT_PROMPTS_DIR = fileURLToPath(
  new URL("../../../llm_prompts", import.meta.url),
);

export type PromptPlaceholderMap = Record<string, string>;

export interface LoadedPrompt {
  id: string;
  version: string;
  system: string;
}

/** 把 {{TOKEN}} 占位符替换为代码侧注入的枚举文本;替换后仍残留 {{...}} 视为文件错误 */
function substitutePlaceholders(
  text: string,
  filePath: string,
  placeholders: PromptPlaceholderMap,
): string {
  let out = text;
  for (const [token, value] of Object.entries(placeholders)) {
    out = out.split(`{{${token}}}`).join(value);
  }
  const leftover = out.match(/\{\{[A-Za-z0-9_]+\}\}/g);
  if (leftover?.length) {
    throw new PromptLoadError(`${filePath} 存在未识别的占位符: ${leftover.join(", ")}`);
  }
  return out;
}

export function loadPromptFile(
  filePath: string,
  expectedId: string,
  placeholders: PromptPlaceholderMap,
): LoadedPrompt {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    throw new PromptLoadError(`无法读取提示词文件 ${filePath}: ${(e as Error).message}`);
  }
  let meta: Record<string, string> | null;
  let body: string;
  try {
    ({ meta, body } = stripFrontmatter(raw));
  } catch (e) {
    throw new PromptLoadError(`${filePath} 格式非法: ${(e as Error).message}`);
  }
  if (!meta) {
    throw new PromptLoadError(`${filePath} 缺少 frontmatter(id/version)`);
  }
  if (meta.id !== expectedId) {
    throw new PromptLoadError(`${filePath} 的 frontmatter id 应为 ${expectedId},实际是 ${meta.id ?? "(缺失)"}`);
  }
  if (!meta.version) {
    throw new PromptLoadError(`${filePath} 的 frontmatter 缺少 version(修改语义时必须递增)`);
  }
  return { id: expectedId, version: meta.version, system: substitutePlaceholders(body, filePath, placeholders) };
}

/** 按给定 id 集合加载 <dir>/<id>.md;多出的文件(如 doubao_extract.md)不加载 */
export function loadPromptTexts(
  dir: string,
  ids: readonly string[],
  placeholders: PromptPlaceholderMap,
): Record<string, LoadedPrompt> {
  const out: Record<string, LoadedPrompt> = {};
  for (const id of ids) {
    out[id] = loadPromptFile(join(dir, `${id}.md`), id, placeholders);
  }
  return out;
}
