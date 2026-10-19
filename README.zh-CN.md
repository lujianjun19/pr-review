# pr-review

一个面向 GitHub Copilot、VS Code Agent、Copilot CLI、Claude、pi 等 Agent Skills 宿主的 Azure DevOps Pull Request 审查技能。

本项目把**可确定的审查工作下沉到代码**，让 Agent 只负责语义判断：

- 固定 Azure DevOps PR iteration 和 commit SHA，并在可用时保存 policy/PR-status 信号
- 识别、筛选、排序和分批变更文件；多目标重复生成文件只审一个代表
- 生成带真实源文件行号的 diff payload，并附上变更意图（标题、描述、关联 Work Item；分支审查用 commit message）
- 从 **base revision** 读取规则和仓库指引（`AGENTS.md`、`CLAUDE.md`、`REVIEW.md`、Copilot instructions），PR 无法改写自己的审查规则
- 给出建议的风险档位（0/1/2 名人工审批人），仅作建议
- 识别早先 prr 发布的 thread，带上作者回复，并检查其证据在新 revision 是否仍存在
- 从 source revision 验证 finding 的证据；阻塞级 finding 必须经过独立反驳性复核（challenge）
- 按路径阈值和 Low 上限抑制 finding；区分本次引入与既有（pre-existing）问题
- 检查文件覆盖率、去重候选和评论位置，生成 `result.json`（计数和建议 verdict）
- 生成 Markdown、JSON、SARIF
- 在用户明确授权后幂等发布 inline comments（跨 iteration 也不重复），并可关闭早先 prr 的 thread

## 支持的审查范围

```text
prr prepare <pr-url|pr-id>       Azure DevOps Pull Request
prr prepare --branch <base>     当前分支与 base 的 merge-base
prr prepare --working-tree      当前未提交和未跟踪变更
```

只有 Azure DevOps PR scope 支持发布评论；branch 和 working-tree scope 只生成审查报告。

## 要求

- Node.js 18+
- Git
- Azure DevOps 凭据：优先使用 `AZURE_DEVOPS_EXT_PAT`，否则使用 `az login`
- 在被审查仓库的 clone 内运行

运行时不依赖 `node_modules`。已构建的 `bin/prr.mjs` 是可直接分发的单文件入口。

## 使用

```bash
node bin/prr.mjs prepare <pr-url-or-id>
node bin/prr.mjs prepare <pr-url-or-id> --depth deep    # quick | standard（默认）| deep
node bin/prr.mjs prepare --branch main
node bin/prr.mjs prepare --working-tree
node bin/prr.mjs context --path src/example.ts --start 40
node bin/prr.mjs grep createOrder --files-only
node bin/prr.mjs rules check src/example.ts
node bin/prr.mjs note --file findings.json
node bin/prr.mjs note --batch 2 --all-clean --except src/app.ts=findings
node bin/prr.mjs exec --record --timeout 300 -- npm test
node bin/prr.mjs finalize
node bin/prr.mjs finalize --format sarif > findings.sarif
node bin/prr.mjs finalize --format result
node bin/prr.mjs post --dry-run
node bin/prr.mjs post --resolve 1234 --resolution fixed --dry-run
node bin/prr.mjs post --retract <finding-id> --dry-run
node bin/prr.mjs post --update-summary --summary corrected.md --dry-run
```

审查状态默认保存在用户缓存目录，不写入被审仓库。后续命令只会自动选择当前 git 仓库对应的 run；
在仓库外运行时必须显式传入 `--dir`，不会回退到其他仓库最近的 run。Azure DevOps policy/status
证据写入 `policies.json`/`builds.json`，验证命令写入 `validations.jsonl`：

```text
${XDG_CACHE_HOME:-~/.cache}/pr-review/<run-key>/
```

## 安装为 Agent Skill

项目级位置：

```text
.github/skills/pr-review/
.claude/skills/pr-review/
.agents/skills/pr-review/
```

个人级位置：

```text
~/.copilot/skills/pr-review/
~/.agents/skills/pr-review/
~/.pi/agent/skills/pr-review/
```

将整个仓库目录复制或链接到目标 skill 目录即可。

## 项目规则

可以在被审仓库中使用 `.pr-review/rules.json` 配置路径规则，也可以通过 `--rule` 指定规则文件。
规则优先级为：显式规则文件、项目规则、用户规则、内置规则。

```json
{
  "rules": [
    {
      "path": "src/api/**",
      "rule": "Every endpoint validates its input at the boundary."
    }
  ],
  "exclude": ["**/__fixtures__/**"]
}
```

