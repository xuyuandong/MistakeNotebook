import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  NumberInput,
  Progress,
  Radio,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  Box,
} from "@mantine/core";
import {
  IconTargetArrow,
  IconPlus,
  IconSparkles,
  IconCircleCheck,
} from "@tabler/icons-react";
import { Subjects } from "@mistake-book/shared";
import { api } from "../lib/api";
import { MathText } from "../components/MathText";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/ui";

const SUBJECT_LABELS: Record<string, string> = {
  chinese: "语文",
  math: "数学",
  english: "英语",
};

interface GQ {
  type: "choice" | "fill_blank" | "subjective";
  stemMd: string;
  options?: string[];
  answer: string;
  explanationMd: string;
  readingMaterialMd?: string;
  rubricMd?: string;
}

interface MistakeItem {
  mistakeId: string;
  stemMd: string;
  questionType: string | null;
  correctAnswer: string | null;
  explanation: string | null;
  myAnswer: string | null;
}

type SetQuestion =
  | { kind: "generated"; id: string; status: string; question: GQ }
  | { kind: "mistake"; id: string; mistakeId: string } & MistakeItem;

interface SetDTO {
  id: string;
  subject: string;
  status: "generating" | "ready" | "failed" | "partial";
  error?: string | null;
  selection: { targetConcepts: string[]; rationale: string } | null;
  questions: SetQuestion[];
}

interface AttemptResult {
  attemptId: string;
  judging: "local" | "llm";
  result?: string;
  masteryDelta?: number | null;
  nextReviewDate?: string | null;
}

/**
 * 智能练习(PRD 5.3):选学科 + 旧题/新题开关;LLM 先做选题分析,
 * 作答后客观题本地判定、主观题 LLM 判分入库并更新画像。
 */
