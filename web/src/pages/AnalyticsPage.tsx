import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Card,
  Group,
  Loader,
  Select,
  Stack,
  Table,
  Text,
  Button,
  Progress,
  SegmentedControl,
  UnstyledButton,
} from "@mantine/core";
import {
  IconChartPie,
  IconRefreshDot,
  IconGauge,
  IconListCheck,
  IconPercentage,
  IconBrain,
  IconClockHour4,
  IconChevronDown,
  IconChevronRight,
} from "@tabler/icons-react";
import { api } from "../lib/api";
import { PageHeader } from "../components/PageHeader";
import { EmptyState, StatCard, CountBar, SUBJECT_LABELS, SUBJECT_COLORS } from "../components/ui";

interface Weakness {
  conceptId: string;
  name: string;
  subject: string;
  score: number;
  /** 练习量:计入掌握度的作答样本数 */
  sampleCount: number;
  lastPracticedAt: string | null;
  /** 关联未归档错题总数 */
  mistakeCount: number;
  /** 已毕业错题数(掌握程度 = 毕业/总数) */
  graduatedCount: number;
  insufficient: boolean;
  /** 分类行下的具体知识概念;同分类成员可展开查看 */
  members: WeaknessMember[];
}

type WeaknessMember = Omit<Weakness, "members">;

interface SubjectStat {
  subject: string;
  mistakeTotal: number;
  pendingAnalysis: number;
  analyzed: number;
  reviewScheduled: number;
  reviewOverdue: number;
  graduated: number;
  attempts30d: number;
  correct30d: number;
  correctRate30d: number | null;
  conceptCount: number;
  avgMastery: number | null;
}

interface Analytics {
  /** 全部活跃分类聚合行(按掌握分升序),前端按学科与 Top N 切片 */
  weaknesses: Weakness[];
  /** 按学科分组的错误类型计数(最近 30 天) */
  errorTypes: { subject: string; errorType: string; count: number }[];
  subjects: SubjectStat[];
  /** 学习方法画像,scope 为所属学科 */
  habits: { statement: string; scope: string; confidence: number; status: string }[];
  reviewStats: {
    planned: number;
    completed: number;
    correctRate: number | null;
    overdue: number;
  };
}

interface Profile {
  summaries: { scope: string; summaryMd: string; version: number; generatedAt: string }[];
  pendingCount: number;
  lastJob: { id: string; status: string; createdAt: string; finishedAt: string | null; error: string | null } | null;
  facts: { id: string; statement: string; confidence: number; status: string }[];
}

const ERROR_TYPE_LABELS: Record<string, string> = {
  knowledge_gap: "知识缺失",
  comprehension: "理解偏差",
  method_choice: "方法选择",
  reasoning_calc: "推理/计算",
  expression: "表达规范",
  carelessness: "粗心/检查",
  time_state: "时间与状态",
  unconfirmed: "未确认",
};

const ERROR_TYPE_COLORS: Record<string, string> = {
  knowledge_gap: "red",
  comprehension: "orange",
  method_choice: "yellow",
  reasoning_calc: "violet",
  expression: "grape",
  carelessness: "pink",
  time_state: "indigo",
  unconfirmed: "gray",
};

const SUBJECT_ORDER = ["chinese", "math", "english"] as const;

const SUBJECT_SEGMENT = SUBJECT_ORDER.map((s) => ({ value: s, label: SUBJECT_LABELS[s] }));

const TOP_N_OPTIONS = [
  { value: "10", label: "Top 10" },
  { value: "20", label: "Top 20" },
  { value: "50", label: "Top 50" },
  { value: "all", label: "全部" },
];

