import type { ComponentType, CSSProperties, ReactNode } from "react";
import { Badge, Card, Group, Text } from "@mantine/core";

export type IconComponent = ComponentType<{
  size?: number | string;
  stroke?: number | string;
  style?: CSSProperties;
}>;

export const SUBJECT_LABELS: Record<string, string> = {
  chinese: "语文",
  math: "数学",
  english: "英语",
};

/** 学科视觉色:语文=珊瑚红,数学=靛蓝,英语=青绿(全应用统一) */
export const SUBJECT_COLORS: Record<string, string> = {
  chinese: "red",
  math: "brand",
  english: "teal",
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  waiting_input: { label: "待补充", color: "yellow" },
  pending_analysis: { label: "待分析", color: "blue" },
  analyzed: { label: "已分析", color: "green" },
};

export function statusInfo(status: string) {
  return STATUS_LABELS[status] ?? { label: status, color: "gray" };
}

export function SubjectBadge({ subject }: { subject: string }) {
  return (
    <Badge color={SUBJECT_COLORS[subject] ?? "gray"} size="lg">
      {SUBJECT_LABELS[subject] ?? subject}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const info = statusInfo(status);
  return <Badge color={info.color}>{info.label}</Badge>;
}

/** 统计卡片:大数字 + 标签 + 图标 */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  color = "brand",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: IconComponent;
  color?: string;
}) {
  return (
    <Card className="app-panel" padding="md" withBorder>
      <Group justify="space-between" wrap="nowrap" mb={6}>
        <Text size="sm" c="dimmed" fw={500}>
          {label}
        </Text>
        {Icon && <Icon size={18} stroke={1.8} style={{ color: `var(--mantine-color-${color}-6)` }} />}
      </Group>
      <div className="app-stat-value" style={{ color: `var(--mantine-color-${color}-7)` }}>
        {value}
      </div>
      {hint && (
        <Text size="xs" c="dimmed" mt={4}>
          {hint}
        </Text>
      )}
    </Card>
  );
}

/** 空状态:虚线框 + 图标 + 提示 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon?: IconComponent;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="app-empty">
      {Icon && <Icon size={36} stroke={1.5} style={{ color: "var(--mantine-color-dimmed)" }} />}
      <Text fw={600}>{title}</Text>
      {hint && (
        <Text size="sm" c="dimmed" maw={420}>
          {hint}
        </Text>
      )}
      {action}
    </div>
  );
}

/** 单行横向条形(错误类型分布等),纯 CSS,无图表依赖 */
export function CountBar({
  label,
  count,
  max,
  color = "brand",
}: {
  label: string;
  count: number;
  max: number;
  color?: string;
}) {
  const pct = max > 0 ? Math.max((count / max) * 100, 4) : 0;
  return (
    <div>
      <Group justify="space-between" mb={4}>
        <Text size="sm">{label}</Text>
        <Text size="sm" fw={600} style={{ fontVariantNumeric: "tabular-nums" }}>
          {count}
        </Text>
      </Group>
      <div className="app-bar-track">
        <div
          className="app-bar-fill"
          style={{ width: `${pct}%`, background: `var(--mantine-color-${color}-6)` }}
        />
      </div>
    </div>
  );
}
