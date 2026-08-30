import { eq, sql } from "drizzle-orm";
import {
  aiJobs,
  attempts,
  conceptCategories,
  concepts,
  generatedQuestions,
  learnerSummaries,
  learningEvents,
  mastery,
  mistakeConcepts,
  mistakes,
  memoryFacts,
  reviewSchedules,
} from "../db/schema.js";
import type { Db } from "../db/client.js";
import { Subjects, type Subject } from "@mistake-book/shared";
import { createJob } from "../jobs/queue.js";
import { isGraduated, localDate } from "./review.js";

/** 待分析数量(Dashboard 纯查询) */
export function pendingCount(db: Db, userId: string): number {
  return db
    .select()
    .from(mistakes)
    .all()
    .filter((m) => m.userId === userId && m.status === "pending_analysis").length;
}

/** 创建学生分析任务:用户点击与每日检查共用;重复点击返回现有任务 */
export function requestLearnerRefresh(db: Db, userId: string, opts?: { daily?: boolean }) {
  const latestEvent = db
    .select()
    .from(learningEvents)
    .where(eq(learningEvents.userId, userId))
    .all()
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
  const toEventId = latestEvent?.id ?? null;
  return createJob(db, {
    userId,
    jobType: "refresh_learner_analysis",
    payload: {},
    idempotencyKey: opts?.daily ? `refresh:${userId}:${localDate()}` : undefined,
    toEventId,
  });
}

/** 每日检查:只有存在待处理数据时才创建(AGENTS §5-6);幂等键保证每天最多一次 */
export function dailyCheck(db: Db, userId: string): { created: boolean } {
  if (pendingCount(db, userId) === 0) return { created: false };
  const res = requestLearnerRefresh(db, userId, { daily: true });
  return { created: !res.existing };
}

/** 学习者档案(Dashboard 纯查询,绝不调模型) */
export function learnerProfile(db: Db, userId: string) {
  const summaries = db
    .select()
    .from(learnerSummaries)
    .where(eq(learnerSummaries.userId, userId))
    .all()
    .map((s) => ({
      scope: s.scope as Subject,
      summaryMd: (JSON.parse(s.summaryJson) as { summaryMd?: string }).summaryMd ?? "",
      asOfEventId: s.asOfEventId,
      version: s.version,
      generatedAt: s.generatedAt,
    }));

  const lastJobRow = db
    .select()
    .from(aiJobs)
    .all()
    .filter((j) => j.userId === userId && j.jobType === "refresh_learner_analysis")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  return {
    summaries,
    pendingCount: pendingCount(db, userId),
    lastJob: lastJobRow
      ? {
          id: lastJobRow.id,
          status: lastJobRow.status,
          createdAt: lastJobRow.createdAt,
          finishedAt: lastJobRow.finishedAt,
          error: lastJobRow.error,
        }
      : null,
    facts: db
      .select()
      .from(memoryFacts)
      .all()
      .filter((f) => f.userId === userId && (f.status === "active" || f.status === "candidate"))
      .map((f) => ({
        id: f.id,
        scope: f.scope,
        kind: f.kind,
        statement: f.statement,
        confidence: f.confidence,
        status: f.status,
      })),
  };
}

