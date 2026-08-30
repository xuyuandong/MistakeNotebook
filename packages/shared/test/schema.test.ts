import {
  AnalyzeMistakeResult,
  DoubaoImport,
  GeneratedQuestion,
  JudgeAnswerResult,
  MePatch,
  MistakeCreate,
  isFigureDependent,
  mapDoubaoItems,
  mapDoubaoSubject,
  mapDoubaoType,
  normalizeDoubaoImport,
} from "../src/index.js";

describe("豆包导入契约(doubao-import@2)", () => {
  const item = {
    question: "已知 $f(x)=x^2$,求 $f(2)$。",
    type: "填空",
    standard_answer: "4",
    standard_solution: "代入得 4",
    student_answer: "",
    subject: "数学",
    chapter: "二次函数",
    error_raw_note: "",
  };

  test("接受合法 JSON 数组并归一默认值", () => {
    const r = DoubaoImport.safeParse([item]);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data[0].standard_solution).toBe("代入得 4");
      expect(r.data[0].student_answer).toBe("");
    }
  });

  test("顶层不是数组 → 拒绝", () => {
    expect(DoubaoImport.safeParse(item).success).toBe(false);
    expect(DoubaoImport.safeParse({ questions: [item] }).success).toBe(false);
  });

  test("question 为空 → 拒绝;字段缺失放行(选填)", () => {
    expect(DoubaoImport.safeParse([{ ...item, question: "" }]).success).toBe(false);
    const r = DoubaoImport.safeParse([{ question: "题干", subject: "数学" }]);
    expect(r.success).toBe(true);
  });

  test("suggested_concepts 最多 5 个、每项最多 50 字,旧 JSON 不带字段仍兼容", () => {
    expect(DoubaoImport.safeParse([{ ...item, suggested_concepts: ["固定搭配", "词汇辨析"] }]).success).toBe(true);
    expect(DoubaoImport.safeParse([{ ...item, suggested_concepts: ["1", "2", "3", "4", "5", "6"] }]).success).toBe(false);
    expect(DoubaoImport.safeParse([{ ...item, suggested_concepts: ["x".repeat(51)] }]).success).toBe(false);
    const mapped = mapDoubaoItems(DoubaoImport.parse([{ ...item, suggested_concepts: ["固定搭配"] }]));
    expect(mapped.items[0].suggestedConcepts).toEqual(["固定搭配"]);
  });

  test("normalizeDoubaoImport:只接受数组,对象包装原样返回交由 Zod 整批拒绝", () => {
    expect(normalizeDoubaoImport([item])).toEqual([item]);
    expect(normalizeDoubaoImport({ questions: [item] })).toEqual({ questions: [item] });
    expect(DoubaoImport.safeParse(normalizeDoubaoImport({ questions: [item] })).success).toBe(false);
  });

  test("subject/type 中文归一;未知 subject 返回 null", () => {
    expect(mapDoubaoSubject("数学")).toBe("math");
    expect(mapDoubaoSubject("英语")).toBe("english");
    expect(mapDoubaoSubject("语文")).toBe("chinese");
    expect(mapDoubaoSubject("物理")).toBeNull();
    expect(mapDoubaoType("选择题")).toBe("选择");
    expect(mapDoubaoType("证明题")).toBe("解答");
    expect(mapDoubaoType("什么题")).toBe("其他");
  });

  test("mapDoubaoItems:空字符串→null,student_answer 空=空白题", () => {
    const parsed = DoubaoImport.parse([{ ...item, subject: "英语" }]);
    const { items, errors } = mapDoubaoItems(parsed);
    expect(errors).toHaveLength(0);
    expect(items[0].subject).toBe("english");
    expect(items[0].questionType).toBe("填空");
    expect(items[0].myAnswer).toBeNull(); // 空白题
    expect(items[0].correctAnswer).toBe("4");
    expect(items[0].explanation).toBe("代入得 4");
    expect(items[0].note).toBeNull();
  });

  test("mapDoubaoItems:subject 无法映射 → 报错定位下标", () => {
    const parsed = DoubaoImport.parse([{ ...item, subject: "物理" }]);
    const { errors } = mapDoubaoItems(parsed);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ index: 0, field: "subject" });
  });
});

