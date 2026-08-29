import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { importDoubaoJson, ImportError } from "../src/services/imports.js";
import { repairJsonEscapes } from "../src/ai/parse.js";
import { createMistake } from "../src/services/mistakes.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrator.js";
import { importBatches, ingestionDrafts, mistakes } from "../src/db/schema.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

function freshDb(): Db {
  const { db } = createDb(":memory:");
  const sqlite = (db as unknown as { $client: import("better-sqlite3").Database }).$client;
  runMigrations(sqlite, MIGRATIONS_DIR);
  return db;
}

const BATCH = JSON.stringify([
  {
    question: "解方程 $2x-4=0$。",
    type: "解答题",
    standard_answer: "x=2",
    standard_solution: "移项得 2x=4,故 x=2。",
    student_answer: "x=2",
    subject: "数学",
    chapter: "一元一次方程",
    error_raw_note: "",
  },
  {
    question: "Choose the correct answer: He ___ to school every day.\nA. go\nB. goes",
    type: "选择",
    standard_answer: "B. goes",
    standard_solution: "",
    student_answer: "",
    subject: "英语",
    chapter: "一般现在时",
    error_raw_note: "不知道选哪个",
  },
]);

describe("豆包 JSON 导入(LLD §4.2,确定性解析零模型)", () => {
  test("合法数组 → 批次 + 按题草稿;中文字段归一;sha256 去重提醒", () => {
    const db = freshDb();
    const r1 = importDoubaoJson(db, "u_local", BATCH);
    expect(r1.questionCount).toBe(2);
    expect(r1.duplicate).toBe(false);
    expect(r1.drafts).toHaveLength(2);

    const drafts = db.select().from(ingestionDrafts).all();
    expect(drafts).toHaveLength(2);
    const first = JSON.parse(drafts[0].resultJson!) as Record<string, unknown>;
    expect(first.subject).toBe("math");
    expect(first.questionType).toBe("解答"); // “解答题”归一为解答
    expect(first.correctAnswer).toBe("x=2");
    expect(first.explanation).toBe("移项得 2x=4,故 x=2。");
    expect(first.myAnswer).toBe("x=2");
    const second = JSON.parse(drafts[1].resultJson!) as Record<string, unknown>;
    expect(second.subject).toBe("english");
    expect(second.questionType).toBe("选择");
    expect(second.myAnswer).toBeNull(); // 空白题

    const batch = db.select().from(importBatches).all()[0];
    expect(batch.templateVersion).toBe("doubao-template@6");
    expect(batch.source).toBe("一元一次方程"); // 首个非空 chapter

    // 完全相同内容再导 → duplicate 提醒但落库不阻断
    const r2 = importDoubaoJson(db, "u_local", BATCH);
    expect(r2.duplicate).toBe(true);
    expect(r2.questionCount).toBe(2);
  });

  test("顶层不是数组 → 整批拒绝且不落库", () => {
    const db = freshDb();
    const obj = JSON.stringify({ questions: [{ question: "题", subject: "数学" }] });
    expect(() => importDoubaoJson(db, "u_local", obj)).toThrow(/JSON 数组/);
    expect(db.select().from(importBatches).all()).toHaveLength(0);
  });

  test("question 为空 / subject 无法映射 → 定位下标报错,不落库", () => {
    const db = freshDb();
    const bad = JSON.stringify([
      { question: "题干", subject: "数学" },
      { question: "", subject: "数学" },
    ]);
    try {
      importDoubaoJson(db, "u_local", bad);
      throw new Error("should not reach");
    } catch (e) {
      expect(e).toBeInstanceOf(ImportError);
      expect((e as ImportError).message).toMatch(/第 2 项/);
    }
    const physics = JSON.stringify([{ question: "题干", subject: "物理" }]);
    try {
      importDoubaoJson(db, "u_local", physics);
      throw new Error("should not reach");
    } catch (e) {
      expect((e as ImportError).details).toMatchObject({
        errors: [{ index: 0, field: "subject" }],
      });
    }
    expect(db.select().from(importBatches).all()).toHaveLength(0);
  });

  test("非 JSON 内容 → VALIDATION_ERROR", () => {
    const db = freshDb();
    expect(() => importDoubaoJson(db, "u_local", "这不是 JSON")).toThrow(ImportError);
  });

  test("repairJsonEscapes:非法转义补反斜杠,合法转义与已双写 \\ 原样保留", () => {
    // 豆包把 LaTeX 定界符 \( \) 单反斜杠塞进 JSON → 修复后字符串内容保留 \( 字面量
    expect(JSON.parse(repairJsonEscapes('{"a":"$\\(x\\)$"}')).a).toBe("$\\(x\\)$");
    // 已双写的 \\dfrac(合法)不动;单反斜杠 \dfrac(非法)补齐
    expect(JSON.parse(repairJsonEscapes('{"a":"\\\\dfrac{1}{2}"}')).a).toBe("\\dfrac{1}{2}");
    expect(JSON.parse(repairJsonEscapes('{"a":"\\dfrac{1}{2}"}')).a).toBe("\\dfrac{1}{2}");
    // 合法换行转义不受影响
    expect(JSON.parse(repairJsonEscapes('{"a":"l\\nb"}')).a).toBe("l\nb");
  });

  test("真实故障复盘:前后缀 + 非法 \( 转义(2026-08-29 用户反馈)", () => {
    const db = freshDb();
    const text = [
      "## 💡解答", // 豆包的标题前缀
      '[{"question":"$3\\dfrac{1}{5}(3x+1)$",',
      '"type":"解答",',
      '"standard_answer":"$\\(x=1\\)$",', // 非法转义 \(
      '"standard_solution":"",',
      '"student_answer":"",',
      '"subject":"数学",',
      '"chapter":"一元一次方程",',
      '"error_raw_note":""}]',
    ].join("\n");
    const r = importDoubaoJson(db, "u_local", text);
    expect(r.questionCount).toBe(1);
    const draft = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      db.select().from(ingestionDrafts).all()[0].resultJson!,
    ) as { correctAnswer: string };
    expect(draft.correctAnswer).toBe("$\\(x=1\\)$"); // LaTeX 定界符按字面保留
  });

  test("容忍 ```json 代码块与简短前后缀包装(只取最外层 JSON 体)", () => {
    const db = freshDb();
    const wrapped = "好的,识别结果如下:\n```json\n" + BATCH + "\n```\n请查收";
    const r = importDoubaoJson(db, "u_local", wrapped);
    expect(r.questionCount).toBe(2);
  });

  test(">512KB → 超限拒绝", () => {
    const db = freshDb();
    const big = JSON.stringify([{ question: "x".repeat(600 * 1024), subject: "数学" }]);
    expect(() => importDoubaoJson(db, "u_local", big)).toThrow(/上限/);
  });

  test("删除批次级联删草稿;已确认错题不受影响", () => {
    const db = freshDb();
    const r = importDoubaoJson(db, "u_local", BATCH);
    const draftId = r.drafts[0].id;
    createMistake(db, "u_local", {
      subject: "math",
      draftId,
      questionType: "解答",
      content: { stemMd: "解方程 $2x-4=0$", correctAnswer: "x=2", myAnswer: "x=2" },
      source: "一元一次方程",
    });
    expect(db.select().from(ingestionDrafts).where(eq(ingestionDrafts.id, draftId)).get()?.status).toBe(
      "confirmed",
    );

    db.delete(importBatches).where(eq(importBatches.id, r.importId)).run();
    expect(db.select().from(ingestionDrafts).all()).toHaveLength(0); // 草稿级联删除
    // 已确认错题保留(mistake_versions 持有内容)
    expect(db.select().from(mistakes).all()).toHaveLength(1);
  });
});
