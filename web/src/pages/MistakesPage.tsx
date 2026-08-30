import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card, Group, Loader, Stack, Text, Button, Box, ThemeIcon, SegmentedControl } from "@mantine/core";
import {
  IconChevronRight,
  IconFilterOff,
  IconNotebook,
  IconRefresh,
} from "@tabler/icons-react";
import { api } from "../lib/api";
import { PageHeader } from "../components/PageHeader";
import { EmptyState, StatusBadge, SUBJECT_COLORS, SUBJECT_LABELS } from "../components/ui";

interface MistakeItem {
  id: string;
  subject: string;
  status: string;
  questionType: string | null;
  excerpt: string;
  favorite: boolean;
  createdAt: string;
}

export function MistakesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<MistakeItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const requestedSubject = searchParams.get("subject") ?? "all";
  const subject = ["chinese", "math", "english"].includes(requestedSubject)
    ? requestedSubject
    : "all";
  const conceptId = searchParams.get("conceptId");
  const categoryId = searchParams.get("categoryId");
  const unpracticed = searchParams.get("unpracticed") === "1";
  const weaknessName = searchParams.get("weaknessName")?.trim() || "该薄弱知识点";
  const hasWeaknessFilter = Boolean(conceptId || categoryId);

  const load = useCallback(async () => {
    try {
      setError(null);
      const query = new URLSearchParams({ limit: "100" });
      if (subject !== "all") query.set("subject", subject);
      if (conceptId) query.set("conceptId", conceptId);
      if (categoryId) query.set("categoryId", categoryId);
      if (unpracticed) query.set("unpracticed", "1");
      const res = await api<{ items: MistakeItem[]; total: number }>(`/api/v1/mistakes?${query}`);
      setItems(res.items);
      setTotal(res.total);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [categoryId, conceptId, subject, unpracticed]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  const subjectLabel = subject === "all" ? "全部学科" : SUBJECT_LABELS[subject] ?? subject;
  const changeSubject = (nextSubject: string) => {
    const next = new URLSearchParams(searchParams);
    if (nextSubject === "all") next.delete("subject");
    else next.set("subject", nextSubject);
    // 学科改变后原知识点 ID 已不适用,回到普通分科列表。
    for (const key of ["conceptId", "categoryId", "unpracticed", "weaknessName"]) next.delete(key);
    setSearchParams(next);
  };
  const clearWeaknessFilter = () => {
    const next = new URLSearchParams(searchParams);
    for (const key of ["conceptId", "categoryId", "unpracticed", "weaknessName"]) next.delete(key);
    setSearchParams(next);
  };

  return (
    <div style={{ maxWidth: "var(--app-content-w)" }}>
      <PageHeader
        icon={IconNotebook}
        title="错题库"
        description={items
          ? `${subjectLabel}${hasWeaknessFilter ? ` · ${weaknessName}${unpracticed ? "待练习" : "相关"}` : ""} · 共 ${total} 道错题`
          : `${subjectLabel}错题`}
        actions={
          <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={() => void load()}>
            刷新
          </Button>
        }
      />

      <SegmentedControl
        mb="md"
        value={subject}
        onChange={changeSubject}
        data={[
          { value: "all", label: "全部" },
          { value: "chinese", label: "语文" },
          { value: "math", label: "数学" },
          { value: "english", label: "英语" },
        ]}
        fullWidth
        aria-label="按学科筛选错题"
      />

      {hasWeaknessFilter && (
        <Card className="app-panel" padding="sm" withBorder mb="md">
          <Group justify="space-between" wrap="nowrap">
            <div>
              <Text size="sm" fw={700}>
                {unpracticed ? "待练习错题" : "知识点相关错题"} · {weaknessName}
              </Text>
              <Text size="xs" c="dimmed">
                {unpracticed
                  ? "仅显示从未提交过错题复习作答的未归档题目"
                  : "仅显示与该知识点关联的题目"}
              </Text>
            </div>
            <Button
              variant="subtle"
              color="gray"
              size="xs"
              leftSection={<IconFilterOff size={15} />}
              onClick={clearWeaknessFilter}
            >
              清除筛选
            </Button>
          </Group>
        </Card>
      )}

      {error && (
        <Text c="red" size="sm">
          {error}
        </Text>
      )}
      {items === null && !error && <Loader size="sm" />}

      {items !== null && items.length === 0 && (
        <EmptyState
          icon={IconNotebook}
          title={hasWeaknessFilter
            ? `${weaknessName}暂无${unpracticed ? "待练习" : "相关"}错题`
            : subject === "all" ? "还没有错题" : `还没有${subjectLabel}错题`}
          hint={hasWeaknessFilter
            ? unpracticed ? "该知识点关联的错题都已经练习过。" : "可以清除筛选查看其他错题。"
            : subject === "all"
            ? "去「导入录入」把豆包识别的 JSON 导入,或手动补录第一道错题。"
            : "可以切换到其他学科,或去「导入录入」补录错题。"}
        />
      )}

      {items !== null && items.length > 0 && (
        <Stack gap="sm">
          {items.map((m) => {
            const color = SUBJECT_COLORS[m.subject] ?? "gray";
            return (
              <Link key={m.id} to={`/mistakes/${m.id}`} style={{ textDecoration: "none" }}>
                <Card className="app-panel app-card-hover" padding="md" withBorder>
                  <Group wrap="nowrap" gap="md">
                    <ThemeIcon
                      variant="light"
                      size={38}
                      radius="md"
                      color={color}
                      style={{ flexShrink: 0 }}
                    >
                      <Text size="sm" fw={700}>
                        {(SUBJECT_LABELS[m.subject] ?? m.subject).slice(0, 1)}
                      </Text>
                    </ThemeIcon>
                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <Text lineClamp={2} size="sm">{m.excerpt}</Text>
                      <Group gap="xs" mt={6}>
                        <Text size="xs" c="dimmed">
                          {SUBJECT_LABELS[m.subject] ?? m.subject}
                          {m.questionType ? ` · ${m.questionType}` : ""}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {new Date(m.createdAt).toLocaleString("zh-CN", {
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </Text>
                      </Group>
                    </Box>
                    <Group gap="sm" wrap="nowrap" style={{ flexShrink: 0 }}>
                      <StatusBadge status={m.status} />
                      <IconChevronRight size={16} stroke={1.8} style={{ color: "var(--mantine-color-dimmed)" }} />
                    </Group>
                  </Group>
                </Card>
              </Link>
            );
          })}
        </Stack>
      )}
    </div>
  );
}
