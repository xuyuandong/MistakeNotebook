# llm_prompts/ — 提示词唯一真源

所有提示词文本以 markdown 文件集中在本目录管理(包括豆包侧的识题模板),代码只保留组装逻辑。改提示词直接改这里的文件,改完重启服务生效。

## 文件格式

每个文件 = frontmatter(`id` + `version`)+ 正文(system 提示词全文):

```markdown
---
id: analyze_mistake_math
version: analyze@6
---
你是学生错题本的…
```

- `id` 必须与文件名一致;`analyze_mistake` 与 `summarize_learner` 按学科拆分为 3 份,id 带学科后缀(`analyze_mistake_math` / `analyze_mistake_chinese` / `analyze_mistake_english`,`summarize_learner_*` 同理);其余服务端任务提示词的 `id` 对应 `TaskType`(`generate_questions` / `verify_question` / `judge_answer` / `select_topics` / `consolidate_concepts`)。`doubao_extract.md` 是豆包识题模板,服务端不加载。
- `version` 会记录到 `model_runs.prompt_version`,用于回归对比。**修改正文语义必须递增版本号**。同一任务按学科拆分的三份文件共用同一版本号(如三份 `analyze_mistake_*` 都是 `analyze@6`),保证跨学科可比;改学科专属要点只递增该任务版本即可,但三份文件要同步检查通用规则是否仍然一致。
- 正文中的 `{{TOKEN}}` 占位符在加载时由代码注入当前枚举值(如 `{{ERROR_TYPE_LIST}}` = 错误类型枚举列表),避免枚举改动后提示词过期;加载时发现未识别的 `{{...}}` 会直接启动失败。
- 正文即发送给模型的 system 全文,不要加代码块围栏或额外说明。

## 加载方式

服务启动时一次性读取并替换占位符;文件缺失、frontmatter 非法、版本号缺失、存在未识别占位符都会让启动直接失败(fail-fast)。**修改文件后需重启服务**;测试可用临时目录注入。

## 豆包识题模板(`doubao_extract.md`)

- 本文件是豆包识题模板的唯一真源:录入页「复制豆包识题模板」按钮在构建时从这里内嵌(`?raw` 导入),LLD 附录 A 只是说明与维护规则,不再保存全文。
- frontmatter 之后的正文就是要粘贴给豆包的全文(可直接复制整个正文,或用录入页按钮)。
- **豆包 Skill 成品**:`doubao_skill/SKILL.md` 按标准 Agent Skills 协议生成(frontmatter 只有 `name: doubao-extract` 和 `description` 触发说明),正文与本文件逐字一致,直接导入豆包 App 即可。它是本文件的派生物:改模板后必须重新同步该文件正文,不要只改 SKILL.md。
- 同步到豆包 Skill:导入 `doubao_skill/SKILL.md` 或把正文全文粘贴为豆包自定义提示词/Skill。**豆包侧只是部署副本,不要在豆包侧直接改措辞**;要改就改本文件并递增版本号。
- 模板语义变更需递增 `doubao-template@N` 并与 `packages/shared/src/doubao.ts` 的导入契约联动(字段增减必须同步 Schema 与导入校验)。
