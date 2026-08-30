import { useCallback, useEffect, useState } from "react";
import { Badge, Card, Group, Loader, Stack, Text, Button, Progress } from "@mantine/core";
import {
  IconChartPie,
  IconRefreshDot,
  IconGauge,
  IconListCheck,
  IconCircleCheck,
  IconPercentage,
  IconBrain,
  IconClockHour4,
} from "@tabler/icons-react";
import { api } from "../lib/api";
import { PageHeader } from "../components/PageHeader";
import { StatCard, EmptyState, CountBar } from "../components/ui";

interface Analytics {
  weaknesses: {
    conceptId: string;
    name: string;
    subject: string;
    score: number;
    sampleCount: number;
    lastPracticedAt: string | null;
    insufficient: boolean;
  }[];
  errorTypes: { errorType: string; count: number }[];
  habits: { statement: string; confidence: number; status: string }[];
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

const SUBJECT_SCOPES: Record<string, string> = { chinese: "语文", math: "数学", english: "英语" };

/**
 * 学习分析(PRD 5.4)+ 学生问题 Dashboard(AGENTS §5-14):
 * 纯查询,打开页面绝不创建任务或调用模型;
 * 只有手动点「更新学生分析」才触发批量分析任务。
 */
export function AnalyticsPage() {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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

  if (error) return <Text c="red">{error}</Text>;
  if (!analytics || !profile) return <Loader size="sm" />;

  const jobRunning =
    profile.lastJob?.status === "queued" || profile.lastJob?.status === "running";

  const maxErrorCount = Math.max(1, ...analytics.errorTypes.map((e) => e.count));
  const sectionTitle = (title: string, sub?: string) => (
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

  return (
    <div style={{ maxWidth: "var(--app-content-w)" }}>
      <PageHeader
        icon={IconChartPie}
        title="学习分析"
        description="错题归因、薄弱知识点与学习习惯画像"
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
        {/* 概览统计 */}
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

        {/* 薄弱知识点 */}
        <Card className="app-panel" withBorder>
          {sectionTitle("薄弱知识点 Top 10", "分数越低越薄弱,样本 <3 视为数据不足")}
          {analytics.weaknesses.length === 0 ? (
            <EmptyState
              icon={IconBrain}
              title="还没有数据"
              hint="录入错题并完成 AI 分析后,这里会出现你的薄弱知识点排名。"
            />
          ) : (
            <Stack gap="md">
              {analytics.weaknesses.map((w, i) => {
                const barColor = w.score < 40 ? "red" : w.score < 70 ? "yellow" : "teal";
                return (
                  <Group key={w.conceptId} gap="md" wrap="nowrap">
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
                      insufficient={w.insufficient}
                      barColor={barColor}
                    />
                  </Group>
                );
              })}
            </Stack>
          )}
        </Card>

        {/* 错误类型分布 */}
        <Card className="app-panel" withBorder>
          {sectionTitle("错误类型分布", "最近 30 天")}
          {analytics.errorTypes.length === 0 ? (
            <Text c="dimmed" size="sm">
              暂无数据。
            </Text>
          ) : (
            <Stack gap="sm">
              {analytics.errorTypes.map((e) => (
                <CountBar
                  key={e.errorType}
                  label={ERROR_TYPE_LABELS[e.errorType] ?? e.errorType}
                  count={e.count}
                  max={maxErrorCount}
                  color={ERROR_TYPE_COLORS[e.errorType] ?? "brand"}
                />
              ))}
            </Stack>
          )}
        </Card>

        {/* 学习方法画像 */}
        <Card className="app-panel" withBorder>
          {sectionTitle("学习方法画像", "AI 画像推断,可结合错题证据纠正")}
          {analytics.habits.length === 0 ? (
            <Text c="dimmed" size="sm">
              暂无数据。AI 会在分析错题时结合历史规律总结学习方法问题(检查习惯、注意力、时间管理等)。
            </Text>
          ) : (
            <Stack gap="xs">
              {analytics.habits.map((h) => (
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

        {/* 学科总结 */}
        {profile.summaries.map((s) => (
          <Card
            key={s.scope}
            className="app-panel"
            withBorder
            styles={{
              root: {
                borderLeft: "3px solid var(--mantine-color-brand-6)",
              },
            }}
          >
            <Group justify="space-between" mb="xs">
              <Text fw={700} fz={15}>
                学科总结 · {SUBJECT_SCOPES[s.scope] ?? s.scope}
              </Text>
              <Badge variant="light" color="brand">
                v{s.version}
              </Badge>
            </Group>
            <Text size="sm" style={{ whiteSpace: "pre-wrap", lineHeight: 1.7 }}>
              {s.summaryMd}
            </Text>
            <Group gap="xs" mt="md">
              <IconClockHour4 size={13} stroke={1.8} style={{ color: "var(--mantine-color-dimmed)" }} />
              <Text size="xs" c="dimmed">
                生成于 {new Date(s.generatedAt).toLocaleString("zh-CN")}
              </Text>
            </Group>
          </Card>
        ))}

        {/* 长期记忆 */}
        {profile.facts.length > 0 && (
          <Card className="app-panel" withBorder>
            {sectionTitle("长期记忆", "可在错题证据中追溯")}
            <Stack gap="xs">
              {profile.facts.map((f) => (
                <Group key={f.id} gap="sm" wrap="nowrap" align="flex-start">
                  <Badge size="sm" color="gray" style={{ flexShrink: 0 }}>
                    置信度 {Math.round(f.confidence * 100)}%
                  </Badge>
                  <Text size="sm">{f.statement}</Text>
                </Group>
              ))}
            </Stack>
          </Card>
        )}
      </Stack>
    </div>
  );
}

/** 薄弱知识点单行:名称 + 掌握度进度条 + 样本数 */
function WeaknessRow({
  name,
  score,
  sampleCount,
  insufficient,
  barColor,
}: {
  name: string;
  score: number;
  sampleCount: number;
  insufficient: boolean;
  barColor: string;
}) {
  return (
    <Group gap="md" wrap="nowrap" style={{ flex: 1 }}>
      <Text size="sm" fw={500} style={{ flexShrink: 0 }}>
        {name}
      </Text>
      <Progress flex={1} value={insufficient ? 0 : score} color={barColor} size={8} radius="xl" />
      <Badge size="sm" variant="light" color={barColor} w={72} style={{ flexShrink: 0 }}>
        {insufficient ? "数据不足" : `${score} 分`}
      </Badge>
      <Text size="xs" c="dimmed" w={56} ta="right" style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
        {sampleCount} 题
      </Text>
    </Group>
  );
}
