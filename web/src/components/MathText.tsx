import katex from "katex";
import type { CSSProperties } from "react";
import { useMemo } from "react";

type Segment =
  | { kind: "text"; value: string }
  | { kind: "math"; tex: string; display: boolean };

/** 依次识别 $$…$$、\[…\](独立公式)与 $…$、\(…\)(行内公式,兼容旧数据);无闭合定界符时按普通文本处理 */
export function splitMathText(text: string): Segment[] {
  const segments: Segment[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) segments.push({ kind: "text", value: buf });
    buf = "";
  };
  while (i < text.length) {
    if (text.startsWith("$$", i)) {
      const end = text.indexOf("$$", i + 2);
      if (end > -1) {
        flush();
        segments.push({ kind: "math", tex: text.slice(i + 2, end).trim(), display: true });
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "$") {
      const end = text.indexOf("$", i + 1);
      if (end > i + 1) {
        flush();
        segments.push({ kind: "math", tex: text.slice(i + 1, end).trim(), display: false });
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith("\\(", i)) {
      const end = text.indexOf("\\)", i + 2);
      if (end > -1) {
        flush();
        segments.push({ kind: "math", tex: text.slice(i + 2, end).trim(), display: false });
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith("\\[", i)) {
      const end = text.indexOf("\\]", i + 2);
      if (end > -1) {
        flush();
        segments.push({ kind: "math", tex: text.slice(i + 2, end).trim(), display: true });
        i = end + 2;
        continue;
      }
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return segments;
}

function renderTex(tex: string, displayMode: boolean): string {
  try {
    // throwOnError:false → 非法 LaTeX 输出红色原文本而不是抛错;strict 关闭控制台噪音
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      output: "html",
      strict: false,
    });
  } catch {
    return "";
  }
}

export interface MathTextProps {
  text: string;
  /** 行内模式渲染 <span>(选项、句子内嵌公式);默认渲染 <div> */
  inline?: boolean;
  style?: CSSProperties;
}

/**
 * 题目文本渲染(LLD §5):$…$/$$…$$ 与旧数据 \(…\)/\[…\] 用 KaTeX 输出,
 * 其余文本按原样保留换行;公式解析失败回退为原文本,不阻塞页面。
 */
export function MathText({ text, inline = false, style }: MathTextProps) {
  const segments = useMemo(() => splitMathText(text ?? ""), [text]);
  if (!text) return null;
  const nodes = segments.map((seg, idx) => {
    if (seg.kind === "text") {
      return (
        <span key={idx} style={{ whiteSpace: "pre-wrap" }}>
          {seg.value}
        </span>
      );
    }
    const html = renderTex(seg.tex, seg.display);
    if (!html) {
      return (
        <span key={idx} style={{ whiteSpace: "pre-wrap" }}>
          {seg.display ? `$$${seg.tex}$$` : `$${seg.tex}$`}
        </span>
      );
    }
    return <span key={idx} dangerouslySetInnerHTML={{ __html: html }} />;
  });
  if (inline) {
    return <span style={style}>{nodes}</span>;
  }
  return <div style={style}>{nodes}</div>;
}
