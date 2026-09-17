# pr-review skill 改进计划：把确定性操作下沉为代码

参考对象：`~/repos/open-code-review`（下称 OCR）及其
`docs/analysis/open-code-review-workflow-analysis.zh-CN.md`。

核心判断：OCR 的收益（更高 Precision/F1、约 1/9 token）并非来自更聪明的 prompt，而是来自
**"把不需要推理的决定从模型里移出去"**：选文件、分组、大小门槛、上下文上限、评论定位、
覆盖清单、结果格式化全部是确定性代码，模型只负责语义判断。

当前 `SKILL.md`（16.9 KB，纯散文）把这些确定性步骤全部写成了给模型看的规则，模型每轮都要
重新读一遍、自己维护状态、自己遵守上限、自己声称覆盖完整。这就是本次改进的靶心。

---

## 1. 现状诊断（逐条对应 SKILL.md）

| # | 现状 | 问题 | 性质 |
|---|---|---|---|
| D1 | "Evidence Cache" 要求模型在对话里维护一张 ledger 表 | 状态随上下文漂移/被压缩丢失；无法校验"只读一次"；每轮重复占 token | **应为代码** |
| D2 | 批次划分靠散文启发式："10–15 files 或 ~1500 diff lines" | 模型无法数 token，只能目测 `--stat`；批次大小与风险排序不可复现 | **应为代码** |
| D3 | "generated/lock/binary 从 `--stat` 判断" | 分类标准在模型脑子里，同一 PR 两次运行结论可能不同 | **应为代码** |
| D4 | Acquire Evidence 是 az/gh/MCP 的决策树 + URL 手工解析 | 3–8 个来回才拿到 SHA 和 diff；错误处理散文化；输出污染上下文 | **应为代码** |
| D5 | 逐文件 `git diff A...B -- path` 原样进上下文 | 模型要自己数行号 → 行锚点常错（这是 inline comment 最大失败源） | **应为代码** |
| D6 | Findings 是自由文本 markdown | 无 schema、无校验、无法去重/复用/发布/resume | **应为代码 + 契约** |
| D7 | "Evidence: quote the relevant code snippet" 全靠自律 | 引用片段可被编造，行号可被编造，无人核对 | **应为代码（精度闸门）** |
| D8 | 与既有 thread 去重完全靠模型读全部 threads | token 贵且召回不稳定 | **代码预筛 + 模型判定** |
| D9 | 发布章节大段讲 UTF-8/emoji/shell 转义/JSON payload | 典型的"用散文解决编码问题"，本就是代码职责 | **应为代码** |
| D10 | Completion Criteria 由模型自我声明 | "每个文件都有 verdict" 不可验证 | **应为代码（门禁）** |
| D11 | worktree 路径/清理写成散文 | 容易残留、路径不统一 | **应为代码** |
| D12 | 无 rules 分层（OCR 有 path→checklist 优先级） | 项目特定约束无处安放，只能塞进 prompt | 可选增强 |
| D13 | 无 resume / 无 session 记录 | 大 PR 中断即全丢 | 可选增强 |

环境实测（本机）：`python3 3.12` 有，`git` 有，`rg` 有；**`gh`/`jq` 没有**；`az` 是
`/mnt/c/.../wbin/az`，即 **Windows 下的 python.exe 包装**——传文件参数必须先 `wslpath -w`
转换。这类细节写在散文里模型每次都会踩，写进脚本只需解决一次。

---

## 2. 从 OCR 借鉴的机制映射