/** 学习分析三视图(PRD 5.4,纯查询) */
export function analytics(db: Db, userId: string) {
  const rows = db
    .select()
    .from(concepts)
    .all()
    .filter((c) => c.userId === userId && c.status === "active");
  const masteryRows = db
    .select()
    .from(mastery)
    .where(eq(mastery.userId, userId))
    .all();
  // 知识点 ↔ 未归档错题关联(错题总数 / 已掌握列的数据源)
  const mistakeRows = db
    .select()
    .from(mistakes)
    .all()
    .filter((m) => m.userId === userId && m.archived === 0);
  const mistakeById = new Map(mistakeRows.map((m) => [m.id, m]));
  // “已练习”只认原错题复习的实际提交;编新题作答不替代原错题练习。
  // pending_judge 也已经完成提交,因此任意结果状态都视为练习过。
  const practicedMistakeIds = new Set(
    db
      .select({ sourceId: attempts.sourceId, sourceType: attempts.sourceType })
      .from(attempts)
      .where(eq(attempts.userId, userId))
      .all()
      .filter((a) => a.sourceType === "mistake_review")
      .map((a) => a.sourceId),
  );
  const conceptMistakes = new Map<string, Set<string>>();
  for (const link of db.select().from(mistakeConcepts).all()) {
    if (!mistakeById.has(link.mistakeId)) continue;
    const ids = conceptMistakes.get(link.conceptId) ?? new Set<string>();
    ids.add(link.mistakeId);
    conceptMistakes.set(link.conceptId, ids);
  }
  const categories = new Map(
    db
      .select()
      .from(conceptCategories)
      .all()
      .filter((c) => c.userId === userId && c.status === "active")
      .map((c) => [c.id, c]),
  );
  const categoryIdByName = new Map(
    [...categories.values()].map((c) => [`${c.subject}\u0000${c.canonicalName}`, c.id]),
  );
  const graduatedCache = new Map<string, boolean>();
  const graduated = (mistakeId: string) => {
    if (!graduatedCache.has(mistakeId)) {
      graduatedCache.set(mistakeId, isGraduated(db, userId, mistakeId));
    }
    return graduatedCache.get(mistakeId) ?? false;
  };

  /**
   * 叶子概念仍是掌握度与证据的计算单位;分类只做稳定的聚合视角。
   * 同一分类中的多个概念可能关联同一道错题,分类行按错题 ID 并集去重;
   * 分类掌握分按作答样本数加权,无样本时取成员初始分均值。
   */
  const members = rows
    .map((c) => {
      const m = masteryRows.find((x) => x.conceptId === c.id);
      const linked = conceptMistakes.get(c.id) ?? new Set<string>();
      return {
        conceptId: c.id,
        name: c.canonicalName,
        subject: c.subject,
        // 查询兜底:旧库或绕过服务层的写入若留下“分类 = 未分类概念”同名冲突,
        // 仍按该分类聚合,避免丢弃任一侧证据或在 Dashboard 显示两行同名项。
        categoryId: c.categoryId && categories.has(c.categoryId)
          ? c.categoryId
          : categoryIdByName.get(`${c.subject}\u0000${c.canonicalName}`) ?? null,
        score: m?.score ?? 50,
        sampleCount: m?.sampleCount ?? 0,
        lastPracticedAt: m?.lastPracticedAt ?? null,
        mistakeIds: linked,
        mistakeCount: linked.size,
        pendingPracticeCount: [...linked].filter((id) => !practicedMistakeIds.has(id)).length,
        graduatedCount: [...linked].filter(graduated).length,
        insufficient: (m?.sampleCount ?? 0) < 3,
      };
    })
    // 零证据概念不进薄弱点:无关联错题且无作答样本。
    .filter((m) => m.mistakeCount > 0 || m.sampleCount > 0);

  const groups = new Map<string, typeof members>();
  for (const member of members) {
    // concept/category 主键都为全局 UUID;复用真实 ID 让前端 key 与追溯更直接。
    const key = member.categoryId ?? member.conceptId;
    const grouped = groups.get(key) ?? [];
    grouped.push(member);
    groups.set(key, grouped);
  }

  // 服务端返回全部分类聚合行(待练习数降序,同数按掌握分升序),Top N 由前端按学科切片。
  const weaknessesFinal = [...groups.entries()]
    .map(([groupId, grouped]) => {
      const first = grouped[0];
      const mistakeIds = new Set(grouped.flatMap((m) => [...m.mistakeIds]));
      const sampleCount = grouped.reduce((sum, m) => sum + m.sampleCount, 0);
      const score = sampleCount > 0
        ? Math.round(
            grouped.reduce((sum, m) => sum + m.score * m.sampleCount, 0) / sampleCount,
          )
        : Math.round(grouped.reduce((sum, m) => sum + m.score, 0) / grouped.length);
      const practiced = grouped
        .map((m) => m.lastPracticedAt)
        .filter((v): v is string => Boolean(v))
        .sort()
        .at(-1) ?? null;
      const category = first.categoryId ? categories.get(first.categoryId) : null;
      return {
        conceptId: groupId,
        categoryId: category?.id ?? null,
        name: category?.canonicalName ?? first.name,
        subject: first.subject,
        score,
        sampleCount,
        lastPracticedAt: practiced,
        mistakeCount: mistakeIds.size,
        pendingPracticeCount: [...mistakeIds]
          .filter((id) => !practicedMistakeIds.has(id)).length,
        graduatedCount: [...mistakeIds].filter(graduated).length,
        insufficient: sampleCount < 3,
        members: grouped
          .map(({ mistakeIds: _mistakeIds, categoryId: _categoryId, ...member }) => member)
          .sort(
            (a, b) => b.pendingPracticeCount - a.pendingPracticeCount
              || a.score - b.score
              || a.name.localeCompare(b.name, "zh-Hans-CN"),
          ),
      };
    })
    .sort(
      (a, b) => b.pendingPracticeCount - a.pendingPracticeCount
        || a.score - b.score
        || a.name.localeCompare(b.name, "zh-Hans-CN"),
    );

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const errorTypeCounts = new Map<string, number>();
  for (const m of mistakeRows.filter(
    (m) => m.errorType && m.createdAt >= since,
  )) {
    const key = `${m.subject}|${m.errorType}`;
    errorTypeCounts.set(key, (errorTypeCounts.get(key) ?? 0) + 1);
  }

  return {
    weaknesses: weaknessesFinal,
    // 错误类型按学科分组(前端提供 全部/学科 筛选)
    errorTypes: [...errorTypeCounts.entries()]
      .map(([key, count]) => {
        const [subject, errorType] = key.split("|");
        return { subject, errorType, count };
      })
      .sort((a, b) => b.count - a.count),
    // 分学科错题与学习状态统计(PRD 5.4)
    subjects: subjectStats(db, userId),
    // 学习方法画像(PRD 5.4 视图 4):AI 画像推断,可被学生纠正;带学科供前端分科过滤
    habits: db
      .select()
      .from(memoryFacts)
      .all()
      .filter(
        (f) => f.userId === userId && f.kind === "habit_pattern" && f.status === "active",
      )
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10)
      .map((f) => ({
        statement: f.statement,
        scope: f.scope,
        confidence: f.confidence,
        status: f.status,
      })),
  };
}

