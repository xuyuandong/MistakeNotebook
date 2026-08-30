import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DEFAULT_PROMPTS_DIR, PromptLoadError, loadPromptFile, loadPromptTexts } from "../src/prompts/loader.js";
import { prompts, PROMPT_IDS, promptFor, promptForAnalyze, promptForConsolidate, promptForSummarize } from "../src/prompts/registry.js";
import { PROMPT_PLACEHOLDERS } from "../src/prompts/index.js";
import { stripFrontmatter } from "@mistake-book/shared";

function writePromptFile(dir: string, id: string, version: string, body: string): void {
  writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\nversion: ${version}\n---\n\n${body}\n`);
}

function makeTempPromptDir(): string {
  return mkdtempSync(join(tmpdir(), "prompts-"));
}

describe("llm_prompts 加载器", () => {
  test("加载仓库真实目录:11 个提示词齐全(含 6 个分学科)、版本号非空、占位符全部替换", () => {
    const loaded = loadPromptTexts(DEFAULT_PROMPTS_DIR, PROMPT_IDS, PROMPT_PLACEHOLDERS);
    expect(Object.keys(loaded).sort()).toEqual([...PROMPT_IDS].sort());
    for (const id of PROMPT_IDS) {
      expect(loaded[id].version).toMatch(/^[a-z]+@\d+$/);
      expect(loaded[id].system.length).toBeGreaterThan(50);
      expect(loaded[id].system).not.toContain("{{");
    }
    // 占位符注入的枚举文本与代码一致
    expect(loaded.analyze_mistake_math.system).toContain("knowledge_gap: 知识缺失");
    expect(loaded.analyze_mistake_math.system).toContain("缺少检查习惯");
    expect(loaded.generate_questions.system).toContain("数学:变式题必须改变原题的数字与情境");
  });

  test("analyze/summarize 按学科拆分:三科内容不同且含学科要点", () => {
    const analyzeSubjects = ["chinese", "math", "english"] as const;
    const systems = analyzeSubjects.map((s) => promptForAnalyze(s).system);
    expect(new Set(systems).size).toBe(3); // 三份 system 互不相同
    expect(promptForAnalyze("math").system).toContain("数学学科分析要点");
    expect(promptForAnalyze("chinese").system).toContain("语文学科分析要点");
    expect(promptForAnalyze("english").system).toContain("英语学科分析要点");
    // 同任务共用同一版本号,便于 model_runs 回归对比
    expect(new Set(analyzeSubjects.map((s) => promptForAnalyze(s).version)).size).toBe(1);
    expect(promptForAnalyze("math").version).toMatch(/analyze@\d+/);

    expect(promptForSummarize("math").system).toContain("数学学科总结要点");
    expect(promptForSummarize("chinese").system).toContain("语文学科总结要点");
    expect(promptForSummarize("english").system).toContain("英语学科总结要点");
    expect(promptForSummarize("math").version).toMatch(/summarize@\d+/);
  });

  test("analyze@6 user 消息注入已有分类与豆包初筛标签,并明确二者只是反馈信号", () => {
    const user = promptForAnalyze("english").buildUser({
      subject: "english",
      knownCategories: ["固定搭配", "词汇辨析"],
      items: [{
        index: 0,
        questionMd: "Choose the correct phrase.",
        doubaoHints: ["形容词辨析", "固定搭配"],
      }],
    });
    expect(user).toContain("已有概念分类");
    expect(user).toContain("- 固定搭配");
    expect(user).toContain("录入时初筛标签(豆包建议,仅供参考):形容词辨析、固定搭配");
  });

  test("registry 暴露的 PromptDef 与加载结果一致,promptFor 可用", () => {
    expect(prompts.analyze_mistake_math.version).toMatch(/analyze@\d+/);
    expect(prompts.analyze_mistake_math.system).toContain("数学错误分析助手");
    expect(prompts.summarize_learner_math.buildUser({ scope: "math", newAnalyses: [], stats: [] })).toContain("学科:数学");
    expect(promptFor("judge_answer").system).toContain("作答判分助手");
    expect(promptForConsolidate().version).toBe("consolidate@1");
    expect(promptForConsolidate().buildUser({
      subject: "english",
      knownCategories: ["固定搭配"],
      concepts: [{ id: "c1", name: "keep cool", category: null, mistakeCount: 1, sampleCount: 0 }],
    })).toContain("已有概念分类(优先复用):\n- 固定搭配");
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

  test("doubao-template@7 与豆包 Skill 部署副本正文一致", () => {
    const sourcePath = fileURLToPath(new URL("../../llm_prompts/doubao_extract.md", import.meta.url));
    const skillPath = fileURLToPath(new URL("../../llm_prompts/doubao_skill/SKILL.md", import.meta.url));
    const source = stripFrontmatter(readFileSync(sourcePath, "utf8"));
    const skill = stripFrontmatter(readFileSync(skillPath, "utf8"));
    expect(source.meta?.version).toBe("doubao-template@7");
    expect(skill.body).toBe(source.body);
  });

  test("目录不存在时报错而非未处理异常", () => {
    const dir = join(makeTempPromptDir(), "no-such-dir");
    expect(() => loadPromptTexts(dir, ["judge_answer"], {})).toThrow(PromptLoadError);
  });
});