| OCR 机制（含默认值） | 对应到 pr-review 的落法 |
|---|---|
| `selectFiles` 纯函数预筛（binary → secret 路径 → user exclude → include → 扩展名 allowlist → 默认排除路径 → 删除文件不派发 → 单文件 diff > 0.8×MAX_TOKENS 丢弃），preview 与真实运行共用 | `prr triage`：一个纯函数产出 `files.json`，每个文件带 `decision + reason + tokens + risk`；`--preview` 与实跑同源 |
| 分组硬约束：<4 文件不调 LLM；churn<200 行捆成一组；每组 ≤10 文件；超 token 退化为单文件组；失败安全退化 | `prr batches`：确定性分组（目录/同名/测试-实现配对 + 风险分排序 + token 预算），无需 LLM |
| Plan 阶段条件触发（单文件 churn ≥50 或组内 ≥2 文件合计 ≥100 行） | 批次 payload 中标注 `needs_plan: true`，SKILL 规定达标才做风险清单，小改动直接跳过 |
| 工具 IO 上限：`file_read` 500 行、`code_search` 100 命中、`file_find` 100 条、主循环 100 次工具调用、最多 2 轮 | `prr context`（默认 500 行窗口 + 跨度去重缓存）、`prr grep`（截断 100 命中）；上限由脚本强制而非靠模型自觉 |
| 评论定位确定性优先：hunk 内逐字匹配 → 新文件全文匹配 → 跨 diff 唯一命中则改投文件 → 都失败才调 LLM 重定位 | `prr verify`：用 `evidence` 片段反解行号；唯一跨文件命中则改投；无法定位 → 标 `unlocated`，禁止发布为 inline |
| 极保守 review filter（只删 diff 能直接证伪的评论；保护内存/并发/兼容性等主题） | 我们有更强的确定性替代：**verbatim 证据校验**（引用必须在 sourceSHA 中逐字存在）。证伪即降级到 Open Questions，而不是静默删除 |
| coverage manifest（selected/completed/reused/failed），"无评论 ≠ 审完" | `verdicts.jsonl` + `prr check` 门禁：任一文件缺 verdict 或存在未解决 `cross-batch` 即非零退出，禁止出 Verdict |
| session + identity hash + `--resume` | 运行目录以 `(host, repo, prId, sourceSHA, targetSHA)` 为 key；SHA 变更即整体失效 |
| 结构化 `code_comment` 提交而非自由文本 | `findings.jsonl` schema + `prr render` 渲染 md/SARIF，emoji 与格式由代码保证 |

**刻意不抄的**：LLM grouping、LLM plan、LLM review filter、LLM re-location——这四个都是额外 LLM
调用，在"skill + 宿主 agent"形态下由主模型顺手完成即可，抄过来只会增加成本和失败面。

---

## 3. 目标形态

```
pr-review/
├── SKILL.md                 # 只保留"判断"与流程契约，体量目标 ≤ 9 KB
├── agents/openai.yaml
├── bin/prr.mjs              # ★ 提交入库的单文件 bundle（唯一运行入口，无依赖）
├── src/
│   ├── cli.ts               # 子命令路由
│   ├── ado/                 # ★ Azure DevOps REST 适配层（auth / pr / iterations / threads）
│   ├── core/                # triage / batch / payload / locate / verify / dedup
│   ├── schema.ts            # files.json / findings.jsonl 类型 + 运行时校验
│   └── *.test.ts            # node:test
├── reference/
│   ├── standards.md         # Review Standards + Severity Rubric（模型按需读）
│   └── posting.md           # 发布语义（人读，脚本已实现细节）
└── docs/improvement-plan.md
```

### 3.1 运行时与语言选型：TypeScript（确认）

本机实测依据：

- `node t.ts` 直接运行成功（Node v24 原生类型剥离，**零构建**）；`typeof fetch === "function"`（原生 HTTP，**零依赖**）。
- `az --version` 耗时 **4.5 s** —— 因为本机 `az` 是 `/mnt/c/.../wbin/az`，实为 Windows `python.exe` 包装。

决策：

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript | schema（`files.json`/`findings.jsonl`）是本方案的核心契约，类型能直接防住字段漂移；ADO REST 响应类型可落成 interface |
| 开发时 | `node --test src/*.test.ts` 直跑 | Node ≥22.18/24 原生 strip types，开发不需 tsc/tsx/ts-node |
| 发布物 | esbuild 打成**单文件 `bin/prr.mjs` 并提交入库** | skill 是"文件夹分发"，不存在安装步骤，仓库里必须是可直接跑的产物；运行只需 **Node ≥18**（fetch），不依赖类型剥离 |
| 调用形式 | 统一 `node "<skillDir>/bin/prr.mjs" ...` | 见 §3.4：跨 bash/zsh/PowerShell/cmd 均可用，绕开 shebang、执行位、CRLF 三类跨平台坑 |
| 依赖 | **零运行时依赖** | 校验器手写（约 50 行）而非 zod；HTTP 用原生 fetch；仅 devDependency 为 esbuild + typescript |
| 测试 | `node --test` | 内置，`triage/batch/locate/verify` 全部是纯函数，好测 |

