import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  Card,
  Collapse,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
} from "@mantine/core";
import {
  IconCloudUpload,
  IconCopy,
  IconPencil,
  IconUpload,
} from "@tabler/icons-react";
import { Subjects } from "@mistake-book/shared";
import { api } from "../lib/api";
import { DOUBAO_TEMPLATE } from "../lib/doubaoTemplate";
import { PageHeader } from "../components/PageHeader";
import { SUBJECT_COLORS } from "../components/ui";

const SUBJECT_LABELS: Record<string, string> = {
  chinese: "语文",
  math: "数学",
  english: "英语",
};

interface ImportDraft {
  id: string;
  index: number;
  type: string;
  question: string;
}

interface ImportResult {
  importId: string;
  questionCount: number;
  duplicate: boolean;
  drafts: ImportDraft[];
}

interface DraftResult {
  subject?: string;
  questionType?: string;
  stemMd: string;
  correctAnswer?: string | null;
  explanation?: string | null;
  myAnswer?: string | null;
  note?: string | null;
  /** 豆包建议知识点标签(doubao-template@7):随保存进 content,分析时作参考 */
  doubaoHints?: string[];
}

interface QuestionForm {
  draftId: string;
  index: number;
  subject: string | null;
  questionType: string;
  stemMd: string;
  correctAnswer: string;
  explanation: string;
  myAnswer: string;
  note: string;
  doubaoHints: string[];
  rawJson: string;
  saved: boolean;
}

type Mode = "import" | "manual";

/**
 * 导入录入(PRD 5.1):豆包 JSON 粘贴/文件导入 → 逐题草稿核对 → 保存;
 * 手动输入兜底。导入是确定性解析,不调用模型。
 */
