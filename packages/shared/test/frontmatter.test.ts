import { describe, expect, test } from "vitest";
import { FrontmatterFormatError, stripFrontmatter } from "../src/index.js";

describe("stripFrontmatter(llm_prompts markdown 格式)", () => {
  test("解析 id/version 并去掉 frontmatter", () => {
    const r = stripFrontmatter("---\nid: analyze_mistake\nversion: analyze@4\n---\n\n正文第一行\n正文第二行\n");
    expect(r.meta).toEqual({ id: "analyze_mistake", version: "analyze@4" });
    expect(r.body).toBe("正文第一行\n正文第二行");
  });

  test("无 frontmatter 时 meta 为 null、正文 trim", () => {
    const r = stripFrontmatter("  纯正文  \n");
    expect(r.meta).toBeNull();
    expect(r.body).toBe("纯正文");
  });

  test("正文中的 --- 行不受影响", () => {
    const r = stripFrontmatter("---\nid: x\nversion: v@1\n---\n\n第一段\n---\n第二段\n");
    expect(r.meta).toEqual({ id: "x", version: "v@1" });
    expect(r.body).toBe("第一段\n---\n第二段");
  });

  test("缺少结束 --- 抛错", () => {
    expect(() => stripFrontmatter("---\nid: x\n")).toThrow(FrontmatterFormatError);
  });

  test("frontmatter 行缺少冒号抛错", () => {
    expect(() => stripFrontmatter("---\nid x\n---\n正文")).toThrow(FrontmatterFormatError);
  });
});
