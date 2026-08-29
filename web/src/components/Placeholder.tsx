import { Center, Text } from "@mantine/core";

export function Placeholder({ title }: { title: string }) {
  return (
    <Center mih={300}>
      <Text c="dimmed">{title} — 阶段 1/2 实现,详见 LLD.md</Text>
    </Center>
  );
}
