import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconSparkles,
  IconTrash,
  IconBulb,
} from "@tabler/icons-react";
import { ErrorTypes, isFigureDependent } from "@mistake-book/shared";
import { api } from "../lib/api";
import { MathText } from "../components/MathText";
import { SubjectBadge, StatusBadge } from "../components/ui";

interface MistakeDetail {
  id: string;
  subject: string;
  status: string;
  version: number;
  errorType: string | null;
  errorEvidence: string | null;
  improvementsJson: string | null;
  analysisConfidence: number | null;
  needsFollowUp: number;
  followUpQuestion: string | null;
  content: {
    stemMd: string;
    myAnswer?: string;
    correctAnswer?: string;
    note?: string;
  } | null;
  createdAt: string;
}

const SUBJECT_LABELS: Record<string, string> = {
  chinese: "语文",
  math: "数学",
  english: "英语",
};

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

/** 错题详情(PRD 6.2):先展示题目与作答,答案折叠;AI 分析可修正;变式题入口 */
export function MistakeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [item, setItem] = useState<MistakeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [showAnswer, setShowAnswer] = useState(false);
  const [errorType, setErrorType] = useState<string | null>(null);
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const d = await api<MistakeDetail>(`/api/v1/mistakes/${id}`);
      setItem(d);
      setErrorType(d.errorType ?? "unconfirmed");
      setEvidence(d.errorEvidence ?? "");
      setNote(d.content?.note ?? "");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(json: Record<string, unknown>) {
    if (!id) return;
    setSaving(true);
    try {
      await api(`/api/v1/mistakes/${id}`, { method: "PATCH", json });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function generatePractice() {
    if (!id) return;
    setGenerating(true);
    try {
      const res = await api<{ practiceSetId: string }>("/api/v1/practice-sets", {
        method: "POST",
        json: { origin: "mistake", mistakeId: id, params: { concepts: [], count: 3 } },
      });
      navigate(`/practice?setId=${res.practiceSetId}`);
    } catch (e) {
      setError((e as Error).message);
      setGenerating(false);
    }
  }

  async function remove() {
    if (!id || !confirm("确定删除这道错题?关联数据会一并清理。")) return;
    await api(`/api/v1/mistakes/${id}`, { method: "DELETE" });
    navigate("/mistakes");
  }

  if (error) return <Text c="red">{error}</Text>;
  if (!item) return <Loader />;

  // analyze@4:三层建议 {technical, method, cognitive, profileInferred};兼容旧数组
  const advice: unknown = item.improvementsJson
    ? JSON.parse(item.improvementsJson)
    : null;
  const improvements: string[] = Array.isArray(advice)
    ? (advice as string[])
    : (() => {
        const a = (advice ?? {}) as {
          technical?: string[];
          method?: string[];
          cognitive?: string[];
        };
        return [
          ...(a.technical ?? []).map((s) => `${s}`),
          ...(a.method ?? []).map((s) => `【方法】${s}`),
          ...(a.cognitive ?? []).map((s) => `【认知】${s}`),
        ];
      })();

  return (
    <Stack gap="md" maw={800}>
      <Group justify="space-between" wrap="nowrap">
        <Group gap="md">
          <Button variant="subtle" color="gray" leftSection={<IconArrowLeft size={16} />} onClick={() => navigate("/mistakes")} px={8}>
            返回
          </Button>
          <Text fz={20} fw={700}>
            错题详情
          </Text>
        </Group>
        <Group>
          <Button leftSection={<IconSparkles size={16} />} onClick={() => void generatePractice()} loading={generating}>
            生成变式题
          </Button>
          <Button color="red" variant="light" leftSection={<IconTrash size={16} />} onClick={() => void remove()}>
            删除
          </Button>
        </Group>
      </Group>

      <Group gap="sm">
        <SubjectBadge subject={item.subject} />
        <StatusBadge status={item.status} />
        {item.content?.stemMd && isFigureDependent(item.content.stemMd) && (
          <Badge color="grape">
            依赖图形 · 不参与练习/复习
          </Badge>
        )}
        <Text size="sm" c="dimmed">
          版本 v{item.version} · {new Date(item.createdAt).toLocaleString("zh-CN")}
        </Text>
      </Group>

      <Card className="app-panel" withBorder>
        <MathText text={item.content?.stemMd || "(无题干)"} />
        {item.content?.myAnswer && (
          <Text mt="sm" size="sm">
            我的答案:<MathText text={item.content.myAnswer} inline />
          </Text>
        )}
        {item.content?.correctAnswer && (
          <>
            {showAnswer ? (
              <div className="app-answer-panel" style={{ marginTop: 10 }}>
                <Text size="sm" c="teal">
                  正确答案:<MathText text={item.content.correctAnswer} inline />
                </Text>
              </div>
            ) : (
              <Button mt="xs" size="xs" variant="light" onClick={() => setShowAnswer(true)}>
                显示正确答案
              </Button>
            )}
          </>
        )}
      </Card>

      {item.needsFollowUp === 1 && item.followUpQuestion && (
        <Alert color="yellow" title="AI 需要补充信息">
          <MathText text={item.followUpQuestion} inline />
          <Textarea
            mt="xs"
            label="补充说明(你当时的思路)"
            minRows={2}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <Button
            mt="xs"
            size="xs"
            loading={saving}
            onClick={() => void patch({ content: { note } })}
          >
            提交补充(会重新进入待分析)
          </Button>
        </Alert>
      )}

      <Card className="app-panel" withBorder>
        <Group justify="space-between" mb="xs">
          <Group gap="xs">
            <IconBulb size={18} stroke={1.8} style={{ color: "var(--mantine-color-brand-6)" }} />
            <Text fw={700} fz={15}>
              AI 错误分析
            </Text>
          </Group>
          {item.analysisConfidence !== null && (
            <Badge size="sm" color="gray">
              置信度 {Math.round((item.analysisConfidence ?? 0) * 100)}%
            </Badge>
          )}
        </Group>
        {item.errorType ? (
          <Stack gap="xs">
            <Select
              label="主要错误类型(可修正)"
              data={ErrorTypes.map((t) => ({ value: t, label: ERROR_TYPE_LABELS[t] }))}
              value={errorType}
              onChange={(v) => setErrorType(v)}
            />
            <Textarea
              label="证据"
              minRows={2}
              value={evidence}
              onChange={(e) => setEvidence(e.currentTarget.value)}
            />
            <Button
              size="xs"
              w={160}
              loading={saving}
              onClick={() => void patch({ errorType, content: { note } })}
            >
              保存修正
            </Button>
          </Stack>
        ) : (
          <Text c="dimmed" size="sm">
            尚未分析。到「学习分析」页点击「更新学生分析」开始批量分析。
          </Text>
        )}
        {improvements.length > 0 && (
          <Stack gap={6} mt="sm">
            <Text size="sm" fw={700}>
              改进建议
            </Text>
            {improvements.map((s, i) => (
              <Group key={i} gap="sm" wrap="nowrap" align="flex-start">
                <Badge size="sm" variant="light" color="brand" style={{ flexShrink: 0 }}>
                  {i + 1}
                </Badge>
                <Text size="sm" style={{ lineHeight: 1.6 }}>
                  {s}
                </Text>
              </Group>
            ))}
          </Stack>
        )}
      </Card>
    </Stack>
  );
}