不选 Python：schema 契约无类型保障。不选 Go：分发要交叉编译产物，对一个 skill 过重。

### 3.2 Azure DevOps 专属机制（比换语言收益更大）

当前 SKILL.md 把 ADO 仅当作"取元数据的地方"，diff 全靠 git，**完全没有用到 ADO 的 iteration 模型**。这是最大的未开采收益：

| ADO 能力 | 端点 | 带来什么 |
|---|---|---|
| **直接拿到钉死的 SHA** | `pullRequests/{id}/iterations` 每个 iteration 含 `sourceRefCommit` / `targetRefCommit` / `commonRefCommit` | 不再靠 `git fetch` + 猜 merge base；`commonRefCommit` 就是权威 base。`prr refs` 从"多步 git 推断"变成一次 API 读 |
| **增量复审** | `iterations/{i}/changes?$compareTo={j}` | PR 被 push 新提交后，只审 iteration j→i 的增量，而不是重跑全量 diff。**这是复审场景最大的 token 杀手** |
| **评论跨迭代跟随** | change 上的 `changeTrackingId` + 发帖时 `pullRequestThreadContext.iterationContext.{firstComparingIteration, secondComparingIteration}` | 文档明确：支持 iteration 的 PR **必须**设置 `changeTrackingId`，否则新推提交后评论会脱锚。当前散文版完全没提这件事 |
| **精确锚点字段** | `threadContext.{filePath, rightFileStart, rightFileEnd}`，`CommentPosition.line` 从 1 开始、**`offset` 从 0 开始** | 这类一次性踩坑常量写进代码，模型永远不必知道 |
| 状态/类型枚举 | `commentType`: unknown/text/codeChange/system；`status`: unknown/active/fixed/wontFix/closed/byDesign/pending（请求发数字、响应回字符串） | 归一化放在适配层，`threads.json` 对模型只暴露稳定字符串 |

注意：ADO **没有**单一"取完整 diff"的 API（需拼 iterations + commits + items）。因此保持**混合策略**——
REST 负责元数据 / iterations / threads / 发帖，**git 负责 diff 与文件内容**。

### 3.3 认证与进程粒度

认证优先级：`AZURE_DEVOPS_EXT_PAT`（或 `SYSTEM_ACCESSTOKEN`）→ `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`。
有 PAT 时**一次 az 都不调**；只能走 az 时，每个进程只取一次 token 并保存在内存。

由此推出一条重要设计约束：**子命令要粗，不要碎**。16 个微命令 = 16 次进程启动 = 最坏 16×4.5 s。
改为 4 个粗粒度命令（同时也减少 agent 轮次）：

| 命令 | 合并了 |
|---|---|
| `prr prepare <url\|id> [--since-iteration N]` | init + fetch(元数据/threads) + refs(iterations 取 SHA) + triage + batches + 全部 payload 落盘 |
| `prr note` | finding add / verdict（可一次传多条，stdin JSON） |
| `prr finalize` | verify + dedup + check + render |
| `prr post [--min-severity] [--dry-run]` | 幂等发帖 + Summary 评论 |

辅助命令 `prr context` / `prr grep` 保留为按需调用（不需要 token，纯 git，启动快）。
**token 不落盘**，避免在缓存目录留凭据。

### 3.3.1 是否引入 agent SDK（pi SDK / Copilot SDK）—— 不引入

**内核不得含任何推理调用。** skill 形态下宿主 agent 就是模型，脚本内部再发起推理会导致：
双重推理（token 反而上升，与第一目标相反）、需要第二套认证与计费、破坏 C5 可移植性
（cloud agent / code review 环境跑不了 SDK 会话），且本质上是重造一个 OCR。

设计不变量：**脚本只做可判定的事**。OCR 的四个 LLM 调用在本方案中均有确定性替代：
grouping→风险分+亲和度分批；plan→`needsPlan` 标记交给宿主模型；review filter→verbatim 证据校验；
re-location→片段三级定位。