export function PracticePage() {
  const [params] = useSearchParams();
  const [subject, setSubject] = useState<string | null>("math");
  const [mode, setMode] = useState("past");
  const [count, setCount] = useState<number>(5);
  const [creating, setCreating] = useState(false);
  const [setId, setSetId] = useState<string | null>(params.get("setId"));
  const [set, setSet] = useState<SetDTO | null>(null);
  const [idx, setIdx] = useState(0);
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [waitSec, setWaitSec] = useState(0);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [currentResult, setCurrentResult] = useState<string | null>(null);
  const [appealMsg, setAppealMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async (id: string) => {
    try {
      const dto = await api<SetDTO>(`/api/v1/practice-sets/${id}`);
      setSet(dto);
      if (dto.status === "generating") {
        setTimeout(() => void poll(id), 1500);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (setId) void poll(setId);
  }, [setId, poll]);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const res = await api<{ practiceSetId: string }>("/api/v1/practice-sets", {
        method: "POST",
        json: { subject, mode, origin: "smart", count },
      });
      setSetId(res.practiceSetId);
      setIdx(0);
      setSet(null);
      // 新一轮练习:清空上一轮的作答与展示状态,避免残留
      setRevealed(false);
      setFeedback(null);
      setAppealMsg(null);
      setAttemptId(null);
      setCurrentResult(null);
      setChoice(null);
      setText("");
      setWaitSec(0);
      void poll(res.practiceSetId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  function currentItem(): { sourceType: "mistake_review" | "generated_question"; sourceId: string; stemMd: string; options?: string[]; type: string } | null {
    const q = set?.questions[idx];
    if (!q) return null;
    if (q.kind === "generated") {
      return {
        sourceType: "generated_question",
        sourceId: q.id,
        stemMd: q.question.stemMd,
        options: q.question.options,
        type: q.question.type,
      };
    }
    return {
      sourceType: "mistake_review",
      sourceId: q.mistakeId,
      stemMd: q.stemMd,
      type: q.questionType ?? "",
    };
  }

  async function submitAnswer(opts: { gaveUp?: boolean } = {}) {
    const item = currentItem();
    if (!set || !item) return;
    setPending(true);
    setWaitSec(0);
    setError(null);
    try {
      const res = await api<AttemptResult>("/api/v1/attempts", {
        method: "POST",
        json: {
          sourceType: item.sourceType,
          sourceId: item.sourceId,
          answer: item.type === "choice" ? choice ?? undefined : text || undefined,
          gaveUp: opts.gaveUp ?? false,
        },
      });
      setAttemptId(res.attemptId);
      if (res.judging === "llm") {
        await pollAttempt(res.attemptId);
      } else {
        setCurrentResult(res.result ?? null);
        setAppealMsg(null);
        const parts: string[] = [];
        if (res.result) {
          const label = { correct: "回答正确", partial: "部分正确", wrong: "回答错误", gave_up: "已跳过" }[res.result] ?? res.result;
          parts.push(label);
        }
        if (res.masteryDelta != null) {
          parts.push(res.masteryDelta === 0 ? "掌握度无变化" : `掌握度 ${res.masteryDelta > 0 ? "+" : ""}${res.masteryDelta}`);
        }
        if (res.nextReviewDate) parts.push(`下次复习 ${res.nextReviewDate}`);
        setFeedback(parts.join(" · "));
        setRevealed(true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  /** 轮询 AI 判分结果:整个判分期间保持 pending(输入禁用、按钮隐藏,防止重复提交);
   *  约 1.5s 一次,连续 3 次查询失败或超过 ~2.5 分钟才退出并给出自判提示。 */
  async function pollAttempt(attemptId: string) {
    const started = Date.now();
    let failures = 0;
    for (let i = 0; ; i++) {
      if (i >= 100) {
        setFeedback("AI 判分超时。这道题仍为待判分状态,可稍后刷新本页查看结果,或先用下方按钮自判。");
        setRevealed(true);
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
      setWaitSec(Math.round((Date.now() - started) / 1000));
      try {
        const d = await api<{ result: string; feedback: { basis: string; comment: string } | null }>(
          `/api/v1/attempts/${attemptId}`,
        );
        failures = 0;
        if (d.result === "pending_judge") continue;
        setCurrentResult(d.result);
        const label = { correct: "AI 判定:正确", partial: "AI 判定:部分正确", wrong: "AI 判定:错误" }[d.result] ?? d.result;
        const lines = [label];
        if (d.feedback?.basis) lines.push(`依据:${d.feedback.basis}`);
        if (d.feedback?.comment) lines.push(`建议:${d.feedback.comment}`);
        setFeedback(lines.join("\n"));
        setRevealed(true);
        return;
      } catch (e) {
        failures += 1;
        if (failures >= 3) {
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

  async function report(reason: string) {
    const item = currentItem();
    if (!item || item.sourceType !== "generated_question") return;
    await api(`/api/v1/questions/${item.sourceId}/reports`, { method: "POST", json: { reason } });
    setFeedback("已举报,该题不会再被推荐。点击下一题继续。");
  }

  function next() {
    setRevealed(false);
    setFeedback(null);
    setAppealMsg(null);
    setChoice(null);
    setText("");
    setAttemptId(null);
    setCurrentResult(null);
    setWaitSec(0);
    setIdx((i) => i + 1);
  }

  const item = currentItem();

  if (!setId) {
    return (
      <Stack gap="md" maw={640}>
        <PageHeader
          icon={IconTargetArrow}
          title="智能练习"
          description="AI 根据掌握情况、历史错题分布和复习记录自动选题"
        />
        <Card className="app-panel" withBorder>
          <Stack gap="md">
            <Select
              label="学科"
              data={Subjects.map((s) => ({ value: s, label: SUBJECT_LABELS[s] }))}
              value={subject}
              onChange={setSubject}
            />
            <Box>
              <Text size="sm" fw={500} mb={4}>题目来源</Text>
              <SegmentedControl
                fullWidth
                value={mode}
                onChange={setMode}
                data={[
                  { value: "past", label: "出旧题(历史错题)" },
                  { value: "new", label: "编新题(AI 生成)" },
                ]}
              />
            </Box>
            <NumberInput label="题数" min={1} max={10} value={count} onChange={(v) => setCount(Number(v) || 5)} w={160} />
            <Group>
              <Button
                leftSection={<IconSparkles size={16} />}
                loading={creating}
                onClick={() => void create()}
                disabled={!subject}
              >
                开始练习
              </Button>
            </Group>
            {error && <Text c="red" size="sm">{error}</Text>}
          </Stack>
        </Card>
      </Stack>
    );
  }

  return (
    <Stack gap="md" maw={760}>
      <PageHeader
        icon={IconTargetArrow}
        title="智能练习"
        description={set ? `第 ${Math.min(idx + 1, set.questions.length)} / ${set.questions.length} 题` : "选题中"}
        actions={
          <Button variant="light" leftSection={<IconPlus size={16} />} onClick={() => { setSetId(null); setSet(null); }}>
            新建练习
          </Button>
        }
      />
      {set && set.questions.length > 0 && (
        <Progress value={(idx / set.questions.length) * 100} size={6} radius="xl" color="brand" />
      )}
      {error && <Text c="red" size="sm">{error}</Text>}

      {set?.status === "generating" && (
        <Card className="app-panel" withBorder>
          <Group gap="sm">
            <Loader size="sm" />
            <Text c="dimmed" size="sm">
              AI 正在分析你的掌握情况并选题…(离开页面后仍可回来查看)
            </Text>
          </Group>
        </Card>
      )}

      {set && (set.status === "failed" || set.status === "partial") && (
        <Alert color="orange">
          {set.status === "failed"
            ? `本轮未能出题:${set.error ?? "未知原因"}。可调整后重试。`
            : `部分题目未通过校验被丢弃,以下为实际可用题数。`}
        </Alert>
      )}

      {set?.selection && set.status !== "generating" && (
        <Alert color="blue" variant="light" title="为什么出这些题">
          {<MathText text={set.selection.rationale} inline />}
          {set.selection.targetConcepts.length > 0 && (
            <Text size="sm" mt={4}>目标知识点:{set.selection.targetConcepts.join("、")}</Text>
          )}
        </Alert>
      )}

      {set && item && idx < set.questions.length && (
        <Card className="app-panel" withBorder>
          <Group justify="space-between" mb="xs">
            <Text size="sm" c="dimmed">
              第 {idx + 1} / {set.questions.length} 题
            </Text>
            <Badge
              color={set.questions[idx].kind === "mistake" ? "brand" : "grape"}
              variant="light"
              leftSection={
                set.questions[idx].kind === "generated" ? <IconSparkles size={12} /> : undefined
              }
            >
              {set.questions[idx].kind === "mistake" ? "历史错题" : "AI 新题"}
            </Badge>
          </Group>
          {set.questions[idx].kind === "generated" &&
            set.questions[idx].question.readingMaterialMd && (
            <div className="app-answer-panel" style={{ marginBottom: 12 }}>
              <MathText text={set.questions[idx].question.readingMaterialMd} style={{ fontSize: "var(--mantine-font-size-sm)" }} />
            </div>
          )}
          <MathText text={item.stemMd} />
          {item.type === "choice" && (
            <Stack mt="sm">
              {item.options?.map((o) => (
                <Radio
                  key={o}
                  value={o}
                  label={<MathText text={o} inline />}
                  checked={choice === o}
                  onChange={() => setChoice(o)}
                  disabled={revealed || pending}
                />
              ))}
            </Stack>
          )}
          {item.type !== "choice" && (
            <Textarea
              mt="sm"
              label="你的作答(主观题由 AI 按标准答案与评分要点判分)"
              minRows={3}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              disabled={revealed || pending}
            />
          )}

          {!revealed && !pending && (
            <Group mt="sm">
              <Button onClick={() => void submitAnswer()} disabled={item.type === "choice" && !choice}>
                提交作答
              </Button>
              <Button variant="subtle" onClick={() => void submitAnswer({ gaveUp: true })}>
                不知道
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
              {(() => {
                const q = set.questions[idx];
                const answerText =
                  q.kind === "generated"
                    ? q.question.answer
                    : q.correctAnswer ?? "(未录入标准答案)";
                const explainText =
                  q.kind === "generated" ? q.question.explanationMd : q.explanation;
                const teal = { color: "var(--mantine-color-teal-7)", fontSize: "var(--mantine-font-size-sm)" };
                return (
                  <>
                    <MathText text={`答案:${answerText}`} style={teal} />
                    {explainText && <MathText text={`解析:${explainText}`} style={teal} />}
                  </>
                );
              })()}
              {feedback && (
                <Card withBorder className="app-panel" p="sm">
                  {currentResult && (
                    <Group gap="xs" mb={4}>
                      {currentResult === "correct" && (
                        <Badge color="teal" leftSection={<IconCircleCheck size={13} />}>判定:正确</Badge>
                      )}
                      {currentResult === "partial" && <Badge color="yellow">判定:部分正确</Badge>}
                      {currentResult === "wrong" && <Badge color="red">判定:错误</Badge>}
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
                <Button onClick={next}>下一题</Button>
                {attemptId && (
                  <>
                    <Text size="xs" c="dimmed">认为判定不对?</Text>
                    <Button
                      variant="subtle"
                      size="xs"
                      disabled={currentResult === "correct"}
                      onClick={() => void appeal("correct")}
                    >
                      我对了
                    </Button>
                    <Button
                      variant="subtle"
                      size="xs"
                      disabled={currentResult === "partial"}
                      onClick={() => void appeal("partial")}
                    >
                      部分对
                    </Button>
                    <Button
                      variant="subtle"
                      size="xs"
                      disabled={currentResult === "wrong"}
                      onClick={() => void appeal("wrong")}
                    >
                      我错了
                    </Button>
                  </>
                )}
                {set.questions[idx].kind === "generated" && (
                  <>
                    <Button variant="subtle" color="orange" onClick={() => void report("wrong_answer")}>
                      报告答案错误
                    </Button>
                    <Button variant="subtle" color="gray" onClick={() => void report("unclear")}>
                      题意不清
                    </Button>
                  </>
                )}
              </Group>
            </Stack>
          )}
        </Card>
      )}

      {set && idx >= set.questions.length && set.questions.length > 0 && (
        <Card className="app-panel" withBorder py={40}>
          <EmptyState
            icon={IconCircleCheck}
            title="本轮练习完成!"
            hint="作答已更新掌握度与学生画像。"
          />
        </Card>
      )}
      {set && set.questions.length === 0 && set.status !== "generating" && (
        <EmptyState
          icon={IconTargetArrow}
          title="没有可用题目"
          hint="AI 未能从当前数据中选出合适的题目,可调整条件重试。"
        />
      )}
    </Stack>
  );
}
