import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, Group, Loader, Stack, Text, Button, Box, ThemeIcon } from "@mantine/core";
import {
  IconChevronRight,
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
  const [items, setItems] = useState<MistakeItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ items: MistakeItem[] }>("/api/v1/mistakes?limit=50");
      setItems(res.items);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ maxWidth: "var(--app-content-w)" }}>
      <PageHeader
        icon={IconNotebook}
        title="错题库"
        description={items ? `共 ${items.length} 道错题` : "所有录入的错题"}
        actions={
          <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={() => void load()}>
            刷新
          </Button>
        }
      />

      {error && (
        <Text c="red" size="sm">
          {error}
        </Text>
      )}
      {items === null && !error && <Loader size="sm" />}

      {items !== null && items.length === 0 && (
        <EmptyState
          icon={IconNotebook}
          title="还没有错题"
          hint="去「导入录入」把豆包识别的 JSON 导入,或手动补录第一道错题。"
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