**唯一例外是无人值守场景**（ADO pipeline 自动审查并发帖），那时没有宿主 agent。
架构上处理为**驱动可插拔、内核不变**：驱动 A = 宿主 agent（默认，无 SDK）；
驱动 B = headless（**P5 可选**，用 pi SDK `createAgentSession` + `ModelRuntime` 约 100 行，
调用同一套 `prepare → note → finalize → post`，不改内核一行）。P0–P4 不碰 SDK。

### 3.4 跨宿主可移植性（VS Code Copilot Chat / Copilot CLI / Claude / pi）

Agent Skills 是开放标准：同一个文件夹在 VS Code agent mode、Copilot CLI、Copilot cloud agent、
Copilot code review、Claude、pi 下都能被加载。但**它们的工具能力不一致**，必须按最弱宿主设计。

安装位置（同一目录拷贝或链接即可）：项目级 `.github/skills/pr-review/`（兼容 `.claude/skills/`、`.agents/skills/`）；
个人级 `~/.copilot/skills/pr-review/`（兼容 `~/.agents/skills/`、pi 的 `~/.pi/agent/skills/`）。
frontmatter 以 `name` + `description` 为标准必须项，`argument-hint` / `user-invocable` 属宿主扩展键，保留即可。

**由此得出五条硬约束（直接决定脚本接口形态）**：

| # | 约束 | 原因 |
|---|---|---|
| C1 | 命令一律写成 `node "<skillDir>/bin/prr.mjs" <sub> --flags`，**单行、无管道、无 heredoc、无 `$()`、无 `&&`** | VS Code 终端工具在 bash/zsh/PowerShell 下引号语义不同；复杂命令行还会让自动批准规则失配 |
| C2 | **模型不向 stdin 管道传 JSON**；改为用宿主自带的写文件工具写 `finding.json`，再 `prr note --file <path>` | 写文件/读文件是所有宿主都有的能力；引号与 emoji 在 shell 层彻底不再出现 |
| C3 | 每条命令 **stdout ≤ ~30 行**，详情一律落盘让模型用 read 工具读 | VS Code 终端工具输出会被截断，截断发生在开头还是结尾不可控 |
| C4 | **子代理并行分发只能是可选优化**，流程必须在纯串行下完整可跑 | Copilot CLI / Claude / pi 有子代理，VS Code agent mode 没有 |
| C5 | **不得依赖 MCP** | Azure DevOps MCP 只在部分宿主装了。改走 REST 后这条自然满足，同时可**删掉 SKILL.md 里那张 VS Code=MCP / CLI=az 的能力分支表** |

配套交付物：

- `README.md` 给出 VS Code 自动批准片段，避免每条命令弹窗（需配合 `chat.tools.terminal.enableAutoApprove`）：

  ```jsonc
  "chat.tools.terminal.autoApprove": {
    "/\\bprr\\.mjs\\b/": true   // 实际版本对 matchCommandLine 行为有差异，需实测确认
  }
  ```

- `scripts/install.sh|ps1`：把 skill 目录链接到上述各宿主路径。
- CI 校验 `bin/prr.mjs` 与 `src/` 同步（重新构建后 `git diff` 必须为空），防止分发产物陈旧。
- 运行目录跨平台解析：Windows 用 `%LOCALAPPDATA%`，其余用 `$XDG_CACHE_HOME`/`~/.cache`（由 Node 统一处理）。
- Node 缺失时，`prr` 无法启动；SKILL.md 给一句明确的降级说明（报告能力不可用并停下，不得退回到手工散文流程——
  否则两套流程共存会把 SKILL.md 又撑回去）。

运行状态目录（**不写进被审仓库**）：
`${XDG_CACHE_HOME:-~/.cache}/pr-review/<host>-<repo>-pr<id>-<sourceSHA:12>/`