/** 分学科错题与学习状态统计(纯查询;固定返回三科,便于前端稳定展示) */
export interface SubjectStat {
  subject: Subject;
  mistakeTotal: number;
  /** 待分析 = pending_analysis + waiting_input(都还未完成归因) */
  pendingAnalysis: number;
  analyzed: number;
  /** 进行中的复习排期(scheduled)与其中逾期数 */
  reviewScheduled: number;
  reviewOverdue: number;
  /** 已毕业错题数(尾部连续答对达阈值且无未完成排期) */
  graduated: number;
  /** 近 30 天已判分作答数(correct/partial/wrong)、其中正确数与正确率 */
  attempts30d: number;
  correct30d: number;
  correctRate30d: number | null;
  conceptCount: number;
  /** 活跃知识点掌握分均值(无掌握度记录按初始 50 计) */
  avgMastery: number | null;
}

export function subjectStats(db: Db, userId: string): SubjectStat[] {
  const today = localDate();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const mistakeRows = db
    .select()
    .from(mistakes)
    .all()
    .filter((m) => m.userId === userId && m.archived === 0);
  const mistakeSubjectById = new Map(mistakeRows.map((m) => [m.id, m.subject]));
  const conceptRows = db
    .select()
    .from(concepts)
    .all()
    .filter((c) => c.userId === userId && c.status === "active");
  const masteryRows = db
    .select()
    .from(mastery)
    .where(eq(mastery.userId, userId))
    .all();
  const scheduleRows = db
    .select()
    .from(reviewSchedules)
    .all()
    .filter((r) => r.userId === userId);
  const gqSubject = new Map(
    db
      .select()
      .from(generatedQuestions)
      .all()
      .filter((g) => g.userId === userId)
      .map((g) => [g.id, g.subject]),
  );
  const attemptRows = db
    .select()
    .from(attempts)
    .all()
    .filter((a) => a.userId === userId);

  return Subjects.map((subject) => {
    const ms = mistakeRows.filter((m) => m.subject === subject);
    const attemptsSub = attemptRows.filter((a) => {
      if (a.createdAt < since) return false;
      const subj =
        a.sourceType === "mistake_review"
          ? mistakeSubjectById.get(a.sourceId)
          : gqSubject.get(a.sourceId);
      return subj === subject;
    });
    const scored = attemptsSub.filter(
      (a) => a.result === "correct" || a.result === "partial" || a.result === "wrong",
    );
    const correct = scored.filter((a) => a.result === "correct").length;
    const cRows = conceptRows.filter((c) => c.subject === subject);
    const scores = cRows.map((c) => masteryRows.find((x) => x.conceptId === c.id)?.score ?? 50);
    const scheduled = scheduleRows.filter(
      (r) => r.status === "scheduled" && mistakeSubjectById.get(r.mistakeId) === subject,
    );
    return {
      subject,
      mistakeTotal: ms.length,
      pendingAnalysis: ms.filter((m) => m.status !== "analyzed").length,
      analyzed: ms.filter((m) => m.status === "analyzed").length,
      reviewScheduled: scheduled.length,
      reviewOverdue: scheduled.filter((r) => r.dueDate < today).length,
      graduated: ms.filter((m) => isGraduated(db, userId, m.id)).length,
      attempts30d: scored.length,
      correct30d: correct,
      correctRate30d: scored.length ? Math.round((correct / scored.length) * 100) : null,
      conceptCount: cRows.length,
      avgMastery: scores.length
        ? Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length)
        : null,
    };
  });
}

