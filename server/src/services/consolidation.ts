import { and, eq } from "drizzle-orm";
import {
  ConsolidateProposals,
  type ConsolidateProposals as ConsolidateProposalsType,
  type Subject,
} from "@mistake-book/shared";
import type { ChatClient } from "../ai/client.js";
import { parseModelJson } from "../ai/parse.js";
import { recordRun } from "../ai/runlog.js";
import {
  conceptCategories,
  concepts,
  mastery,
  mistakeConcepts,
  mistakes,
  modelRuns,
} from "../db/schema.js";
import type { Db } from "../db/client.js";
import { promptForConsolidate } from "../prompts/registry.js";
import { assignCategory, mergeConcepts } from "./concepts.js";

export type ConsolidationProposal =
  | { kind: "assignment"; conceptId: string; category: string; reason: string }
  | { kind: "merge"; fromId: string; intoId: string; reason: string };

/** Schema 校验之外再约束所有 ID 必须来自本次输入,禁止模型虚构或跨学科引用。 */
export function parseConsolidationProposals(
  text: string,
  validConceptIds: ReadonlySet<string>,
): ConsolidateProposalsType {
  const parsed = ConsolidateProposals.parse(parseModelJson(text));
  for (const item of parsed.assignments) {
    if (!validConceptIds.has(item.conceptId)) {
      throw new Error(`归类建议引用了未知概念 ID: ${item.conceptId}`);
    }
  }
  for (const item of parsed.merges) {
    if (!validConceptIds.has(item.fromId) || !validConceptIds.has(item.intoId)) {
      throw new Error(`归并建议引用了未知概念 ID: ${item.fromId} -> ${item.intoId}`);
    }
    if (item.fromId === item.intoId) throw new Error("归并建议不能把概念合并到自身");
  }
  return parsed;
}

export function flattenConsolidationProposals(
  proposals: ConsolidateProposalsType,
): ConsolidationProposal[] {
  return [
    ...proposals.assignments.map((p) => ({ kind: "assignment" as const, ...p })),
    ...proposals.merges.map((p) => ({ kind: "merge" as const, ...p })),
  ];
}

/** 单条执行前再次核对 user + subject + active 状态,适配终端逐条确认后的状态变化。 */
export function applyConsolidationProposal(
  db: Db,
  userId: string,
  subject: Subject,
  proposal: ConsolidationProposal,
): void {
  const ids = proposal.kind === "assignment"
    ? [proposal.conceptId]
    : [proposal.fromId, proposal.intoId];
  const rows = ids.map((id) =>
    db
      .select()
      .from(concepts)
      .where(and(eq(concepts.id, id), eq(concepts.userId, userId)))
      .get(),
  );
  if (rows.some((row) => !row || row.subject !== subject || row.status !== "active")) {
    throw new Error("建议中的概念不存在、已被合并或不属于当前用户/学科");
  }
  if (proposal.kind === "assignment") {
    assignCategory(db, userId, proposal.conceptId, proposal.category);
  } else {
    mergeConcepts(db, userId, proposal.fromId, proposal.intoId);
  }
}

/**
 * 调模型生成一次整理建议;少于 3 个概念时按提示词规则直接返回空建议。
 * 模型调用在事务外,每次调用写 model_runs,Schema 失败也留审计状态。
 */
export async function proposeConsolidation(
  db: Db,
  chat: ChatClient,
  userId: string,
  subject: Subject,
): Promise<ConsolidateProposalsType> {
  const conceptRows = db
    .select()
    .from(concepts)
    .where(and(eq(concepts.userId, userId), eq(concepts.subject, subject), eq(concepts.status, "active")))
    .all();
  if (conceptRows.length < 3) return { assignments: [], merges: [] };

  const categories = new Map(
    db
      .select()
      .from(conceptCategories)
      .all()
      .filter((c) => c.userId === userId && c.subject === subject)
      .map((c) => [c.id, c]),
  );
  const activeMistakes = new Set(
    db
      .select({ id: mistakes.id })
      .from(mistakes)
      .where(and(eq(mistakes.userId, userId), eq(mistakes.subject, subject), eq(mistakes.archived, 0)))
      .all()
      .map((m) => m.id),
  );
  const links = db.select().from(mistakeConcepts).all();
  const masteryRows = db
    .select()
    .from(mastery)
    .where(eq(mastery.userId, userId))
    .all();
  const input = {
    subject,
    knownCategories: [...categories.values()]
      .filter((c) => c.status === "active")
      .map((c) => c.canonicalName)
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
      .slice(0, 80),
    concepts: conceptRows.map((concept) => ({
      id: concept.id,
      name: concept.canonicalName,
      category: concept.categoryId ? categories.get(concept.categoryId)?.canonicalName ?? null : null,
      mistakeCount: new Set(
        links
          .filter((link) => link.conceptId === concept.id && activeMistakes.has(link.mistakeId))
          .map((link) => link.mistakeId),
      ).size,
      sampleCount: masteryRows.find((m) => m.conceptId === concept.id)?.sampleCount ?? 0,
    })),
  };

  const prompt = promptForConsolidate();
  const response = await chat.chat("text", {
    taskType: "consolidate_concepts",
    system: prompt.system,
    messages: [{ role: "user", content: prompt.buildUser(input) }],
    jsonMode: true,
  });
  recordRun(db, { ...response.run, promptVersion: prompt.version });
  try {
    return parseConsolidationProposals(
      response.text,
      new Set(conceptRows.map((concept) => concept.id)),
    );
  } catch (error) {
    db.update(modelRuns)
      .set({ status: "schema_fail", error: (error as Error).message })
      .where(eq(modelRuns.id, response.run.id))
      .run();
    throw error;
  }
}
