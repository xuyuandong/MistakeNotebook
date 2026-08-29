/**
 * 提示词 markdown 文件的 frontmatter 解析(llm_prompts/ 目录,LLD §7.5)。
 * 格式:首行 `---`,到下一个独立 `---` 行之间为 `key: value` 元数据,其后为正文。
 * 服务端加载 system 提示词与前端内嵌豆包识题模板共用本解析,保证同一文件格式。
 */

export interface FrontmatterResult {
  /** key → value(不含首尾空白);无 frontmatter 时为 null */
  meta: Record<string, string> | null;
  /** frontmatter 之后的正文(去掉起始空行与结尾空白) */
  body: string;
}

export class FrontmatterFormatError extends Error {}

export function stripFrontmatter(raw: string): FrontmatterResult {
  if (!raw.startsWith("---")) {
    return { meta: null, body: raw.trim() };
  }
  const lines = raw.split("\n");
  const closing = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (closing < 0) {
    throw new FrontmatterFormatError("frontmatter 缺少结束的 --- 行");
  }
  const meta: Record<string, string> = {};
  for (const line of lines.slice(1, closing)) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf(":");
    if (eq <= 0) {
      throw new FrontmatterFormatError(`frontmatter 行非法(应为 key: value): ${t}`);
    }
    meta[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  const body = lines
    .slice(closing + 1)
    .join("\n")
    .replace(/^\n+/, "")
    .trimEnd();
  return { meta, body };
}