/** 数据导出:JSON 全量事实源(PRD 5.5) */
export function exportJson(db: Db, userId: string) {
  return {
    exportedAt: new Date().toISOString(),
    mistakes: db.select().from(mistakes).all().filter((m) => m.userId === userId),
    attempts: db.select().from(attempts).all().filter((a) => a.userId === userId),
    conceptCategories: db
      .select()
      .from(conceptCategories)
      .all()
      .filter((c) => c.userId === userId),
    concepts: db.select().from(concepts).all().filter((c) => c.userId === userId),
    learningEvents: db
      .select()
      .from(learningEvents)
      .all()
      .filter((e) => e.userId === userId),
    summaries: db.select().from(learnerSummaries).all().filter((s) => s.userId === userId),
  };
}

/** Markdown 导出 */
export function exportMarkdown(db: Db, userId: string): string {
  const rows = db
    .select()
    .from(mistakes)
    .all()
    .filter((m) => m.userId === userId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const parts: string[] = ["# 错题本导出\n"];
  for (const m of rows) {
    const ver = m.currentVersionId
      ? db.get<{ content_json: string }>(
          sql`SELECT content_json FROM mistake_versions WHERE id = ${m.currentVersionId}`,
        )
      : undefined;
    const c = ver ? (JSON.parse(ver.content_json) as { stemMd?: string; myAnswer?: string; note?: string }) : {};
    parts.push(`## ${m.subject} · ${m.createdAt.slice(0, 10)}\n`);
    parts.push(`${c.stemMd ?? "(无题干)"}\n`);
    if (c.myAnswer) parts.push(`**我的答案:** ${c.myAnswer}\n`);
    if (m.errorType) parts.push(`**错误类型:** ${m.errorType}\n`);
    if (c.note) parts.push(`**备注:** ${c.note}\n`);
  }
  return parts.join("\n");
}

/** 数据清空(免登录单机,PRD 5.5):清空业务数据,users 种子保留。
 *  子表(mistake_versions/mistake_concepts/concept_aliases/memory_evidence)
 *  通过外键 ON DELETE CASCADE 级联清理;model_runs 无 user_id,经 ai_jobs 关联删除。 */
export function deleteAllData(db: Db, userId: string): void {
  db.transaction((tx) => {
    tx.run(sql`DELETE FROM mistakes_fts`);
    tx.run(
      sql`DELETE FROM model_runs WHERE job_id IN (SELECT id FROM ai_jobs WHERE user_id = ${userId})`,
    );
    // 顺序:先子后父(级联兜底)
    for (const t of [
      "memory_facts",
      "learner_summaries",
      "generated_questions",
      "practice_sets",
      "mastery",
      "attempts",
      "review_schedules",
      "mistakes",
      "concepts",
      "concept_categories",
      "ingestion_drafts",
      "import_batches",
      "learning_events",
      "ai_jobs",
    ]) {
      tx.run(sql`DELETE FROM ${sql.raw(t)} WHERE user_id = ${userId}`);
    }
  });
}
