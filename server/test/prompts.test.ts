import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_PROMPTS_DIR, PromptLoadError, loadPromptFile, loadPromptTexts } from "../src/prompts/loader.js";
import { prompts, PROMPT_IDS, promptFor } from "../src/prompts/registry.js";
import { PROMPT_PLACEHOLDERS } from "../src/prompts/index.js";

function writePromptFile(dir: string, id: string, version: string, body: string): void {
  writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\nversion: ${version}\n---\n\n${body}\n`);
}

function makeTempPromptDir(): string {
  return mkdtempSync(join(tmpdir(), "prompts-"));
}

describe("llm_prompts 加载器", () => {
  test("加载仓库真实目录:6 个任务齐全、版本号非空、占位符全部替换", () => {
    const loaded = loadPromptTexts(DEFAULT_PROMPTS_DIR, PROMPT_IDS, PROMPT_PLACEHOLDERS);
    expect(Object.keys(loaded).sort()).toEqual([...PROMPT_IDS].sort());
    for (const id of PROMPT_IDS) {
      expect(loaded[id].version).toMatch(/^[a-z]+@\d+$/);
      expect(loaded[id].system.length).toBeGreaterThan(50);
      expect(loaded[id].system).not.toContain("{{");
    }
    // 占位符注入的枚举文本与代码一致
    expect(loaded.analyze_mistake.system).toContain("knowledge_gap: 知识缺失");
    expect(loaded.analyze_mistake.system).toContain("缺少检查习惯");
    expect(loaded.generate_questions.system).toContain("数学:变式题必须改变原题的数字与情境");
  });

  test("registry 暴露的 PromptDef 与加载结果一致,promptFor 可用", () => {
    expect(prompts.analyze_mistake.version).toMatch(/analyze@\d+/);
    expect(prompts.analyze_mistake.system).toContain("学生错题本的错误分析助手");
    expect(prompts.summarize_learner.buildUser({ scope: "math", newAnalyses: [], stats: [] })).toContain("学科:数学");
    expect(promptFor("judge_answer").system).toContain("作答判分助手");
  });

  test("文件缺失时报出具体路径", () => {
    const dir = makeTempPromptDir();
    writePromptFile(dir, "analyze_mistake", "analyze@1", "正文");
    expect(() => loadPromptTexts(dir, ["analyze_mistake", "judge_answer"], {})).toThrow(PromptLoadError);
    expect(() => loadPromptTexts(dir, ["analyze_mistake", "judge_answer"], {})).toThrow(/judge_answer\.md/);
  });

  test("frontmatter id 与文件名不一致时报错", () => {
    const dir = makeTempPromptDir();
    writeFileSync(join(dir, "judge_answer.md"), "---\nid: other\nversion: judge@1\n---\n\n正文\n");
    expect(() => loadPromptFile(join(dir, "judge_answer.md"), "judge_answer", {})).toThrow(/id 应为 judge_answer/);
  });

  test("缺少 version 报错", () => {
    const dir = makeTempPromptDir();
    writeFileSync(join(dir, "judge_answer.md"), "---\nid: judge_answer\n---\n\n正文\n");
    expect(() => loadPromptFile(join(dir, "judge_answer.md"), "judge_answer", {})).toThrow(/version/);
  });

  test("未识别占位符 fail-fast", () => {
    const dir = makeTempPromptDir();
    writePromptFile(dir, "judge_answer", "judge@1", "未知占位 {{NOT_A_TOKEN}}");
    expect(() => loadPromptFile(join(dir, "judge_answer.md"), "judge_answer", PROMPT_PLACEHOLDERS)).toThrow(
      /NOT_A_TOKEN/,
    );
  });

  test("占位符替换为注入值", () => {
    const dir = makeTempPromptDir();
    writePromptFile(dir, "judge_answer", "judge@1", "枚举:{{HABIT_HINTS_TEXT}}");
    const r = loadPromptFile(join(dir, "judge_answer.md"), "judge_answer", PROMPT_PLACEHOLDERS);
    expect(r.system).toBe("枚举:缺少检查习惯、注意力问题、紧张、时间不足、疏于练习");
  });

  test("目录中未被请求的文件(如 doubao_extract.md)被忽略", () => {
    const dir = makeTempPromptDir();
    writePromptFile(dir, "judge_answer", "judge@1", "正文");
    writePromptFile(dir, "doubao_extract", "doubao-template@6", "豆包模板正文");
    const r = loadPromptTexts(dir, ["judge_answer"], {});
    expect(Object.keys(r)).toEqual(["judge_answer"]);
  });

  test("目录不存在时报错而非未处理异常", () => {
    const dir = join(makeTempPromptDir(), "no-such-dir");
    expect(() => loadPromptTexts(dir, ["judge_answer"], {})).toThrow(PromptLoadError);
  });
});
