import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  DOUBAO_IMPORT_LIMITS,
  DOUBAO_TEMPLATE_VERSION,
  DoubaoImport,
  mapDoubaoItems,
  normalizeDoubaoImport,
  type DoubaoMappedItem,
} from "@mistake-book/shared";
import { importBatches, ingestionDrafts } from "../db/schema.js";
import type { Db } from "../db/client.js";
import { parseModelJson, repairJsonEscapes } from "../ai/parse.js";

export class ImportError extends Error {
  constructor(
    public code: "VALIDATION_ERROR",
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface ImportDraft {
  id: string;
  index: number;
  type: DoubaoMappedItem["questionType"];
  question: string;
}

export interface ImportResult {
  importId: string;
  questionCount: number;
  duplicate: boolean;
  drafts: ImportDraft[];
}

/**
 * 豆包 JSON 导入(LLD §4.2):确定性解析,零模型调用。
 * 大小/题数上限 → 顶层必须是数组 → Zod 逐项校验 + 中文字段归一 →
 * sha256 重复提醒(不阻断)→ 短事务写批次与草稿。校验失败不落库。
 */
export function importDoubaoJson(db: Db, userId: string, text: string): ImportResult {
  if (Buffer.byteLength(text, "utf8") > DOUBAO_IMPORT_LIMITS.maxBytes) {
    throw new ImportError(
      "VALIDATION_ERROR",
      `导入内容超过 ${Math.round(DOUBAO_IMPORT_LIMITS.maxBytes / 1024)}KB 上限`,
    );
  }

  let raw: unknown;
  try {
    // 宽松提取,不改动内容本身:
    // 1) 修复非法反斜杠转义(豆包把 LaTeX 的 \( \) 原样写进 JSON 字符串);
    // 2) 容忍 ```json 代码块/简短前后缀(只取最外层 JSON 体)。
    // 数组/字段层面的严格性仍由下面的契约校验负责。
    raw = parseModelJson(repairJsonEscapes(text));
  } catch {
    throw new ImportError("VALIDATION_ERROR", "导入内容不是合法 JSON");
  }
  if (!Array.isArray(normalizeDoubaoImport(raw))) {
    throw new ImportError(
      "VALIDATION_ERROR",
      "导入内容应为 JSON 数组(每个元素一道题),请按豆包识题模板重新生成",
    );
  }

  const parsed = DoubaoImport.safeParse(normalizeDoubaoImport(raw));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const pos = typeof issue.path[0] === "number" ? issue.path[0] + 1 : "?";
    throw new ImportError("VALIDATION_ERROR", `第 ${pos} 项:${issue.message}`, {
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
  }

  const { items, errors } = mapDoubaoItems(parsed.data);
  if (errors.length > 0) {
    throw new ImportError("VALIDATION_ERROR", errors[0].message, { errors });
  }

  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const duplicate = Boolean(
    db
      .select({ id: importBatches.id })
      .from(importBatches)
      .where(and(eq(importBatches.userId, userId), eq(importBatches.sha256, sha256)))
      .get(),
  );

  const importId = randomUUID();
  const now = new Date().toISOString();
  // 批次来源 = 首个非空 chapter(其余题的 chapter 在核对时可并入单题来源)
  const source = parsed.data.map((d) => d.chapter.trim()).find((c) => c) || null;
  const drafts: ImportDraft[] = [];

  db.transaction((tx) => {
    tx.insert(importBatches)
      .values({
        id: importId,
        userId,
        source,
        templateVersion: DOUBAO_TEMPLATE_VERSION,
        rawJson: text,
        sha256,
        questionCount: items.length,
        createdAt: now,
      })
      .run();

    for (const item of items) {
      const draftId = randomUUID();
      const original = parsed.data[item.index];
      tx.insert(ingestionDrafts)
        .values({
          id: draftId,
          userId,
          importBatchId: importId,
          status: "ready",
          resultJson: JSON.stringify({
            subject: item.subject,
            questionType: item.questionType,
            stemMd: item.stemMd,
            correctAnswer: item.correctAnswer,
            explanation: item.explanation,
            myAnswer: item.myAnswer,
            note: item.note,
          }),
          rawJson: JSON.stringify(original),
          createdAt: now,
          updatedAt: now,
        })
        .run();
      drafts.push({
        id: draftId,
        index: item.index,
        type: item.questionType,
        question: item.stemMd,
      });
    }
  });

  return { importId, questionCount: items.length, duplicate, drafts };
}

