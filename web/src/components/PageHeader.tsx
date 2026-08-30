import type { ReactNode } from "react";
import { Group, Stack, Text, Title } from "@mantine/core";
import type { IconComponent } from "./ui";

/** 统一页头:左侧渐变图标块 + 标题 + 描述,右侧操作区(样式见 app.css .app-page-*) */
export function PageHeader({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon?: IconComponent;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-start" mb="lg" wrap="nowrap">
      <Group align="center" gap="md" wrap="nowrap">
        {Icon && (
          <div className="app-page-icon">
            <Icon size={24} stroke={1.8} />
          </div>
        )}
        <Stack gap={2}>
          <Title order={3} mb={0} className="app-page-title">
            {title}
          </Title>
          {description && (
            <Text size="sm" c="dimmed">
              {description}
            </Text>
          )}
        </Stack>
      </Group>
      {actions && <Group gap="sm">{actions}</Group>}
    </Group>
  );
}
