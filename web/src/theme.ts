import { createTheme, type MantineColorsTuple } from "@mantine/core";

/** 品牌色:靛蓝偏紫,区别于 Mantine 默认蓝;学科色在组件层单独映射 */
const brand: MantineColorsTuple = [
  "#eef0ff",
  "#e0e3fd",
  "#c5cafb",
  "#a8b0f9",
  "#8d97f7",
  "#7d87f5",
  "#757ef4",
  "#6167d4",
  "#535bbc",
  "#484fa5",
];

export const theme = createTheme({
  primaryColor: "brand",
  primaryShade: 6,
  colors: { brand },
  defaultRadius: "md",
  radius: { xs: "6px", sm: "10px", md: "14px", lg: "18px", xl: "24px" },
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif',
  fontFamilyMonospace:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  headings: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif',
    fontWeight: "700",
  },
  components: {
    Button: {
      defaultProps: { radius: "sm", fw: 600 },
    },
    TextInput: { defaultProps: { radius: "sm" } },
    Textarea: { defaultProps: { radius: "sm" } },
    Select: { defaultProps: { radius: "sm" } },
    NumberInput: { defaultProps: { radius: "sm" } },
    PasswordInput: { defaultProps: { radius: "sm" } },
    Badge: {
      defaultProps: { radius: "sm", fw: 600, variant: "light" },
    },
    Alert: {
      defaultProps: { radius: "md" },
    },
    Card: {
      defaultProps: { radius: "md", padding: "lg" },
    },
    Modal: {
      defaultProps: { radius: "md" },
    },
    Tooltip: {
      defaultProps: { radius: "sm", withArrow: true },
    },
  },
});