```
run.json        身份：host/org/project/repo/prId/sourceSHA/targetSHA/mergeBase/scope/capabilities
pr.json         标题、描述、作者、work items、labels、reviewers
threads.json    归一化既有评论：{id, path, line, status, author, isBot, body}
files.json      每文件：{path, status, add, del, binary, decision, reason, tokens, risk}
batches.json    [{id, label, files[], estTokens, riskRank, needs_plan}]
payload/b1.md   该批次的"带行号标注"diff 包（模型直接读这一个文件）
verdicts.jsonl  {path, batch, verdict: clean|findings|cross-batch, note}
findings.jsonl  结构化发现（schema 见 §4.10）
posted.json     fingerprint → threadId（发布幂等）
```

**数据契约优先**：先冻结 `files.json` / `findings.jsonl` 两个 schema，脚本与 SKILL.md 都围绕它写。

---

## 4. 脚本清单与 I/O 契约

下表是**内部能力清单**，对外只经由 §3.3 的 4 个粗粒度命令暴露。所有命令：读运行目录 → 做确定性工作 →
写运行目录 → **stdout 只打印精简摘要**（避免污染上下文），详情落盘由模型按需 `read`。统一 `--json`
输出，失败非零退出并给出可执行的修复建议。

**宿主收敛**：只把 Azure DevOps 做成一等公民，`HostAdapter` 接口留给以后接 GitHub。
这能砍掉 SKILL.md 里的 host 决策树、`gh`/MCP 分支和大量条件散文（本机也确实没有 `gh`）。

| # | 命令 | 输入 | 输出 | 替代掉的散文 |
|---|---|---|---|---|
| 4.1 | `prr init <url\|number\|--branch <base>\|--worktree>` | PR URL / 裸号 / 分支 / 工作区 | 运行目录 + `run.json`（含 host 判定、能力探测：az/gh/MCP 是否可用） | Scope 表、"裸号继承 origin"、能力诊断 |
| 4.2 | `prr fetch` | run.json | REST 取 PR + threads → `pr.json` + `threads.json`（枚举归一化、bot 标记、行锚点还原）；缓存幂等 | Acquire Evidence 1 |
| 4.3 | `prr refs` | run.json | 读 `iterations`，取 `sourceRefCommit/targetRefCommit/commonRefCommit` 钉死 SHA + 记录 `iterationId` 与每个 change 的 `changeTrackingId`；只做一次 `git fetch <sourceSHA>` | Acquire Evidence 2 + "不要用移动分支名" |
| 4.4 | `prr triage` | pinned SHAs (+`$compareTo` 增量) | `files.json`：分类（binary/secret/lock/generated/vendor/snapshot/test/doc/source）、`decision=review\|stat-only\|skip`、reason 码、diff token 估算、risk 分（安全敏感路径 / 契约与 schema / 迁移 / 核心逻辑 / 测试 / 文档 权重）；`--since-iteration` 时只纳入增量变更文件 | Review Budget 中的"从 --stat 判断"整段 |
| 4.5 | `prr batches [--max-files 10] [--max-tokens N]` | files.json | `batches.json`：风险降序、相关文件同批（同目录/同基名/实现+测试+fixture）、token 预算切分、超限退化单文件批 | Batched Full Coverage 的数字启发式 |
| 4.6 | `prr payload <batchId>` | batches.json | `payload/b<N>.md`：每文件 `<file path=…>` 包裹的 diff，**每行前缀真实新文件行号**；附该批文件命中的既有 threads 摘要、适用 rules checklist、`needs_plan` 标记 | D5 行号错误 + 逐文件 git diff 来回 |
| 4.7 | `prr context <path> --start N --end M` | sourceSHA | 上限 500 行窗口；与已读跨度做并集去重，重复请求直接返回 `cached` | Evidence Cache 中 "context span 只读一次" |
| 4.8 | `prr grep <symbol> [--max 100]` | sourceSHA tree | 截断命中列表 | "Symbol references 读一次" |
| 4.9 | `prr verdict --batch N --file <path>=clean\|findings\|cross-batch` | — | 追加 `verdicts.jsonl` | 覆盖自我声明 |
| 4.10 | `prr note --file <path>` | 结构化发现/verdict（模型用写文件工具生成，可一次多条） | 校验 schema → 写 `findings.jsonl` / `verdicts.jsonl` | 自由文本 findings（且满足 C2，不走 stdin/引号） |
| 4.11 | `prr verify` | findings + diff/source | ①`evidence` 必须在 `sourceSHA:path` 逐字存在；②由片段反解 `line/endLine`；③唯一跨文件命中则改投 path；④失败标 `unverified/unlocated` 并强制降级到 Open Questions | D7"引用与行号靠自律" |
| 4.12 | `prr dedup` | findings + threads.json | 候选对：同文件 + 行距 ≤ K + 文本 shingle 相似度，输出待模型裁决的**短名单**（通常 0–5 对） | 模型通读全部 threads |
| 4.13 | `prr check` | 全部 | 门禁：每个 `decision!=skip` 的文件有 verdict、无残留 `cross-batch`、每条 finding 字段齐全且已 verify。非零退出即禁止输出 Verdict | Completion Criteria |
| 4.14 | `prr render [--format md\|sarif\|json] [--min-severity]` | findings | 严重度排序 + emoji 标签 + 代码块/`suggestion` 块由代码生成 | Output Format 的格式约束 |
| 4.15 | `prr post --min-severity high [--dry-run]` | findings + posted.json | 按 fingerprint 幂等发布：`POST .../pullRequests/{id}/threads?api-version=7.1`，自动填 `threadContext.rightFileStart/End`（line 起 1、offset 起 0）与 `pullRequestThreadContext.{changeTrackingId, iterationContext}` 保证跨迭代跟随；body 为 JSON 字符串（**emoji/转义由 `JSON.stringify` + UTF-8 fetch 天然解决，不再需要临时文件与 wslpath**）；只发 `verified` 且非 duplicate 的条目 | 整个 Posting 章节的编码/转义说明 |
| 4.16 | `prr worktree add\|rm` | sourceSHA / merge ref | 固定路径 `<repo-parent>/.pr-review/<repo>-pr-<id>`，自动 prune | worktree 散文 |

