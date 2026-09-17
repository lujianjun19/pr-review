# pr-review

一个面向 GitHub Copilot、VS Code Agent、Copilot CLI、Claude、pi 等 Agent Skills 宿主的 Azure DevOps Pull Request 审查技能。

本项目把**可确定的审查工作下沉到代码**，让 Agent 只负责语义判断：

- 固定 Azure DevOps PR iteration 和 commit SHA
- 识别、筛选、排序和分批变更文件
- 生成带真实源文件行号的 diff payload
- 从 source revision 验证 finding 的证据
- 检查文件覆盖率、去重候选和评论位置
- 生成 Markdown、JSON、SARIF
- 在用户明确授权后幂等发布 inline comments

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
node bin/prr.mjs prepare --branch main
node bin/prr.mjs prepare --working-tree
node bin/prr.mjs context --path src/example.ts --start 40
node bin/prr.mjs grep createOrder --files-only
node bin/prr.mjs rules check src/example.ts
node bin/prr.mjs note --file findings.json
node bin/prr.mjs finalize
node bin/prr.mjs finalize --format sarif > findings.sarif
node bin/prr.mjs post --dry-run
node bin/prr.mjs post --retract <finding-id> --dry-run
node bin/prr.mjs post --update-summary --summary corrected.md --dry-run
```

审查状态默认保存在用户缓存目录，不写入被审仓库：

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
      "path": "src/payments/**",
      "rule": "Money must be handled in minor units."
    }
  ],
  "exclude": ["**/__fixtures__/**"]
}
```

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

每次修改 `src/` 后都要重新构建并提交 `bin/prr.mjs`。提交前还应运行：

```bash
rg -n -i 'private-host|internal-repo|pullrequest/[0-9]+|/home/|token|password|secret' .
```

扫描命令中的模式只是示例；发布前应根据项目实际情况扩展或调整，不要把真实凭据写入仓库。

## 设计原则

1. 机器判断交给代码，语义判断交给宿主 Agent。
2. 证据不足时进入 Open Questions，不降低严重度伪装成确认 finding。
3. 不把私有组织、仓库、PR URL、客户名称、本地路径或凭据写入公开文档和测试。
4. P5 headless model driver 不属于当前项目范围。