export function CapturePage() {
  const navigate = useNavigate();
  const fileRef = { current: null as HTMLInputElement | null };

  const [mode, setMode] = useState<Mode>("import");
  const [phase, setPhase] = useState<"idle" | "importing" | "ready" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [importId, setImportId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<QuestionForm[]>([]);
  const [rawOpen, setRawOpen] = useState<number | null>(null);

  // 手动输入
  const [manualSubject, setManualSubject] = useState<string | null>(null);
  const [manualStem, setManualStem] = useState("");
  const [manualType, setManualType] = useState("");
  const [manualAnswer, setManualAnswer] = useState("");
  const [manualMyAnswer, setManualMyAnswer] = useState("");
  const [manualNote, setManualNote] = useState("");

  async function doImport(text: string) {
    setError(null);
    setNotice(null);
    setPhase("importing");
    try {
      const res = await api<ImportResult>("/api/v1/imports", {
        method: "POST",
        json: { text },
      });
      setImportId(res.importId);
      if (res.duplicate) setNotice("这份 JSON 之前导入过(内容相同),已按重复导入处理");
      const drafts = res.drafts;
      // 预填表单:草稿 result 由后端归一,这里再取回完整字段
      setQuestions(
        drafts.map((d) => ({
          draftId: d.id,
          index: d.index + 1,
          subject: null,
          questionType: d.type,
          stemMd: d.question,
          correctAnswer: "",
          explanation: "",
          myAnswer: "",
          note: "",
          doubaoHints: [],
          rawJson: "",
          saved: false,
        })),
      );
      // 取回归一后的完整字段(correctAnswer/explanation/myAnswer/note)
      const detail = await api<{ drafts: { id: string; result: DraftResult | null; rawJson: string | null }[] }>(
        `/api/v1/imports/${res.importId}`,
      );
      setQuestions((qs) =>
        qs.map((q) => {
          const d = detail.drafts.find((x) => x.id === q.draftId);
          const r = d?.result as DraftResult | null;
          return {
            ...q,
            subject: r?.subject ?? null,
            questionType: r?.questionType ?? q.questionType,
            stemMd: r?.stemMd ?? q.stemMd,
            correctAnswer: r?.correctAnswer ?? "",
            explanation: r?.explanation ?? "",
            myAnswer: r?.myAnswer ?? "",
            note: r?.note ?? "",
            doubaoHints: r?.doubaoHints ?? [],
            rawJson: d?.rawJson ?? "",
          };
        }),
      );
      setPhase("ready");
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    }
  }

  function reset() {
    setPhase("idle");
    setImportId(null);
    setQuestions([]);
    setJsonText("");
    setRawOpen(null);
    setManualSubject(null);
    setManualStem("");
    setManualType("");
    setManualAnswer("");
    setManualMyAnswer("");
    setManualNote("");
  }

  function patchQuestion(i: number, patch: Partial<QuestionForm>) {
    setQuestions((qs) => qs.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));
  }

  async function saveQuestion(q: QuestionForm): Promise<void> {
    if (!q.subject) throw new Error(`第 ${q.index} 题缺少学科,请先选择`);
    await api("/api/v1/mistakes", {
      method: "POST",
      json: {
        subject: q.subject,
        draftId: q.draftId,
        questionType: q.questionType || undefined,
        content: {
          stemMd: q.stemMd || "(无题干,待补充)",
          ...(q.correctAnswer ? { correctAnswer: q.correctAnswer } : {}),
          ...(q.explanation ? { explanationMd: q.explanation } : {}),
          ...(q.myAnswer ? { myAnswer: q.myAnswer } : {}),
          ...(q.note ? { note: q.note } : {}),
          ...(q.doubaoHints.length ? { doubaoHints: q.doubaoHints } : {}),
        },
      },
    });
    patchQuestion(questions.indexOf(q), { saved: true });
  }

  async function saveAll() {
    setError(null);
    setPhase("saving");
    try {
      for (const q of questions) {
        if (!q.saved) await saveQuestion(q);
      }
      navigate("/mistakes");
    } catch (e) {
      setError((e as Error).message);
      setPhase("ready");
    }
  }

  async function saveManual() {
    if (!manualSubject) return setError("请选择学科");
    if (!manualStem.trim()) return setError("手动输入至少需要题干");
    setPhase("saving");
    try {
      await api("/api/v1/mistakes", {
        method: "POST",
        json: {
          subject: manualSubject,
          manual: { stemMd: manualStem },
          ...(manualType ? { questionType: manualType } : {}),
          content: {
            stemMd: manualStem,
            ...(manualAnswer ? { correctAnswer: manualAnswer } : {}),
            ...(manualMyAnswer ? { myAnswer: manualMyAnswer } : {}),
            ...(manualNote ? { note: manualNote } : {}),
          },
        },
      });
      navigate("/mistakes");
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    }
  }

  const savedCount = questions.filter((q) => q.saved).length;

  return (
    <div style={{ maxWidth: "var(--app-content-w)" }}>
      <PageHeader
        icon={IconCloudUpload}
        title="导入录入"
        description="豆包识别作业照片 → 导入 JSON → 逐题核对保存"
        actions={
          <SegmentedControl
            value={mode}
            onChange={(v) => {
              reset();
              setMode(v as Mode);
            }}
            data={[
              { value: "import", label: "豆包 JSON 导入" },
              { value: "manual", label: "手动输入" },
            ]}
          />
        }
      />

      {error && (
        <Alert color="red" mb="md" onClose={() => setError(null)} withCloseButton>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert color="yellow" mb="md" onClose={() => setNotice(null)} withCloseButton>
          {notice}
        </Alert>
      )}

      {mode === "import" && phase === "idle" && (
        <Stack gap="md">
          <Card className="app-panel" withBorder>
            <Stack gap="sm">
              {[
                "复制下方识题模板,发给豆包并附上作业照片",
                "豆包会输出 JSON 数组(只挑做错或未作答的题)",
                "把 JSON 粘贴到下面或上传 .json 文件,导入后逐题核对",
              ].map((step, i) => (
                <Group key={i} gap="sm" wrap="nowrap" align="flex-start">
                  <div className="app-step">{i + 1}</div>
                  <Text size="sm">{step}</Text>
                </Group>
              ))}
            </Stack>
          </Card>
          <Group>
            <Button
              variant="light"
              leftSection={<IconCopy size={16} />}
              onClick={() => {
                void navigator.clipboard.writeText(DOUBAO_TEMPLATE);
                setNotice("豆包识题模板已复制,去豆包粘贴并发送作业照片");
              }}
            >
              复制豆包识题模板
            </Button>
            <Button
              variant="light"
              leftSection={<IconUpload size={16} />}
              onClick={() => fileRef.current?.click()}
            >
              上传 .json 文件
            </Button>
          </Group>
          <Textarea
            label="豆包输出的 JSON 数组"
            description="≤512KB、≤50 题;顶层必须是 JSON 数组,每个元素一道题"
            minRows={10}
            value={jsonText}
            onChange={(e) => setJsonText(e.currentTarget.value)}
            placeholder='[{"question":"…","type":"解答","standard_answer":"…","student_answer":"","subject":"数学","chapter":"","error_raw_note":""}]'
          />
          <Group>
            <Button
              leftSection={<IconCloudUpload size={16} />}
              onClick={() => void doImport(jsonText)}
              disabled={!jsonText.trim()}
            >
              导入
            </Button>
          </Group>
          <input
            ref={(el) => {
              fileRef.current = el;
            }}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void file.text().then((t) => doImport(t));
              e.target.value = "";
            }}
          />
        </Stack>
      )}

      {mode === "import" && phase === "importing" && <Text c="dimmed">导入解析中…</Text>}

      {(phase === "ready" || (phase === "saving" && questions.length > 0)) && (
        <Stack gap="md">
          <Alert color="brand" variant="light">
            共导入 {questions.length} 道题。字段已按豆包输出预填,请逐题核对(尤其是公式);
            全部选填,空白题按“完全不会”处理,可直接保存。
          </Alert>
          <Card className="app-panel" withBorder padding="md">
            <Group justify="space-between" wrap="nowrap">
              <Select
                label="本批学科(可修改)"
                placeholder="选择学科"
                data={Subjects.map((s) => ({ value: s, label: SUBJECT_LABELS[s] }))}
                value={questions[0]?.subject ?? null}
                onChange={(v) => setQuestions((qs) => qs.map((q) => ({ ...q, subject: v })))}
                w={220}
              />
              <Group mt={22}>
                <Button onClick={() => void saveAll()} loading={phase === "saving"} disabled={savedCount === questions.length}>
                  全部保存({questions.length - savedCount} 道)
                </Button>
                <Button variant="light" onClick={reset}>
                  重新导入
                </Button>
              </Group>
            </Group>
          </Card>

          {questions.map((q, i) => (
            <Card
              key={q.draftId}
              withBorder
              opacity={q.saved ? 0.55 : 1}
              styles={{
                root: q.saved ? { borderStyle: "dashed" } : undefined,
              }}
            >
              <Group justify="space-between" mb="xs">
                <Group gap="sm">
                  <ThemeIcon
                    variant="light"
                    size={30}
                    radius="md"
                    color={SUBJECT_COLORS[q.subject ?? ""] ?? "brand"}
                  >
                    <Text size="xs" fw={700}>
                      {q.index}
                    </Text>
                  </ThemeIcon>
                  <Text fw={600}>
                    第 {q.index} 题{q.questionType ? ` · ${q.questionType}` : ""}
                  </Text>
                </Group>
                {q.saved ? (
                  <Badge color="teal">已保存</Badge>
                ) : (
                  <Button size="xs" variant="light" onClick={() => void saveQuestion(q)}>
                    保存此题
                  </Button>
                )}
              </Group>
              <Textarea
                label="题干(含选项)"
                minRows={3}
                value={q.stemMd}
                onChange={(e) => patchQuestion(i, { stemMd: e.currentTarget.value })}
                disabled={q.saved}
              />
              <Group grow mt="xs">
                <TextInput
                  label="标准答案(选填)"
                  value={q.correctAnswer}
                  onChange={(e) => patchQuestion(i, { correctAnswer: e.currentTarget.value })}
                  disabled={q.saved}
                />
                <TextInput
                  label="学生答案(选填,留空=完全不会)"
                  value={q.myAnswer}
                  onChange={(e) => patchQuestion(i, { myAnswer: e.currentTarget.value })}
                  disabled={q.saved}
                />
              </Group>
              <Textarea
                mt="xs"
                label="卷面解析(选填)"
                minRows={2}
                value={q.explanation}
                onChange={(e) => patchQuestion(i, { explanation: e.currentTarget.value })}
                disabled={q.saved}
              />
              <Textarea
                mt="xs"
                label="错误备注(选填,AI 会结合历史错题替你归因)"
                minRows={2}
                value={q.note}
                onChange={(e) => patchQuestion(i, { note: e.currentTarget.value })}
                disabled={q.saved}
              />
              {q.rawJson && (
                <>
                  <Button
                    mt="xs"
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => setRawOpen(rawOpen === i ? null : i)}
                  >
                    {rawOpen === i ? "收起豆包原文" : "查看豆包原文"}
                  </Button>
                  <Collapse in={rawOpen === i}>
                    <Card withBorder bg="gray.0" p="xs">
                      <Text size="xs" style={{ whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
                        {q.rawJson}
                      </Text>
                    </Card>
                  </Collapse>
                </>
              )}
            </Card>
          ))}
        </Stack>
      )}

      {mode === "manual" && (
        <Stack gap="md">
          <Card className="app-panel" withBorder>
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <ThemeIcon variant="light" size={34} radius="md" color="brand">
                <IconPencil size={18} stroke={1.8} />
              </ThemeIcon>
              <Text size="sm" c="dimmed">
                手动输入兜底:豆包不可用时直接粘贴题干文字。
              </Text>
            </Group>
          </Card>
          <Group grow>
            <Select
              label="学科"
              placeholder="选择学科"
              data={Subjects.map((s) => ({ value: s, label: SUBJECT_LABELS[s] }))}
              value={manualSubject}
              onChange={setManualSubject}
            />
            <Select
              label="题型(选填)"
              placeholder="选择题型"
              clearable
              data={["选择", "填空", "解答", "阅读", "其他"].map((t) => ({ value: t, label: t }))}
              value={manualType || null}
              onChange={(v) => setManualType(v ?? "")}
            />
          </Group>
          <Textarea
            label="题干(必填)"
            minRows={5}
            value={manualStem}
            onChange={(e) => setManualStem(e.currentTarget.value)}
          />
          <Group grow>
            <TextInput
              label="标准答案(选填)"
              value={manualAnswer}
              onChange={(e) => setManualAnswer(e.currentTarget.value)}
            />
            <TextInput
              label="我的答案(选填,留空=完全不会)"
              value={manualMyAnswer}
              onChange={(e) => setManualMyAnswer(e.currentTarget.value)}
            />
          </Group>
          <Textarea
            label="错误备注(选填)"
            minRows={2}
            value={manualNote}
            onChange={(e) => setManualNote(e.currentTarget.value)}
          />
          <Group>
            <Button onClick={() => void saveManual()} loading={phase === "saving"}>
              保存错题
            </Button>
          </Group>
        </Stack>
      )}
    </div>
  );
}