describe("AI 输出 Schema", () => {
  test("JudgeAnswerResult 校验 verdict 枚举与依据", () => {
    expect(
      JudgeAnswerResult.safeParse({ verdict: "partial", basis: "第二问正确" }).success,
    ).toBe(true);
    expect(
      JudgeAnswerResult.safeParse({ verdict: "部分对", basis: "x" }).success,
    ).toBe(false);
    expect(JudgeAnswerResult.safeParse({ verdict: "correct" }).success).toBe(false); // 缺 basis
  });

  test("AnalyzeMistakeResult 拒绝超出枚举的错误类型", () => {
    const r = AnalyzeMistakeResult.safeParse({
      primaryErrorType: "粗心", // 非法:必须是受限枚举
      concepts: [{ name: "二次函数", confidence: 0.8 }],
      confidence: 0.7,
    });
    expect(r.success).toBe(false);
  });

  test("GeneratedQuestion:选择题答案必须在选项中", () => {
    const good = GeneratedQuestion.safeParse({
      type: "choice",
      stemMd: "1+1=?",
      options: ["A. 1", "B. 2"],
      answer: "B. 2",
      explanationMd: "加法",
      concepts: ["加法"],
      difficulty: 1,
    });
    expect(good.success).toBe(true);

    const bad = GeneratedQuestion.safeParse({
      type: "choice",
      stemMd: "1+1=?",
      options: ["A. 1", "B. 2"],
      answer: "C. 3",
      explanationMd: "加法",
      concepts: ["加法"],
      difficulty: 1,
    });
    expect(bad.success).toBe(false);
  });

  test("GeneratedQuestion:主观题必须带评分要点", () => {
    const bad = GeneratedQuestion.safeParse({
      type: "subjective",
      stemMd: "分析这首诗的情感",
      answer: "言之成理即可",
      explanationMd: "略",
      concepts: ["古诗鉴赏"],
      difficulty: 3,
    });
    expect(bad.success).toBe(false);
  });

  test("GeneratedQuestion:数学题字段齐备时通过", () => {
    const r = GeneratedQuestion.safeParse({
      type: "fill_blank",
      stemMd: "解方程 $x-1=0$,则 $x=$ ____。",
      answer: "1",
      explanationMd: "移项即可。",
      concepts: ["一元一次方程"],
      difficulty: 2,
      sourceMistakeId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    });
    expect(r.success).toBe(true);
  });
});

describe("REST DTO", () => {
  test("MistakeCreate 必须给出草稿/手工/附件之一", () => {
    const bad = MistakeCreate.safeParse({ subject: "math", content: { stemMd: "题干" } });
    expect(bad.success).toBe(false);

    const good = MistakeCreate.safeParse({
      subject: "math",
      manual: { stemMd: "题干" },
      content: { stemMd: "题干", myAnswer: "x=2" },
    });
    expect(good.success).toBe(true);
  });
});

describe("依赖图形识别(PRD 5.3/6.3)", () => {
  test("命中图形指涉与【依赖图形】标记", () => {
    expect(isFigureDependent("如图,在矩形 ABCD 中,求证对角线相等。")).toBe(true);
    expect(isFigureDependent("【依赖图形】求阴影部分面积。")).toBe(true);
    expect(isFigureDependent("观察下图所示的函数图象,回答问题。")).toBe(true);
    expect(isFigureDependent("由右图可知两直线平行。")).toBe(true);
  });

  test("纯文字题不误判", () => {
    expect(isFigureDependent("解方程 $3x-9=0$,则 $x=$ ____。")).toBe(false);
    expect(isFigureDependent("在△ABC中,AB=AC,∠A=40°,求∠B 的度数。")).toBe(false);
    expect(isFigureDependent("求函数 $y=x^2$ 的图象开口方向。")).toBe(false);
  });
});

describe("复习间隔配置(PRD 6.3)", () => {
  test("合法配置:三科严格递增的天数数组", () => {
    const r = MePatch.safeParse({
      reviewIntervals: { chinese: [1, 3, 7], english: [1, 2, 4, 8], math: [1, 10, 30] },
    });
    expect(r.success).toBe(true);
  });

  test("非递增、超档数、非法值都被拒绝", () => {
    expect(
      MePatch.safeParse({ reviewIntervals: { chinese: [3, 1], english: [1, 3], math: [1, 10] } }).success,
    ).toBe(false);
    expect(
      MePatch.safeParse({ reviewIntervals: { chinese: [1, 3, 7, 14, 30, 60, 90], english: [1, 3], math: [1, 10] } }).success,
    ).toBe(false);
    expect(
      MePatch.safeParse({ reviewIntervals: { chinese: [0, 3], english: [1, 3], math: [1, 10] } }).success,
    ).toBe(false);
  });
});
