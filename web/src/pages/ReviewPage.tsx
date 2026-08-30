import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  Group,
  Loader,
  Progress,
  Stack,
  Text,
  Textarea,
  Badge,
  Alert,
} from "@mantine/core";
import {
  IconCalendarCheck,
  IconCircleCheck,
  IconCircleX,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { api } from "../lib/api";
import { MathText } from "../components/MathText";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/ui";
import { GRADUATION_STREAK } from "@mistake-book/shared";

interface TodayItem {
  mistakeId: string;
  dueDate: string;
  overdue: boolean;
}

interface MistakeDetail {
  id: string;
  questionType: string | null;
  content: { stemMd?: string; myAnswer?: string; correctAnswer?: string; explanationMd?: string; note?: string } | null;
  followUpQuestion: string | null;
}

interface AttemptResponse {
  attemptId: string;
  judging: "local" | "llm";
  result?: string;
  masteryDelta?: number | null;
  nextReviewDate?: string | null;
  graduated?: boolean;
}

/** 毕业提示(PRD 6.3):连续答对达阈值后不再安排复习。
 *  不承诺"旧题自动回来"——概念重逢复活是设置页开关(默认关闭)。 */
function graduationNotice(): string {
  return `🎉 连续 ${GRADUATION_STREAK} 次答对,这道题已毕业,不再安排复习`;
}

/**
 * 今日复习(PRD 6.3):一次一题;先作答再对答案。
 * 客观题(选择/填空且录入了标准答案)提交后本地判定;主观题由 AI 判分(可申诉/自判改判);
 * “不知道”直接按放弃处理。
 */
export function ReviewPage() {
  const [items, setItems] = useState<TodayItem[] | null>(null);
  const [current, setCurrent] = useState<MistakeDetail | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [waitSec, setWaitSec] = useState(0);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [currentResult, setCurrentResult] = useState<string | null>(null);
  const [appealMsg, setAppealMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<TodayItem[]>([]);
  const [done, setDone] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await api<{ items: TodayItem[] }>("/api/v1/reviews/today");
      setItems(res.items);
      setQueue(res.items);
      setDone(0);
      if (res.items[0]) {
        setCurrent(await api<MistakeDetail>(`/api/v1/mistakes/${res.items[0].mistakeId}`));
      } else {
        setCurrent(null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(opts: { gaveUp?: boolean } = {}) {
    if (!current) return;
    setPending(true);
    setWaitSec(0);
    setError(null);
    try {
      const res = await api<AttemptResponse>("/api/v1/attempts", {
        method: "POST",
        json: {
          sourceType: "mistake_review",
          sourceId: current.id,
          answer: draft || undefined,
          gaveUp: opts.gaveUp ?? false,
        },
      });
      setAttemptId(res.attemptId);
      if (res.judging === "llm") {
        await pollAttempt(res.attemptId);
      } else {
        setCurrentResult(res.result ?? null);
        setAppealMsg(null);
        const parts: string[] = ["已记录"];
        if (res.result) {
          const label = { correct: "回答正确", partial: "部分正确", wrong: "回答错误", gave_up: "已跳过" }[res.result] ?? res.result;
          parts.push(label);
        }
        if (res.masteryDelta != null) {
          parts.push(res.masteryDelta === 0 ? "掌握度无变化" : `掌握度 ${res.masteryDelta > 0 ? "+" : ""}${res.masteryDelta}`);
        }
        if (res.nextReviewDate) parts.push(`下次复习 ${res.nextReviewDate}`);
        if (res.graduated) parts.push(graduationNotice());
        setMessage(parts.join(" · "));
        advance();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  /** 轮询 AI 判分结果:整个判分期间保持 pending(输入禁用、按钮隐藏,防止重复提交) */
  async function pollAttempt(id: string) {
    const started = Date.now();
    let failures = 0;
    for (let i = 0; ; i++) {
      if (i >= 100) {
        setMessage(null);
        setFeedback("AI 判分超时。这道题仍为待判分状态,可稍后刷新本页查看结果,或先用下方按钮自判。");
        setRevealed(true);
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
      setWaitSec(Math.round((Date.now() - started) / 1000));
      try {
        const d = await api<{ result: string; feedback: { basis: string; comment: string } | null; graduated?: boolean }>(
          `/api/v1/attempts/${id}`,
        );
        failures = 0;
        if (d.result === "pending_judge") continue;
        setMessage(null);
        setCurrentResult(d.result);
        const label = { correct: "AI 判定:正确", partial: "AI 判定:部分正确", wrong: "AI 判定:错误" }[d.result] ?? d.result;
        const lines = [label];
        if (d.feedback?.basis) lines.push(`依据:${d.feedback.basis}`);
        if (d.feedback?.comment) lines.push(`建议:${d.feedback.comment}`);
        if (d.graduated) lines.push(graduationNotice());
        setFeedback(lines.join("\n"));
        setRevealed(true);
        return;
      } catch (e) {
        failures += 1;
        if (failures >= 3) {
          setMessage(null);
          setFeedback(`判分查询失败:${(e as Error).message}。可稍后刷新重试,或先用下方按钮自判。`);
          setRevealed(true);
          return;
        }
      }
    }
  }

  async function appeal(result: "correct" | "partial" | "wrong") {
    if (!attemptId) return;
    if (result === currentResult) {
      setAppealMsg("判定未变化,掌握度不变");
      return;
    }
    try {
      const res = await api<{ masteryDelta: number | null }>(`/api/v1/attempts/${attemptId}`, {
        method: "PATCH",
        json: { result },
      });
      setCurrentResult(result);
      const delta =
        res.masteryDelta == null
          ? ""
          : res.masteryDelta === 0
            ? " · 掌握度无变化"
            : ` · 掌握度变化 ${res.masteryDelta > 0 ? "+" : ""}${res.masteryDelta}`;
      setAppealMsg(`已改判为「${{ correct: "正确", partial: "部分正确", wrong: "错误" }[result]}」${delta}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function advance() {
    setRevealed(false);
    setDraft("");
    setFeedback(null);
    setAppealMsg(null);
    setAttemptId(null);
    setCurrentResult(null);
    setWaitSec(0);
    const rest = queue.slice(1);
    setQueue(rest);
    setDone((d) => d + 1);
    if (rest[0]) {
      void api<MistakeDetail>(`/api/v1/mistakes/${rest[0].mistakeId}`).then(setCurrent);
    } else {
      setCurrent(null);
    }
  }

  if (error) return <Text c="red">{error}</Text>;
  if (items === null) return <Loader />;

  return (
    <Stack gap="md" maw="var(--app-content-w)">
      <PageHeader
        icon={IconCalendarCheck}
        title="今日复习"
        description={
          items.length > 0
            ? `第 ${done + 1} / ${items.length} 题${items.filter((i) => i.overdue).length > 0 ? ` · 含 ${items.filter((i) => i.overdue).length} 道逾期` : ""}`
            : "按记忆间隔安排的到期题目"
        }
      />
      {items.length > 0 && (
        <Progress
          value={items.length > 0 ? ((done + (current ? 0 : 1)) / items.length) * 100 : 0}
          size={6}
          radius="xl"
          color="brand"
        />
      )}
      {message && (
        <Alert color="green" withCloseButton onClose={() => setMessage(null)} icon={<IconCircleCheck size={18} />}>
          {message}
        </Alert>
      )}

      {items.length === 0 && (
        <EmptyState
          icon={IconCalendarCheck}
          title="今天没有到期复习"
          hint="按记忆间隔安排,今天的题目都完成了。保持节奏!"
        />
      )}

      {current && (
        <Card className="app-panel" withBorder>
          <MathText text={current.content?.stemMd || "(无题干)"} />
          <Textarea
            mt="sm"
            label="你的作答(选择题/填空题会自动判定;解答题由 AI 判分)"
            minRows={2}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            disabled={revealed || pending}
          />
          {!revealed && !pending && (
            <Group mt="sm">
              <Button onClick={() => void submit()} disabled={!draft.trim()}>
                提交作答
              </Button>
              <Button variant="light" color="gray" onClick={() => void submit({ gaveUp: true })}>
                不知道(跳过)
              </Button>
            </Group>
          )}
          {pending && (
            <Alert mt="sm" color="blue" variant="light" icon={<Loader size="sm" />} title={`AI 判分中… 已等待 ${waitSec} 秒`}>
              主观题由 AI 对照标准答案判分,通常几秒到十几秒;请勿重复提交或刷新页面。
            </Alert>
          )}
          {revealed && (
            <Stack mt="sm" gap="xs">
              <div className="app-answer-panel">
                <Stack gap={4}>
                  <MathText
                    text={`正确答案:${current.content?.correctAnswer ?? "(未录入标准答案)"}`}
                    style={{ color: "var(--mantine-color-teal-7)", fontSize: "var(--mantine-font-size-sm)" }}
                  />
                  {current.content?.explanationMd && (
                    <MathText
                      text={`解析:${current.content.explanationMd}`}
                      style={{ color: "var(--mantine-color-teal-7)", fontSize: "var(--mantine-font-size-sm)" }}
                    />
                  )}
                </Stack>
              </div>
              {current.content?.note && (
                <Text c="dimmed" size="sm">
                  当时备注:{current.content.note}
                </Text>
              )}
              {feedback && (
                <Card withBorder className="app-panel" p="sm">
                  {currentResult && (
                    <Group gap="xs" mb={4}>
                      {currentResult === "correct" && (
                        <Badge color="teal" leftSection={<IconCircleCheck size={13} />}>判定:正确</Badge>
                      )}
                      {currentResult === "partial" && (
                        <Badge color="yellow" leftSection={<IconAlertTriangle size={13} />}>判定:部分正确</Badge>
                      )}
                      {currentResult === "wrong" && (
                        <Badge color="red" leftSection={<IconCircleX size={13} />}>判定:错误</Badge>
                      )}
                      {currentResult === "gave_up" && <Badge color="gray">已跳过</Badge>}
                    </Group>
                  )}
                  <MathText text={feedback} style={{ fontSize: "var(--mantine-font-size-sm)" }} />
                </Card>
              )}
              {appealMsg && (
                <Text size="sm" c="orange">
                  {appealMsg}
                </Text>
              )}
              <Group>
                <Button onClick={advance}>下一题</Button>
                {attemptId && (
                  <>
                    <Text size="xs" c="dimmed">认为判定不对?</Text>
                    <Button
                      variant="light"
                      color="teal"
                      size="xs"
                      disabled={currentResult === "correct"}
                      onClick={() => void appeal("correct")}
                    >
                      我答对了
                    </Button>
                    <Button
                      variant="light"
                      color="yellow"
                      size="xs"
                      disabled={currentResult === "partial"}
                      onClick={() => void appeal("partial")}
                    >
                      部分对
                    </Button>
                    <Button
                      variant="light"
                      color="red"
                      size="xs"
                      disabled={currentResult === "wrong"}
                      onClick={() => void appeal("wrong")}
                    >
                      我错了
                    </Button>
                  </>
                )}
              </Group>
            </Stack>
          )}
        </Card>
      )}

      {items.length > 0 && !current && (
        <Card className="app-panel" withBorder py={40}>
          <EmptyState
            icon={IconCircleCheck}
            title="今日复习完成!"
            hint={`共完成 ${done} 题,作答已计入掌握度。`}
          />
        </Card>
      )}
    </Stack>
  );
}
