/**
 * 模型输出 → JSON 的宽松解析:
 * - 剥掉 ```json ... ``` 围栏与首尾空白;
 * - 直接 parse 失败时,截取首个 { 或 [ 到最后一个 } 或 ] 再试。
 * 仅用于把"明显是 JSON 的文本"救回来,Schema 校验仍由调用方的 Zod 负责。
 */
export function parseModelJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();

  try {
    return JSON.parse(t);
  } catch {
    // 截取最外层 JSON 体再试
    const start = t.search(/[{[]/);
    const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      return JSON.parse(t.slice(start, end + 1));
    }
    throw new Error("模型输出不是合法 JSON");
  }
}

/** analyze_mistake 批量输出归一化:裸数组 → {results:[...]} */
export function normalizeAnalyzeBatch(raw: unknown): unknown {
  if (Array.isArray(raw)) return { results: raw };
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    for (const key of ["results", "analyses", "items", "data"]) {
      if (Array.isArray(obj[key])) return { ...obj, results: obj[key] };
    }
  }
  return raw;
}

/**
 * generate_questions 输出归一化:裸数组 → {questions:[...]}。
 * 另:DeepSeek 等模型对缺失字段惯性输出显式 null(如 "options": null),
 * 而 Zod 的 .optional() 拒绝 null —— 逐题剥离 null 字段,让可选字段真正可缺;
 * 必填字段若为 null 仍会由 Schema 拒绝并给出明确错误。
 */
export function normalizeGenerateQuestions(raw: unknown): unknown {
  const stripNulls = (q: unknown): unknown => {
    if (typeof q !== "object" || q === null) return q;
    return Object.fromEntries(
      Object.entries(q as Record<string, unknown>).filter(([, v]) => v !== null),
    );
  };
  if (Array.isArray(raw)) return { questions: raw.map(stripNulls) };
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    for (const key of ["questions", "items", "data"]) {
      if (Array.isArray(obj[key])) return { ...obj, questions: (obj[key] as unknown[]).map(stripNulls) };
    }
    // 单题对象 → 单元素数组
    if ("stemMd" in obj) return { questions: [stripNulls(raw)] };
  }
  return raw;
}

/** JSON 合法转义字符;此外的反斜杠序列都是非法转义(典型:豆包把 LaTeX 的 \( \) 原样塞进字符串) */
const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/**
 * 修复 JSON 文本中的非法反斜杠转义,只动语法、不动内容:
 * - 已双写的 \\ 与合法转义(\n 等)原样保留;
 * - 非法转义(如 \(、\[、\dfrac 被单反斜杠输出)补成双反斜杠,
 *   解析后字符串内容即为原本想要的 \( 等 LaTeX 字符。
 * 典型场景:豆包输出 JSON 时把 LaTeX 定界符 \(...\) 带了进来,JSON.parse 直接失败。
 */
export function repairJsonEscapes(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "\\" || VALID_JSON_ESCAPES.has(next)) {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      out += "\\\\" + next;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