/** 按学科过滤错误类型计数(全部 = 跨学科求和),输出按数量降序 */
function errorTypeRows(
  rows: { subject: string; errorType: string; count: number }[],
  subject: string,
): { errorType: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (subject !== "all" && r.subject !== subject) continue;
    counts.set(r.errorType, (counts.get(r.errorType) ?? 0) + r.count);
  }
  return [...counts.entries()]
    .map(([errorType, count]) => ({ errorType, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 学习分析(PRD 5.4)+ 学生问题 Dashboard(AGENTS §5-14):
 * 上段“整体情况”跨学科汇总;下段“分学科情况”由学科切换统一控制,纯查询,
 * 打开页面绝不创建任务或调用模型;只有手动点「更新学生分析」才触发批量分析任务。
 */
export function AnalyticsPage() {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** 分学科情况的当前学科;null = 自动选第一个有数据的学科 */
  const [subject, setSubject] = useState<string | null>(null);
  /** 薄弱知识点 Top N */
  const [topN, setTopN] = useState<string>("10");
  const [expandedWeaknesses, setExpandedWeaknesses] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      setAnalytics(await api<Analytics>("/api/v1/analytics/weaknesses"));
      setProfile(await api<Profile>("/api/v1/learner-profile"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 刷新任务进行中时轮询状态
  useEffect(() => {
    if (profile?.lastJob && (profile.lastJob.status === "queued" || profile.lastJob.status === "running")) {
      const t = setTimeout(() => void load(), 2000);
      return () => clearTimeout(t);
    }
    setRefreshing(false);
  }, [profile, load]);

  async function refresh() {
    setRefreshing(true);
    try {
      await api("/api/v1/learner-profile/refresh", { method: "POST" });
      await load();
    } catch (e) {
      setError((e as Error).message);
      setRefreshing(false);
    }
  }

  // 默认定位到第一个有数据的学科(错题/知识点/总结任一存在)
  const activeSubject = useMemo(() => {
    if (subject) return subject;
    if (!analytics) return "math";
    const firstWithData = SUBJECT_ORDER.find((s) => {
      const stat = analytics.subjects.find((x) => x.subject === s);
      return (
        (stat && (stat.mistakeTotal > 0 || stat.conceptCount > 0)) ||
        profile?.summaries.some((sum) => sum.scope === s)
      );
    });
    return firstWithData ?? "math";
  }, [subject, analytics, profile]);

  /** 上段总体状态(不分学科):由分学科统计与复习统计聚合 */
  const overall = useMemo(() => {
    if (!analytics) return null;
    const sum = (pick: (s: SubjectStat) => number) =>
      analytics.subjects.reduce((acc, s) => acc + pick(s), 0);
    const attempts = sum((s) => s.attempts30d);
    const correct = sum((s) => s.correct30d);
    return {
      mistakes: sum((s) => s.mistakeTotal),
      analyzed: sum((s) => s.analyzed),
      pending: sum((s) => s.pendingAnalysis),
      graduated: sum((s) => s.graduated),
      concepts: sum((s) => s.conceptCount),
      attempts30d: attempts,
      correctRate30d: attempts > 0 ? Math.round((correct / attempts) * 100) : null,
      reviewOverdue: analytics.reviewStats.overdue,
    };
  }, [analytics]);

  /** 跨学科学习方法画像:同结论去重(保留最高置信度) */
  const overviewHabits = useMemo(() => {
    const byStatement = new Map<string, { statement: string; scope: string; confidence: number }>();
    for (const h of analytics?.habits ?? []) {
      const prev = byStatement.get(h.statement);
      if (!prev || h.confidence > prev.confidence) byStatement.set(h.statement, h);
    }
    return [...byStatement.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 8);
  }, [analytics]);

  if (error) return <Text c="red">{error}</Text>;
  if (!analytics || !profile) return <Loader size="sm" />;

  const jobRunning =
    profile.lastJob?.status === "queued" || profile.lastJob?.status === "running";

  const sectionLabel = (text: string, hint?: string) => (
    <Group justify="space-between" align="baseline" mt="xs">
      <Text fw={700} fz={13} c="dimmed" style={{ letterSpacing: "0.05em" }}>
        {text}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Group>
  );

  const cardTitle = (title: string, sub?: string) => (
    <Group justify="space-between" mb="md" align="flex-end">
      <Text fw={700} fz={15}>
        {title}
      </Text>
      {sub && (
        <Text size="xs" c="dimmed">
          {sub}
        </Text>
      )}
    </Group>
  );

  // ===== 下段:分学科数据(全部由 activeSubject 驱动) =====
  const subjectStat = analytics.subjects.find((s) => s.subject === activeSubject);
  const subjectSummary = profile.summaries.find((s) => s.scope === activeSubject);
  const subjectHabits = analytics.habits.filter((h) => h.scope === activeSubject);
  const subjectErrorTypes = errorTypeRows(analytics.errorTypes, activeSubject);
  const subjectWeaknesses = analytics.weaknesses.filter((w) => w.subject === activeSubject);
  const shownWeaknesses =
    topN === "all" ? subjectWeaknesses : subjectWeaknesses.slice(0, Number(topN));

  return (
    <div style={{ maxWidth: "var(--app-content-w)" }}>
      <PageHeader
        icon={IconChartPie}
        title="学习分析"
        description="上段看整体,下段分学科;纯查询不触发模型"
        actions={
          <Button
            leftSection={<IconRefreshDot size={16} />}
            onClick={() => void refresh()}
            loading={refreshing || jobRunning}
          >
            更新学生分析
          </Button>
        }
      />

      <Stack gap="md">
        {/* ============ 上段:整体情况(不分学科) ============ */}
        {sectionLabel("整体情况", "跨学科汇总,学科明细见下半页")}

        <Group grow align="stretch">
          <StatCard
            label="待分析"
            value={profile.pendingCount}
            icon={IconListCheck}
            color="blue"
            hint={profile.lastJob
              ? `最近任务:${profile.lastJob.status === "succeeded" ? "已完成" : profile.lastJob.status === "failed" ? "失败" : profile.lastJob.status === "partial" ? "部分成功" : "进行中"}`
              : "还没有运行过分析任务"}
          />
          <StatCard
            label="本周复习计划"
            value={analytics.reviewStats.planned}
            icon={IconGauge}
            color="brand"
            hint={`已完成 ${analytics.reviewStats.completed} · 逾期 ${analytics.reviewStats.overdue}`}
          />
          <StatCard
            label="本周正确率"
            value={analytics.reviewStats.correctRate !== null ? `${analytics.reviewStats.correctRate}%` : "—"}
            icon={IconPercentage}
            color="teal"
            hint="复习作答判定正确占比"
          />
        </Group>

        {jobRunning && (
          <Card className="app-panel" withBorder padding="sm" bg="transparent">
            <Group gap="xs">
              <Loader size="xs" />
              <Text size="sm" c="brand">
                分析任务进行中,完成后本页自动刷新(期间不会重复创建任务)…
              </Text>
            </Group>
          </Card>
        )}

        {/* 分学科统计表 */}
        <Card className="app-panel" withBorder>
          {cardTitle("分学科统计", "错题状态与学习进度 · 按学科对比")}
          <Table.ScrollContainer minWidth={720}>
            <Table verticalSpacing="xs" horizontalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>学科</Table.Th>
                  <Table.Th ta="right">错题</Table.Th>
                  <Table.Th ta="right">待分析</Table.Th>
                  <Table.Th ta="right">复习中</Table.Th>
                  <Table.Th ta="right">逾期</Table.Th>
                  <Table.Th ta="right">已毕业</Table.Th>
                  <Table.Th ta="right">练习 30 天</Table.Th>
                  <Table.Th ta="right">正确率 30 天</Table.Th>
                  <Table.Th ta="right">知识点</Table.Th>
                  <Table.Th ta="right">平均掌握</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {analytics.subjects.map((s) => {
                  const empty =
                    s.mistakeTotal === 0 && s.conceptCount === 0 && s.attempts30d === 0;
                  return (
                    <Table.Tr
                      key={s.subject}
                      opacity={empty ? 0.45 : 1}
                      onClick={() => setSubject(s.subject)}
                      style={{ cursor: "pointer" }}
                    >
                      <Table.Td>
                        <Badge
                          size="sm"
                          variant="light"
                          color={SUBJECT_COLORS[s.subject] ?? "gray"}
                          style={{ flexShrink: 0 }}
                        >
                          {SUBJECT_LABELS[s.subject] ?? s.subject}
                        </Badge>
                      </Table.Td>
                      <Table.Td ta="right" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {s.mistakeTotal}
                      </Table.Td>
                      <Table.Td ta="right" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {s.pendingAnalysis || "—"}
                      </Table.Td>
                      <Table.Td ta="right" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {s.reviewScheduled || "—"}
                      </Table.Td>
                      <Table.Td ta="right" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {s.reviewOverdue ? (
                          <Text component="span" c="red" size="sm">
                            {s.reviewOverdue}
                          </Text>
                        ) : (
                          "—"
                        )}
                      </Table.Td>
                      <Table.Td ta="right" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {s.graduated || "—"}
                      </Table.Td>
                      <Table.Td ta="right" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {s.attempts30d || "—"}
                      </Table.Td>
                      <Table.Td ta="right" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {s.correctRate30d !== null ? `${s.correctRate30d}%` : "—"}
                      </Table.Td>
                      <Table.Td ta="right" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {s.conceptCount || "—"}
                      </Table.Td>
                      <Table.Td ta="right" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {s.avgMastery !== null ? `${s.avgMastery} 分` : "—"}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          <Text size="xs" c="dimmed" mt="sm">
            待分析含待补充;已毕业 = 尾部连续答对达阈值、不再安排复习的错题;平均掌握为该科活跃知识点掌握分均值(未练习按初始 50 计);点击行可切换下方学科视图。
          </Text>
        </Card>

        {/* 总体学习状态与习惯总结(不分学科) */}
        <Card className="app-panel" withBorder>
          {cardTitle("总体学习状态", "不分学科汇总")}
          {overall && (
            <Stack gap="xs">
              <Text size="sm" lh={1.8}>
                错题积累:共 <Text component="span" fw={700}>{overall.mistakes}</Text> 道(已分析{" "}
                {overall.analyzed}、待处理 {overall.pending}),其中已毕业{" "}
                <Text component="span" fw={700}>{overall.graduated}</Text> 道;沉淀知识概念{" "}
                <Text component="span" fw={700}>{overall.concepts}</Text> 个。
              </Text>
              <Text size="sm" lh={1.8}>
                练习状态:近 30 天练习 <Text component="span" fw={700}>{overall.attempts30d}</Text> 次、正确率{" "}
                <Text component="span" fw={700}>
                  {overall.correctRate30d !== null ? `${overall.correctRate30d}%` : "—"}
                </Text>
                ;本周复习完成 {analytics.reviewStats.completed}/{analytics.reviewStats.planned}
                {overall.reviewOverdue > 0 ? (
                  <>
                    ,逾期 <Text component="span" c="red" fw={700}>{overall.reviewOverdue}</Text> 项待补
                  </>
                ) : (
                  ",无逾期"
                )}
                。
              </Text>
            </Stack>
          )}
          <Text fw={700} fz={13} mt="md" mb="xs" c="dimmed">
            学习方法习惯(跨学科去重)
          </Text>
          {overviewHabits.length === 0 ? (
            <Text size="sm" c="dimmed">
              暂无数据。AI 会在分析错题时结合历史规律总结学习方法问题(检查习惯、注意力、时间管理等)。
            </Text>
          ) : (
            <Stack gap="xs">
              {overviewHabits.map((h) => (
                <Group key={h.statement} gap="sm" wrap="nowrap" align="flex-start">
                  <Badge size="sm" variant="light" color={SUBJECT_COLORS[h.scope] ?? "gray"} style={{ flexShrink: 0 }}>
                    {SUBJECT_LABELS[h.scope] ?? h.scope}
                  </Badge>
                  <Badge size="sm" color="grape" style={{ flexShrink: 0 }}>
                    置信度 {Math.round(h.confidence * 100)}%
                  </Badge>
                  <Text size="sm">{h.statement}</Text>
                </Group>
              ))}
            </Stack>
          )}
        </Card>

        {/* ============ 下段:分学科情况 ============ */}
        {sectionLabel("分学科情况", "以下所有视图只显示当前学科")}
        <Group justify="space-between" align="center">
          <Text size="sm" c="dimmed">
            当前学科:{SUBJECT_LABELS[activeSubject] ?? activeSubject}
            {subjectStat && subjectStat.mistakeTotal > 0
              ? ` · ${subjectStat.mistakeTotal} 道错题 · ${subjectStat.conceptCount} 个知识点`
              : " · 暂无错题数据"}
          </Text>
          <SegmentedControl
            size="xs"
            value={activeSubject}
            onChange={(v) => setSubject(v)}
            data={SUBJECT_SEGMENT}
          />
        </Group>

        {/* 学科总结 */}
        <Card
          className="app-panel"
          withBorder
          styles={{ root: { borderLeft: "3px solid var(--mantine-color-brand-6)" } }}
        >
          <Group justify="space-between" mb="xs">
            <Text fw={700} fz={15}>
              学科总结 · {SUBJECT_LABELS[activeSubject] ?? activeSubject}
            </Text>
            {subjectSummary && <Badge variant="light" color="brand">v{subjectSummary.version}</Badge>}
          </Group>
          {subjectSummary ? (
            <>
              <Text size="sm" style={{ whiteSpace: "pre-wrap", lineHeight: 1.7 }}>
                {subjectSummary.summaryMd}
              </Text>
              <Group gap="xs" mt="md">
                <IconClockHour4 size={13} stroke={1.8} style={{ color: "var(--mantine-color-dimmed)" }} />
                <Text size="xs" c="dimmed">
                  生成于 {new Date(subjectSummary.generatedAt).toLocaleString("zh-CN")}
                </Text>
              </Group>
            </>
          ) : (
            <Text size="sm" c="dimmed">
              还没有该学科的 AI 总结。导入错题后点击右上角「更新学生分析」生成。
            </Text>
          )}
        </Card>

        {/* 学习方法画像(当前学科) */}
        <Card className="app-panel" withBorder>
          {cardTitle("学习方法画像", "AI 画像推断,可结合错题证据纠正")}
          {subjectHabits.length === 0 ? (
            <Text size="sm" c="dimmed">
              该学科暂无学习方法画像。
            </Text>
          ) : (
            <Stack gap="xs">
              {subjectHabits.map((h) => (
                <Group key={h.statement} gap="sm" wrap="nowrap" align="flex-start">
                  <Badge size="sm" color="grape" style={{ flexShrink: 0 }}>
                    置信度 {Math.round(h.confidence * 100)}%
                  </Badge>
                  <Text size="sm">{h.statement}</Text>
                </Group>
              ))}
            </Stack>
          )}
        </Card>

        {/* 错误类型分布(当前学科) */}
        <Card className="app-panel" withBorder>
          {cardTitle("错误类型分布", "最近 30 天")}
          {subjectErrorTypes.length === 0 ? (
            <Text c="dimmed" size="sm">
              暂无数据。
            </Text>
          ) : (
            <Stack gap="sm">
              {subjectErrorTypes.map((e) => (
                <CountBar
                  key={e.errorType}
                  label={ERROR_TYPE_LABELS[e.errorType] ?? e.errorType}
                  count={e.count}
                  max={Math.max(1, ...subjectErrorTypes.map((x) => x.count))}
                  color={ERROR_TYPE_COLORS[e.errorType] ?? "brand"}
                />
              ))}
            </Stack>
          )}
        </Card>

        {/* 薄弱知识点 Top N(当前学科) */}
        <Card className="app-panel" withBorder>
          <Group justify="space-between" mb="xs" align="flex-end">
            <Text fw={700} fz={15}>
              薄弱知识点{topN === "all" ? "" : ` Top ${topN}`}
            </Text>
            <Select
              size="xs"
              w={110}
              value={topN}
              onChange={(v) => v && setTopN(v)}
              data={TOP_N_OPTIONS}
              aria-label="显示数量"
            />
          </Group>
          <Text size="xs" c="dimmed" mb="md">
            分类按已有体系聚合;可展开查看具体知识点。错题按题目去重,掌握=已毕业/总数,练习=作答样本(&lt;3 数据不足)
            {subjectWeaknesses.length > 0 &&
              ` · 该科共 ${subjectWeaknesses.length} 个知识点,当前显示 ${shownWeaknesses.length} 个`}
          </Text>
          {shownWeaknesses.length === 0 ? (
            <EmptyState
              icon={IconBrain}
              title="还没有数据"
              hint="录入错题并完成 AI 分析后,这里会出现该学科的薄弱知识点排名。"
            />
          ) : (
            <Stack gap="md">
              <Group gap="md" wrap="nowrap">
                <Text w={20} style={{ flexShrink: 0 }} />
                <Text size="xs" c="dimmed" flex={1} ta="right">
                  知识点 / 掌握度
                </Text>
                <Text size="xs" c="dimmed" w={72} ta="center" style={{ flexShrink: 0 }}>
                  状态
                </Text>
                <Text size="xs" c="dimmed" w={40} ta="right" style={{ flexShrink: 0 }}>
                  错题
                </Text>
                <Text size="xs" c="dimmed" w={56} ta="right" style={{ flexShrink: 0 }}>
                  掌握
                </Text>
                <Text size="xs" c="dimmed" w={44} ta="right" style={{ flexShrink: 0 }}>
                  练习
                </Text>
              </Group>
              {shownWeaknesses.map((w, i) => {
                const barColor = w.score < 40 ? "red" : w.score < 70 ? "yellow" : "teal";
                const expandable = w.members.length > 1;
                const expanded = expandedWeaknesses.has(w.conceptId);
                return (
                  <Stack key={w.conceptId} gap={6}>
                    <Group gap="md" wrap="nowrap">
                      <Text
                        size="xs"
                        fw={700}
                        c="dimmed"
                        w={20}
                        ta="center"
                        style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
                      >
                        {i + 1}
                      </Text>
                      <WeaknessRow
                        name={w.name}
                        score={w.score}
                        sampleCount={w.sampleCount}
                        mistakeCount={w.mistakeCount}
                        graduatedCount={w.graduatedCount}
                        insufficient={w.insufficient}
                        barColor={barColor}
                        expandable={expandable}
                        expanded={expanded}
                        onToggle={() => {
                          if (!expandable) return;
                          setExpandedWeaknesses((current) => {
                            const next = new Set(current);
                            if (next.has(w.conceptId)) next.delete(w.conceptId);
                            else next.add(w.conceptId);
                            return next;
                          });
                        }}
                      />
                    </Group>
                    {expanded && w.members.map((member) => {
                      const memberColor = member.score < 40 ? "red" : member.score < 70 ? "yellow" : "teal";
                      return (
                        <Group key={member.conceptId} gap="md" wrap="nowrap" pl={36}>
                          <WeaknessRow
                            name={member.name}
                            score={member.score}
                            sampleCount={member.sampleCount}
                            mistakeCount={member.mistakeCount}
                            graduatedCount={member.graduatedCount}
                            insufficient={member.insufficient}
                            barColor={memberColor}
                            detail
                          />
                        </Group>
                      );
                    })}
                  </Stack>
                );
              })}
            </Stack>
          )}
        </Card>
      </Stack>
    </div>
  );
}

/**
 * 薄弱知识点单行:名称 + 掌握度进度条 + 状态 + 三列统计。
 * 错题 = 关联未归档错题数;掌握 = 已毕业/错题总数(毕业 = 复习连续答对退出排期);
 * 练习 = 计入掌握度的作答样本数。总量 − 毕业 = 待巩固数。
 */
function WeaknessRow({
  name,
  score,
  sampleCount,
  mistakeCount,
  graduatedCount,
  insufficient,
  barColor,
  expandable = false,
  expanded = false,
  onToggle,
  detail = false,
}: {
  name: string;
  score: number;
  sampleCount: number;
  mistakeCount: number;
  graduatedCount: number;
  insufficient: boolean;
  barColor: string;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  detail?: boolean;
}) {
  return (
    <Group gap="md" wrap="nowrap" style={{ flex: 1 }}>
      <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
        {expandable ? (
          <UnstyledButton
            onClick={onToggle}
            aria-label={expanded ? `收起${name}` : `展开${name}`}
            style={{ display: "flex", alignItems: "center" }}
          >
            {expanded ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
          </UnstyledButton>
        ) : detail ? (
          <Text c="dimmed" size="xs" w={15} ta="center">•</Text>
        ) : null}
        <Text size="sm" fw={detail ? 400 : 500} c={detail ? "dimmed" : undefined}>
          {name}
        </Text>
      </Group>
      <Progress flex={1} value={insufficient ? 0 : score} color={barColor} size={8} radius="xl" />
      <Badge size="sm" variant="light" color={barColor} w={72} style={{ flexShrink: 0 }}>
        {insufficient ? "数据不足" : `${score} 分`}
      </Badge>
      <Text size="xs" c="dimmed" w={40} ta="right" style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
        {mistakeCount}
      </Text>
      <Text
        size="xs"
        c={graduatedCount > 0 ? "teal" : "dimmed"}
        w={56}
        ta="right"
        style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
      >
        {graduatedCount}/{mistakeCount}
      </Text>
      <Text size="xs" c="dimmed" w={44} ta="right" style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
        {sampleCount}
      </Text>
    </Group>
  );
}