横切要求：纯 stdlib、无网络依赖除 az/gh；所有子命令可单测；`prr --version` 写入 run.json 供 resume 校验。

---

## 5. SKILL.md 改写方案

**删除**（行为已由代码保证，留在 prose 只是重复计费）：Evidence Cache 整表、批次数字启发式、
az/gh 命令决策树、git diff/show 用法、UTF-8/emoji/转义说明、worktree 命令块、Completion Criteria 清单。

**保留并强化**（只有模型能做的判断）：Scope & Safety、Severity Rubric、Review Standards、
Finding Deduplication 的**语义规则**（同根因即重复）、What to Report、Output Format 的文字要求、
Anti-patterns、Open Questions 的边界。

**新增**：一段固定的流水线契约，例如

```text
prr init <target> && prr fetch && prr refs && prr triage && prr batches
for each batch (risk 降序): read payload/b<N>.md → 审查 → prr finding add → prr verdict
prr verify && prr dedup   # 裁决短名单
prr check                 # 必须通过，否则不得给 Verdict
prr render                # 输出 Summary / Findings / Open Questions / Verdict
（用户显式批准后）prr post --min-severity high
```

配套：把 Review Standards + Severity Rubric 拆到 `reference/standards.md`，SKILL.md 只在批次审查步骤
指路"读这个文件"，降低常驻上下文。目标：SKILL.md 从 16.9 KB → ≤ 9 KB，且每轮重复进上下文的规则量下降 ~50%。

---

## 6. 分阶段实施