可选字段：规则条目上的 `minSeverity` 会抑制匹配路径上低于该级别的 finding（条目可以只写阈值）；
`maxLowFindings` 限制一次审查发布的 Low 数量；`alwaysHuman` 列出总是至少需要一名人工审批的路径；
`riskPaths` 提高项目认为关键的目录的审查优先级。本工具与具体业务无关：内置风险信号只包含技术类别（安全、
契约、并发、状态），任何业务相关的优先级都由被审项目在自己的规则文件中声明。同一 label 的多个条目只计一次；
glob 区分大小写。

```json
{
  "rules": [{ "path": "scripts/**", "minSeverity": "high" }],
  "maxLowFindings": 5,
  "alwaysHuman": ["infra/**", "**/auth/**"],
  "riskPaths": [
    { "path": "src/core/**", "weight": 3, "label": "core-logic" }
  ]
}
```

审查时项目规则从 base revision 读取：对规则文件的修改要合并后才生效；如果被审变更修改了规则或指引文件，
`prepare` 会给出警告。`prr rules check <path>` 默认读工作区，`--rev <ref>` 读指定 revision。

## 审查深度

| 深度 | 批次 | 先做风险计划 | 需要独立复核的 finding | Low |
|---|---|---|---|---|
| `quick` | 大 | 仅超大变更 | 无 | 抑制 |
| `standard` | 默认 | ≥ 50 行变更 | Critical、High、Medium | 报告 |
| `deep` | 小 | 总是 | 全部 | 报告 |

## Finding、复核和既有问题

Finding 可以带 `rationale`（为什么报）和 `preExisting: true`（不是本次变更引入）。独立复核、重复标记和
严重级别修正都按 id 记录：

```json
{
  "challenges": [{ "id": "<id>", "outcome": "confirmed", "detail": "检查了什么", "by": "subagent" }],
  "duplicates": [{ "id": "<id>", "thread": 1234 }],
  "reclassify": [{ "id": "<id>", "severity": "medium" }]
}
```

`refuted` 会立即撤回该 finding，`uncertain` 会在 finalize 时转入 Open Questions。既有问题单独成节，
不影响 verdict，只有加 `--include-pre-existing` 才会发布。每条发布的评论末尾带 `prr finding <id>`，
后续审查据此识别自己的 thread；发布的 Summary 末尾带生成的 `prr result:` 行，便于流水线解析。

## 纠错和撤回

逐字证据验证只能证明代码存在，不能证明 reviewer 对代码的判断正确。Finding 被确认错误时：

1. 用 `prr note --file retract.json` 把它标记为终态，其中 JSON 为
   `{ "retract": ["finding-id"] }`。
2. 在用户明确批准后，执行 `prr post --retract <finding-id>`；工具会幂等回复更正并关闭已发布 thread。
3. 重新生成 Summary，执行 `prr post --update-summary --summary corrected.md`，避免顶层统计和 verdict 过期。

如果 finding 声称第三方依赖的 API 不存在、无效或必然抛错，必须提供 `verification` 字段；验证方式只能是
`runtime`、`test-run` 或 `declaration`。只有文本 grep 的 finding 会被 `prr note` 拒绝。

## 开发

```bash
npm install
npm test
npm run typecheck
npm run build
```

每次修改 `src/` 后都要重新构建并提交 `bin/prr.mjs`。

**每次提交前必须运行公开安全检查**，确认没有泄露凭据、个人信息或公司信息：

```bash
git config core.hooksPath .githooks      # 每个 clone 启用一次 pre-commit hook
npm run check:public                     # 扫描整个工作区
npm run precommit:check                  # 扫描已暂存、即将提交的内容（hook 自动执行）
```

内置规则检查 token、私钥、连接串密码、个人本地路径、真实邮箱、非示例的 Azure DevOps 组织名和 GUID。
公司、项目、客户和人名放在仓库之外的 `~/.config/pr-review/private-terms.txt`（每行一个词或 `/正则/`），
**绝不能提交到仓库**。测试中必须保留的示例值可在同一行加 `public-safety: allow` 注释；不要用它放行真实数据，
也不要用 `--no-verify` 绕过 hook。

## 设计原则

1. 机器判断交给代码，语义判断交给宿主 Agent。
2. 证据不足时进入 Open Questions，不降低严重度伪装成确认 finding。
3. 不把私有组织、仓库、PR URL、客户名称、真实人名、本地路径或凭据写入公开文档和测试；提交前运行 `npm run check:public`。
4. P5 headless model driver 不属于当前项目范围。
