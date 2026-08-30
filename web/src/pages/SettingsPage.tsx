import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  ThemeIcon,
} from "@mantine/core";
import {
  IconSettings,
  IconSchool,
  IconCalendarStats,
  IconShieldLock,
  IconDownload,
  IconTrash,
} from "@tabler/icons-react";
import { DEFAULT_REVIEW_INTERVALS, Subjects } from "@mistake-book/shared";
import { api } from "../lib/api";
import { PageHeader } from "../components/PageHeader";

interface Me {
  userId: string;
  displayName: string;
  currentGrade: string | null;
  reviewIntervals: Record<string, number[]> | null;
  revivalEnabled: boolean;
}

const GRADES = [
  "六年级",
  "初一", "初二", "初三",
  "高一", "高二", "高三",
].map((g) => ({ value: g, label: g }));

const SUBJECT_LABELS: Record<string, string> = {
  chinese: "语文",
  math: "数学",
  english: "英语",
};

/** 设置(PRD 4/6.3):当前年级、分科复习间隔、数据导出、数据清空(免登录单机) */
export function SettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [grade, setGrade] = useState<string | null>(null);
  const [intervals, setIntervals] = useState<Record<string, string>>({});
  const [revival, setRevival] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [unlock, setUnlock] = useState("");
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);

  const load = useCallback(async () => {
    try {
      const m = await api<Me>("/api/v1/me");
      setMe(m);
      setGrade(m.currentGrade);
      setRevival(m.revivalEnabled);
      setIntervals(
        Object.fromEntries(
          Subjects.map((s) => [
            s,
            (m.reviewIntervals?.[s] ?? DEFAULT_REVIEW_INTERVALS[s]).join(", "),
          ]),
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function parseIntervals(): Record<string, number[]> | string {
    const out: Record<string, number[]> = {};
    for (const s of Subjects) {
      const parts = (intervals[s] ?? "")
        .split(/[,，\s]+/)
        .filter(Boolean)
        .map(Number);
      if (parts.length === 0 || parts.some((n) => !Number.isInteger(n) || n < 1 || n > 365)) {
        return `${SUBJECT_LABELS[s]}的间隔需为 1~365 的整数天数`;
      }
      if (parts.some((n, i) => i > 0 && n <= parts[i - 1])) {
        return `${SUBJECT_LABELS[s]}的间隔需逐档递增`;
      }
      out[s] = parts;
    }
    return out;
  }

  async function saveSettings() {
    const parsed = parseIntervals();
    if (typeof parsed === "string") {
      setError(parsed);
      return;
    }
    setError(null);
    try {
      await api("/api/v1/me", {
        method: "PATCH",
        json: { currentGrade: grade, reviewIntervals: parsed, revivalEnabled: revival },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function download(path: string, filename: string) {
    const res = await fetch(path);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 危险区:输入 .env 中配置的 APP_AUTH_TOKEN 解锁后才真正清空(PRD 5.5);
   *  未配置口令时服务端锁定,这里会显示服务端返回的提示。 */
  async function purgeAll() {
    setPurging(true);
    setPurgeError(null);
    try {
      await api("/api/v1/data/purge", { method: "POST", json: { unlock } });
      window.location.href = "/";
    } catch (e) {
      setPurgeError((e as Error).message);
      setPurging(false);
    }
  }

  if (error) return <Text c="red">{error}</Text>;
  if (!me) return <Loader size="sm" />;

  const sectionTitle = (IconCmp: typeof IconSchool, color: string, title: string) => (
    <Group gap="sm" mb="sm" wrap="nowrap">
      <ThemeIcon variant="light" size={32} radius="md" color={color}>
        <IconCmp size={17} stroke={1.8} />
      </ThemeIcon>
      <Text fw={700} fz={15}>
        {title}
      </Text>
    </Group>
  );

  return (
    <Stack gap="md" maw={680}>
      <PageHeader icon={IconSettings} title="设置" description="年级、复习间隔与数据管理" />

      <Card className="app-panel" withBorder>
        {sectionTitle(IconSchool, "brand", "当前年级")}
        <Text size="sm" c="dimmed" mb="sm">
          只影响出题难度、报告语境和历史证据权重;不会把其他年级的错题排除在复习和分析之外。
        </Text>
        <Select data={GRADES} value={grade} onChange={setGrade} placeholder="未设置" clearable w={160} />
      </Card>

      <Card className="app-panel" withBorder>
        {sectionTitle(IconCalendarStats, "teal", "复习间隔(天,按学科)")}
        <Text size="sm" c="dimmed" mb="sm">
          答对后隔几天再复习,逐档递进;答错不倒退,留在原档。数学重思考轻记忆,默认更疏(1→10→30);
          语文/英语字词记忆用较密阶梯。改完点下方「保存设置」,对之后完成的复习生效。
        </Text>
        <Stack gap="xs">
          {Subjects.map((s) => (
            <TextInput
              key={s}
              label={SUBJECT_LABELS[s]}
              value={intervals[s] ?? ""}
              onChange={(e) => setIntervals((prev) => ({ ...prev, [s]: e.currentTarget.value }))}
              placeholder={DEFAULT_REVIEW_INTERVALS[s].join(", ")}
              w={280}
            />
          ))}
        </Stack>
        <Switch
          mt="md"
          label="概念重逢复活(默认关闭)"
          description="开启后,新错题被 AI 分析归入某知识概念时,该概念下已毕业的旧错题会按第 2 档间隔(数学约 10 天、语文/英语约 3 天)重新进入复习队列;复活后答对一次即再次毕业。关闭时不影响毕业机制本身。"
          checked={revival}
          onChange={(e) => setRevival(e.currentTarget.checked)}
        />
        <Group mt="md">
          <Button onClick={() => void saveSettings()}>保存设置</Button>
          {saved && (
            <Text c="teal" size="sm" fw={600}>
              ✓ 已保存
            </Text>
          )}
        </Group>
      </Card>

      <Card className="app-panel" withBorder>
        {sectionTitle(IconShieldLock, "grape", "AI 与隐私")}
        <Text size="sm" c="dimmed">
          作业照片只进入豆包(由你自行操作);题目文本会发送到你配置的模型服务商(DeepSeek/GLM/Kimi)
          用于分析、出题和判分。识别结果与导入原文保存在本地 SQLite;日志不记录题目全文与答案;
          你的数据不会用于训练模型。
        </Text>
      </Card>

      <Card className="app-panel" withBorder>
        {sectionTitle(IconDownload, "indigo", "数据导出")}
        <Group>
          <Button variant="light" leftSection={<IconDownload size={16} />} onClick={() => void download("/api/v1/export/json", "mistakes.json")}>
            导出 JSON
          </Button>
          <Button variant="light" leftSection={<IconDownload size={16} />} onClick={() => void download("/api/v1/export/markdown", "mistakes.md")}>
            导出 Markdown
          </Button>
        </Group>
      </Card>

      <Card
        withBorder
        styles={{
          root: {
            borderColor: "var(--mantine-color-red-3)",
          },
        }}
      >
        {sectionTitle(IconTrash, "red", "危险区")}
        <Button color="red" variant="light" leftSection={<IconTrash size={16} />} onClick={() => { setPurgeOpen(true); setPurgeError(null); setUnlock(""); }}>
          永久删除全部数据
        </Button>
        <Text size="xs" c="dimmed" mt="xs">
          需输入 .env 中 APP_AUTH_TOKEN 配置的解锁口令;未配置时清空功能锁定。
        </Text>
      </Card>

      <Modal
        opened={purgeOpen}
        onClose={() => setPurgeOpen(false)}
        title="解锁危险操作"
        centered
      >
        <Stack gap="sm">
          <Text size="sm">
            将永久删除全部错题、作答、分析、导入存档(此操作不可恢复)。输入解锁口令确认。
          </Text>
          <PasswordInput
            label="请输入解锁口令(APP_AUTH_TOKEN)"
            value={unlock}
            onChange={(e) => setUnlock(e.currentTarget.value)}
            error={purgeError}
            data-autofocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && unlock) void purgeAll();
            }}
          />
          <Group justify="flex-end">
            <Button variant="light" onClick={() => setPurgeOpen(false)}>
              取消
            </Button>
            <Button color="red" loading={purging} disabled={!unlock} onClick={() => void purgeAll()}>
              确认清空
            </Button>
          </Group>
        </Stack>
      </Modal>

      {error && <Alert color="red">{error}</Alert>}
    </Stack>
  );
}