| 阶段 | 内容 | 产出 | 预期提升 |
|---|---|---|---|
| **P0 骨架**（最高性价比） | ADO REST 适配层 + auth；`prr prepare`（=4.1–4.6）+ `prr note`（4.9）+ check（4.13）；SKILL.md 删除 D1–D5 与 host 决策树 | 可复现的选文件/分批/带行号 payload/覆盖门禁 | 取证从 ~6–10 轮降到 **1 条命令**；az 进程从 N×4.5 s 降到 0–1 次；行号错误基本消失；覆盖率可证明 |
| **P1 精度** | 4.10–4.12 + 4.14（findings schema、verbatim 校验、去重预筛、渲染） | 结构化发现 + 确定性事实闸门 | 编造引用/错行号被机械拦截 → Precision 提升；去重 token 显著下降 |
| **P2 写路径** | 4.15 幂等发布（含 WSL 路径修正）+ 4.16 worktree + SARIF | 一条命令完成发布，永不重复发帖 | 消除发布类事故；emoji/编码问题一次性解决 |
| **P3 增益** | **iteration 增量复审（`--since-iteration` / `$compareTo`）**、4.7/4.8 上下文与检索上限、rules 分层（`.pr-review/rules.json`，优先级：`--rule` > 项目 > 全局 > 内置）、resume | 复审只审增量、成本可预测、项目约束可配置 | 复审 token 数量级下降；大 PR 中断可续 |
| **P4 验证** | fixtures 评测：构造含已知缺陷的合成 PR（注入越界/空指针/注入/契约破坏/竞态各若干），跑前后两版本 | 回归脚本 | 让"提升"可度量而非自称（OCR 分析文档明确指出其 benchmark 不可复跑，我们不要重蹈） |

建议顺序执行；P0 完成即可先行收益，P1 之后再动写路径。

---

## 7. 成功判据（P4 度量口径）

对同一组固定 PR，比较改造前后：

1. **命令/工具调用轮次**：取证阶段目标 ≥60% 下降。
2. **输入 token**：整轮目标 ≥40% 下降（来源：SKILL 瘦身 + payload 合批 + 去重预筛 + 上下文跨度缓存）。
3. **行锚点正确率**：inline 位置正确的 finding 占比，目标 ≥95%（verify 反解保证）。
4. **证据真实率**：`evidence` 逐字存在于 sourceSHA 的比例，目标 100%（不满足者不得进入 Findings）。
5. **覆盖可证明性**：`prr check` 通过率 100%，且 deferred 文件均有显式用户批准记录。
6. **重复发帖数**：0（fingerprint 幂等）。
7. **严重缺陷召回**：以 fixtures 注入缺陷计，改造后不得低于改造前（防止为省 token 牺牲召回——OCR 的
   Recall 代价正是前车之鉴；`decision=skip` 的文件必须在 Summary 明示）。

---

## 8. 风险与取舍

- **召回下降风险**：确定性预筛会主动丢弃文件（OCR 已承认这是其 Recall 更低的原因）。对策：`skip`
  只用于 binary/secret/超大，`stat-only`（lock/generated/vendor）仍进 Summary 且可被 finding 覆盖；
  两类都在输出中列明，不得静默丢弃。
- **维护成本**：脚本需随 az/gh 输出格式演进。对策：host 适配层单独隔离，所有外部 JSON 解析集中，附单测。
- **环境差异**：本机无 `gh`/`jq`，`az` 为 Windows 包装（每次启动 4.5 s）。对策：改走 REST + 原生 fetch，
  仅在无 PAT 时调一次 `az account get-access-token`；`prr prepare` 做能力探测并明确报告不可用能力。
- **宿主能力差异**：VS Code agent mode 无子代理、终端需逐条批准且输出截断。对策：§3.4 的 C1–C5 硬约束；
  并行分发仅作可选加速，串行路径必须完整。
- **Node 缺失/版本过低**：发布物为已打包 `bin/prr.mjs`，只要 Node ≥18。未安装 Node 时明确报不可用并停下。
- **ADO API 版本漂移**：固定 `api-version=7.1`，适配层集中解析，响应字段缺失时降级而非抛错。
- **过度工程**：脚本不做任何语义判断（不分类严重度、不判重、不改写发现文本），只做可判定的事；
  边界一旦模糊，保持留在 SKILL.md 由模型判断。
- **与宿主 agent 的耦合**：脚本必须能被 VS Code / Copilot CLI / pi 任一宿主直接 `bash` 调用，不依赖 MCP；
  MCP 仅作为 `prr fetch` 的可选加速路径。

---

## 9. Implementation status

The deterministic core is implemented for the following capabilities:

- Azure DevOps REST metadata, iterations, threads, and posting adapters.
- Pull request, branch, and working-tree review scopes.
- Deterministic file triage, risk-ranked batching, annotated diff payloads, and coverage manifests.
- Source-revision context reads and searches that work without a checkout.
- Per-path rules with project, user, explicit, and built-in layers.
- Evidence verification, deterministic line resolution, duplicate shortlisting, and idempotent posting.
- Markdown, JSON, and SARIF output.
- A temporary-repository evaluation harness for the deterministic layer.

