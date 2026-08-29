# 学生错题本:产品与架构设计

本目录包含面向单人业余时间开发与维护的设计:

- [产品需求文档(PRD)](./docs/PRD.md)
- [High-level Design(HLD)](./docs/HLD.md)
- [Low-level Design(LLD)](./docs/LLD.md) — DDL 级数据模型、API 契约、模块与任务流程
- [AGENTS.md](./AGENTS.md) — 编码 Agent 工程纪律

核心产品原则:录入必须快、AI 结果必须可修改、学习闭环优先于功能数量、先做模块化单体而不是微服务。

## 仓库结构

```text
server/           # Fastify + TypeScript + Drizzle + SQLite(WAL) 模块化单体
web/              # React + Vite + Mantine + PWA(登录页与页面骨架已就位)
packages/shared/  # 前后端共用 Zod 契约(REST DTO + AI 输出/豆包导入 Schema)
config/           # models.yaml:text_model 槽位(识题已外移至豆包,见 docs)
llm_prompts/      # 全部提示词唯一真源(含豆包识题模板;启动时加载,详见其 README)
evals/            # AI 黄金评测集(阶段 0 起填充)
data/             # 运行时数据(gitignore):app.db 与 AI 原始输出
```

## 快速开始

```bash
pnpm install
cp .env.example .env      # 填入 text_model 密钥(不填则降级 mock provider,仅限开发)
pnpm dev                  # 并行启动 server(:8787)与 web(:5173)
```

打开 http://localhost:5173 即用(免登录,单机家庭使用;不要暴露到公网)。

常用脚本(根目录):

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 并行启动前后端 dev server |
| `pnpm test` | 全部 Vitest 测试(迁移/配置/任务幂等/Schema) |
| `pnpm typecheck` | 全仓 TypeScript 检查 |
| `pnpm build` | 构建 web 静态资源(含 PWA service worker) |

## 当前状态(v0.3 已完成开发,接真实 DeepSeek)

> 2026-08-29 设计与实现(两轮):识题改为“豆包人工中转 + JSON 导入”(契约 `doubao-import@2`,模板见 `docs/LLD.md` 附录 A);**免登录**(单机家庭使用);智能出题**可选学科**并带“出旧题/编新题”开关(LLM 先做选题分析);主观题 **LLM 判分**(可申诉/自判)入库并更新画像;AI **主动归因**(技术性 + 学习方法/习惯)与三层建议(技术性/方法性/认知性)。已全部实现,迁移记录见 `docs/LLD.md` §12。

- 已实现:豆包 JSON 粘贴/文件导入 → 逐题核对(含豆包原文对照)→ 错题 CRUD/FTS 搜索 → 批量 AI 主动归因(analyze@4:错误类型/知识概念/学习方法画像/三层建议/学科总结)→ 掌握度(含部分正确档)与复习调度 → 今日复习(本地判定/AI 判分/改判)→ 智能出题(学科 + past/new + 选题理由 + 四道校验)→ 学习分析 Dashboard(薄弱点/错误类型/学习方法画像)→ 数据导出/一键清空 → 每日自动检查。
- 提示词统一在 `llm_prompts/`(analyze@4/generate@2/verify@1/judge@1/select@1/summarize@1,含豆包识题模板与豆包 Skill 成品),修改必须递增 frontmatter 版本号并重启服务。
- 模型:`config/models.yaml` 仅 `text_model` 槽位(默认 DeepSeek,openai 协议),普通文本模型即可;密钥在 `.env`,改后重启生效。识题在豆包侧,系统不接视觉模型。
- 测试:shared 22 + server 79 全部通过;`pnpm dev` 打开 http://localhost:5173 即用(免登录)。人工验收清单见 [docs/MANUAL-TEST.md](./docs/MANUAL-TEST.md)。
- 待办:`evals/import/` 黄金评测集填充、Playwright E2E、备份脚本(`scripts/backup.sh`)。

## 约束提示

- 不要把密钥、生产数据库(`data/`)、真实学生数据提交进仓库。
- 模型配置改动后需重启服务;不做热切换(AGENTS §4)。

## 许可证

[MIT](./LICENSE) © 2026 xuyuandong
