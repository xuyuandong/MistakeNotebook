import { z } from "zod";
import type { Subject } from "./enums.js";

/**
 * 豆包导入契约 doubao-import@2(LLD 附录 A):
 * 人工把作业照片交给豆包,豆包按模板输出一个 JSON 数组,每个元素一道题。
 * 本系统只导入该数组——导入是确定性解析(Zod + 中文别名归一),不调用任何模型。
 * 导入内容视为不可信输入:字段只作题目数据,任何指令都不执行。
 */
export const DOUBAO_TEMPLATE_VERSION = "doubao-template@7";

export const DOUBAO_IMPORT_LIMITS = {
  /** 单批最多题数 */
  maxQuestions: 50,
  /** 单批最大 UTF-8 字节数 */
  maxBytes: 512 * 1024,
  /** 每题建议标签上限(doubao-template@7 起的参考信号,不直接建概念) */
  maxSuggestedConcepts: 5,
  /** 单个建议标签最大长度 */
  maxSuggestedConceptLength: 50,
} as const;

export const DoubaoQuestionTypes = ["选择", "填空", "解答", "阅读", "其他"] as const;
export type DoubaoQuestionType = (typeof DoubaoQuestionTypes)[number];

/** 豆包输出的单题元素;选填字段缺省为空字符串 */
export const DoubaoImportItem = z.object({
  question: z.string().trim().min(1, "question(题干)不能为空").max(20000),
  type: z.string().trim().max(50).default(""),
  standard_answer: z.string().max(10000).default(""),
  standard_solution: z.string().max(20000).default(""),
  student_answer: z.string().max(10000).default(""),
  subject: z.string().trim().min(1, "subject(学科)不能为空").max(20),
  chapter: z.string().max(200).default(""),
  error_raw_note: z.string().max(2000).default(""),
  /** 建议知识点标签(doubao-template@7 起可选):仅作 AI 分析时的参考信号 */
  suggested_concepts: z
    .array(z.string().trim().min(1).max(DOUBAO_IMPORT_LIMITS.maxSuggestedConceptLength))
    .max(DOUBAO_IMPORT_LIMITS.maxSuggestedConcepts, `suggested_concepts 每题最多 ${DOUBAO_IMPORT_LIMITS.maxSuggestedConcepts} 个`)
    .optional(),
});
export type DoubaoImportItem = z.infer<typeof DoubaoImportItem>;

/** 顶层必须是 JSON 数组(整批 ≤50 题) */
export const DoubaoImport = z
  .array(DoubaoImportItem)
  .min(1, "导入内容应为 JSON 数组且至少包含一道题")
  .max(DOUBAO_IMPORT_LIMITS.maxQuestions, `单批最多 ${DOUBAO_IMPORT_LIMITS.maxQuestions} 道题`);
export type DoubaoImport = z.infer<typeof DoubaoImport>;

const SUBJECT_ALIASES: Record<string, Subject> = {
  数学: "math",
  math: "math",
  英语: "english",
  english: "english",
  语文: "chinese",
  chinese: "chinese",
};

/** subject 中文归一;无法映射返回 null(整批拒绝,定位到下标) */
export function mapDoubaoSubject(raw: string): Subject | null {
  return SUBJECT_ALIASES[raw.trim()] ?? null;
}

const TYPE_ALIASES: Record<string, DoubaoQuestionType> = {
  选择: "选择",
  选择题: "选择",
  单选: "选择",
  多选: "选择",
  判断: "选择",
  填空: "填空",
  填空题: "填空",
  解答: "解答",
  解答题: "解答",
  计算: "解答",
  证明: "解答",
  应用: "解答",
  作文: "解答",
  阅读: "阅读",
  阅读理解: "阅读",
};

const TYPE_RULES: [RegExp, DoubaoQuestionType][] = [
  [/选择|单选|多选|判断/, "选择"],
  [/填空/, "填空"],
  [/阅读/, "阅读"],
  [/解答|计算|证明|应用|作答|作文|简答|论述/, "解答"],
];

/** 题型中文归一(别名精确匹配 + 子串规则);无法映射归入“其他”,不拒绝 */
export function mapDoubaoType(raw: string): DoubaoQuestionType {
  const t = raw.trim();
  if (TYPE_ALIASES[t]) return TYPE_ALIASES[t];
  for (const [re, type] of TYPE_RULES) {
    if (re.test(t)) return type;
  }
  return "其他";
}

function emptyToNull(v: string): string | null {
  const t = v.trim();
  return t ? t : null;
}

export interface DoubaoMappedItem {
  /** 数组下标(0 起),错误定位与排序用 */
  index: number;
  subject: Subject | null; // null = subject 无法映射(整批拒绝)
  stemMd: string;
  questionType: DoubaoQuestionType;
  correctAnswer: string | null;
  explanation: string | null;
  /** 空字符串/缺失 → null,即“空白题”(按完全不会处理) */
  myAnswer: string | null;
  note: string | null;
  /** 建议知识点标签(@7 起可选):仅作分析参考,不直接建概念 */
  suggestedConcepts: string[];
}

export interface DoubaoMappingError {
  index: number;
  field: string;
  message: string;
}

/** 把校验后的豆包数组映射为系统内结构;subject 无法映射不抛错,由调用方整批拒绝 */
export function mapDoubaoItems(items: DoubaoImport): {
  items: DoubaoMappedItem[];
  errors: DoubaoMappingError[];
} {
  const mapped: DoubaoMappedItem[] = [];
  const errors: DoubaoMappingError[] = [];
  items.forEach((item, index) => {
    const subject = mapDoubaoSubject(item.subject);
    if (!subject) {
      errors.push({
        index,
        field: "subject",
        message: `第 ${index + 1} 题 subject "${item.subject}" 无法识别(应为 数学/英语/语文)`,
      });
    }
    mapped.push({
      index,
      subject,
      stemMd: item.question,
      questionType: mapDoubaoType(item.type),
      correctAnswer: emptyToNull(item.standard_answer),
      explanation: emptyToNull(item.standard_solution),
      myAnswer: emptyToNull(item.student_answer),
      note: emptyToNull(item.error_raw_note),
      suggestedConcepts: item.suggested_concepts ?? [],
    });
  });
  return { items: mapped, errors };
}

/**
 * 顶层结构校验(契约规定):只接受 JSON 数组,其余形状原样返回交给 Zod 整批拒绝。
 * 豆包偶发的对象包装 {questions:[...]} 不在契约内——按模板重新生成,避免静默放宽。
 */
export function normalizeDoubaoImport(raw: unknown): unknown {
  return raw;
}