The current test suite covers the pure core, URL parsing, rules, working-tree behavior, and the
retraction lifecycle. The repository deliberately does not include a headless model driver; the
host agent remains responsible for semantic review.

The validation numbers in this document are design targets and fixture results, not claims about
review recall or model quality. Any benchmark result should be recorded separately with its model,
provider, corpus, and reproducible command.

## 10. Field-review backlog

Lessons from running the skill on several real multi-batch pull requests (identifiers anonymized).
Each item is a confirmed friction point, ranked by the damage it can cause.

### 10.1 Highest value

1. ✅ **Dependency-claim verification gate (implemented in v0.2.0).** Findings can carry a
   `verification` record with method `runtime`, `test-run`, or `declaration`. `prr note` rejects
   dependency API claims without one; `finalize` independently downgrades persisted legacy records
   that lack it. Markdown comments and SARIF carry the verification detail.
2. ✅ **Retraction workflow (implemented in v0.2.0).** `prr note --file` accepts
   `{"retract": [ids]}` and `finalize` treats `retracted` as terminal. With explicit write approval,
   `prr post --retract <id>` appends a correction to the recorded thread and closes it. The action
   is idempotent and refuses to run until local state is retracted.
3. ✅ **Summary correction (implemented in v0.2.0).** `prr post --update-summary --summary <file>`
   appends corrected text to the recorded `__summary__` thread. Identical content is deduplicated by
   hash; a missing summary thread is created rather than silently skipped.

### 10.2 Medium value

4. ✅ **Wrong-run protection (implemented in v0.3.0).** Commands without `--dir` now require a
   prepared run whose `repoRoot` matches the current git repository. Running elsewhere is a hard
   error; there is no global-most-recent fallback.
5. ✅ **Bulk batch verdicts (implemented in v0.3.0).**
   `prr note --batch <n> --all-clean [--except <path>=findings|cross-batch]` records the entire
   batch, is idempotent, validates exception paths, and refuses to overwrite a different verdict.
6. ✅ **Generated-file deduplication (implemented in v0.3.0).** `.g.cs` files are classified as
   generated; target-framework conditionals are normalized and duplicate content is grouped. One
   representative is promoted to review and twins record `duplicate-of:<path>`.
7. ✅ **ADO policy/status evidence (implemented in v0.3.0).** `prepare` fetches pull-request statuses
   and policy evaluations opportunistically, writes `builds.json` and `policies.json`, and summarizes
   states without failing the review when the optional endpoint is unavailable.

### 10.3 Lower value / watch list

8. **`prr grep` output for definition-hunting.** Finding a symbol's definition still takes 2–3 grep
   calls (declaration vs. call sites). A `--context <n>` flag printing a few lines around each hit
   would cut most follow-up `prr context` calls.
9. **Thread reconciliation for `fixed` threads.** The payload lists existing threads, but verifying
   “thread marked fixed — is it actually fixed at this revision?” is manual. A helper that maps a
   thread's anchor onto the current diff (moved/deleted/unchanged) would make the reconciliation
   step mechanical.
10. ✅ **Test-run integration (implemented in v0.3.0).**
    `prr exec --record --timeout <seconds> -- <command> [args...]` runs an argv vector without a
    shell, propagates the exit code, redacts common credentials, caps output, and appends the result
    to `validations.jsonl` for auditable Summary evidence.

## 11. Maintenance policy

Keep this plan architectural and repository-agnostic. Do not record private pull request URLs,
organization names, repository names, customer names, local filesystem paths, tokens, or credentials
here. Real-run observations belong in a private session or an anonymized fixture, not in this
repository.

When changing the toolkit:

1. Update the TypeScript source and its tests.
2. Run `npm test` and `npm run typecheck`.
3. Rebuild `bin/prr.mjs` and verify it matches the source build.
4. Update the English and Chinese README files when the public workflow changes.
5. Run a repository-wide secret and private-reference scan before publishing.