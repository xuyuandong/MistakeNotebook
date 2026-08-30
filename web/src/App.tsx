import type { ReactNode } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import {
  AppShell,
  Box,
  NavLink,
  SegmentedControl,
  Text,
  Tooltip,
  useMantineColorScheme,
} from "@mantine/core";
import {
  IconChartPie,
  IconFileImport,
  IconMoon,
  IconNotebook,
  IconSettings,
  IconSun,
  IconSunMoon,
  IconTargetArrow,
  IconCalendarCheck,
  IconBook2,
} from "@tabler/icons-react";
import { CapturePage } from "./pages/CapturePage";
import { MistakesPage } from "./pages/MistakesPage";
import { MistakeDetailPage } from "./pages/MistakeDetailPage";
import { ReviewPage } from "./pages/ReviewPage";
import { PracticePage } from "./pages/PracticePage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { SettingsPage } from "./pages/SettingsPage";

const NAV = [
  { to: "/", label: "导入录入", icon: IconFileImport },
  { to: "/mistakes", label: "错题库", icon: IconNotebook },
  { to: "/review", label: "今日复习", icon: IconCalendarCheck },
  { to: "/practice", label: "智能练习", icon: IconTargetArrow },
  { to: "/analytics", label: "学习分析", icon: IconChartPie },
  { to: "/settings", label: "设置", icon: IconSettings },
];

function Brand() {
  return (
    <div className="app-brand">
      <div className="app-brand-mark">
        <IconBook2 size={22} stroke={1.8} />
      </div>
      <Box>
        <Text fw={800} fz={17} lh={1.2} className="app-brand-title">
          错题本
        </Text>
        <Text size="xs" c="dimmed">
          录入 · 分析 · 复习 · 掌握
        </Text>
      </Box>
    </div>
  );
}

function ColorSchemeToggle() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();

  return (
    <Tooltip label="跟随系统 / 浅色 / 深色">
      <SegmentedControl
        fullWidth
        size="xs"
        radius="sm"
        value={colorScheme}
        onChange={(v) => setColorScheme(v as "auto" | "light" | "dark")}
        data={[
          { value: "auto", label: <IconSunMoon size={14} stroke={1.8} /> },
          { value: "light", label: <IconSun size={14} stroke={1.8} /> },
          { value: "dark", label: <IconMoon size={14} stroke={1.8} /> },
        ]}
      />
    </Tooltip>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <AppShell navbar={{ width: 236, breakpoint: "sm" }} padding="xl">
      <AppShell.Navbar className="app-navbar" p={0}>
        <Brand />
        <div className="app-nav">
          {NAV.map((item) => {
            const active =
              item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to);
            return (
              <NavLink
                key={item.to}
                label={item.label}
                leftSection={<item.icon size={19} stroke={1.8} />}
                to={item.to}
                component={Link}
                active={active}
                color="brand"
              />
            );
          })}
        </div>
        <div className="app-navbar-footer">
          <ColorSchemeToggle />
          <Text size="xs" c="dimmed" mt="sm" ta="center">
            单机家庭版 · 数据仅存本机
          </Text>
        </div>
      </AppShell.Navbar>
      <AppShell.Main className="app-main">{children}</AppShell.Main>
    </AppShell>
  );
}

/** 免登录(单机家庭使用):打开即用,无登录页与鉴权跳转 */
export function App() {
  return (
    <BrowserRouter>
      <Shell>
        <Routes>
          <Route path="/" element={<CapturePage />} />
          <Route path="/mistakes" element={<MistakesPage />} />
          <Route path="/mistakes/:id" element={<MistakeDetailPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/practice" element={<PracticePage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  );
}
