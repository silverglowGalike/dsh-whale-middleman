# 中台 · dsh-whale-middleman

主会话当**中台**：**盘问 → 收敛 → 拆草稿票 → 人工批准（批准即开跑）→ 前置 done 自动接力 → 结果自动回传**，
跑到一半需要你拍板的地方，子会话会**主动停下来问你**。

它管的是方向：不是让 AI 游得更快，是在该拐弯的地方停下来等你。
（原型是 whale-tail「鲸鱼尾巴」插件，改名后包名仍为 `dsh-whale-middleman`。）

一个 DeepSeek Harness（DSH）插件。它补的是现成方案缺的那一层：

| 现成能力 | 缺什么 |
|---|---|
| `subagent` 工具 | 立刻就跑，没有挂起；模型和父会话相同 |
| 小队（dsh-agents） | 能钉预设和模型，但一调就开跑 |
| 任务板 | 有 todo 列当挂起，但没有「批准前先把设计问清楚」 |

中台要的是：**批准时把会话建好、模型定好，就绪的票直接开跑**；前置没完成的票排队，等前序 `done` 自动接力。

> **第一次用请看 [USAGE.md](USAGE.md)** —— 装、怎么触发、卡片怎么看、模型怎么选、出错了怎么办，一篇读完。
> 这份 README 讲的是它为什么这么做。
> 未解决问题与已知限制：[`../designs/whale-tail-middleman-issues.md`](../designs/whale-tail-middleman-issues.md)（开发副本内）。

## 怎么触发

**一句话：在主会话里用自然语言说事，模型会自己走流程。**

插件在每个会话的系统提示里挂了一段说明，告诉模型这个面存在、怎么用、以及哪些动作会被拒（`lib/index.js` 的 `PROMPT_TEXT`）。所以你**不需要记任何命令名**，只要说出意图，模型会调对应的工具。

### 三个入口

| 你想做的事 | 怎么说（任选其一） | 模型会做什么 |
|---|---|---|
| 派活给子会话 | **「用中台派个子任务」**、**「开个设计批次」**、**「派发子任务」** | `design_open` → 盘问 → 收敛 → 拆草稿票 → 等你批准（批准即开跑） |
| 让它盘问你 | **「盘问一下」**、**「先盘问再动手」** | `design_round` → 连续几轮问你，每轮带风险探测 |
| 只规划不派发 | **「流程规划」**、**「怎么分工」** | `design_plan` → 写下分几步、产出什么、什么能并行 |

可靠的触发词是上面加粗的那几个（中台 / 设计批次 / 派发子任务 / 盘问 / 流程规划）——它们写在系统提示段末尾，模型一定认得。

除此之外，你把需求说完整了模型也可能自己走这条路（比如「帮我设计一个插件，主会话派任务给子会话」——需求里明说了「派任务给子会话」，模型会判断该用这个面）。但**别指望**只说「设计个插件」就一定进中台——那句话太泛，模型可能直接开干。

拆票相关的触发词在每条工具的描述里也各带了一份（`design_open` 写「设计批次 / 开个设计」，`design_question` 写「盘问 / 提问」，`design_plan` 写「流程规划 / 怎么分工」），所以模型从工具表也能认出该调哪条。

### 一次完整的对话长什么样

```
你：帮我设计一个插件，主会话当中台，派任务给子会话
模型：（调 design_open，开批次）先问你几个问题——
模型：① 这个插件装在哪？【推荐：DSH 插件，因为……】
模型：② 子会话独立跑还是共享上下文？【推荐：独立，因为……】
模型：③ 什么情况下这个方案会失败？（风险探测）
你：答三个问题
模型：（记 design_question ×3，定 design_answer，写 design_plan）
模型：（design_converge）设计收敛了
模型：（design_split）先拆成 3 张草稿票，各挂风险、各定模型
    ↓  你在侧边栏「中台」里点「批准这份设计」（批准即开跑）
    ↓  就绪的票直接开跑；前置没完成的票排队，前序 done 后自动接力
     （子会话跑完）→ 结果自动推回这条主会话
```

### 你在哪几个地方动手

插件一共三处需要你介入，其余全自动：

| 位置 | 做什么 |
|---|---|
| **侧边栏「中台」** | 看批次列表（创建时间倒序，最新在最上面；已结束 / 已取消的批次默认折叠置灰）；收敛后点「批准这份设计」（批准即开跑）；重启恢复的挂起票点「执行」，启动失败的票点「重试启动」，终态票点「重跑」（会重新计费） |
| **对话流里的批准卡** | 挂在 `design_converge` 那行：目标 / 不做什么 / 验收标准 / 风险条数 / 票与模型，一个「批准并开跑」 |
| **主会话对话** | 回答盘问；最后收子会话的回报 |

### 不想用自然语言的话

工具是给模型用的，用户直接调没有意义。但**盘问阶段必须由用户回答**，那部分走的是主会话的正常对话（模型会一条一条问用户）。

## 为什么是这四道闸门

规则写在代码里，不写在提示词里。提示词会被模型合理化掉。

1. **设计**：至少 3 个已回答的问题、一份流程规划、至少一条四栏齐全的风险
2. **收敛**：设计树前沿清空、规格有验收标准、风险四栏齐全、依赖边合法
3. **批准**：只有你能点。`approve` 不在工具面上，模型没有对应工具可调
4. **批准即开跑**：批次已批准、每张票挂风险、模型已定、阻塞边不成环；批准后 `design_split` 锁定，没就绪的票排队等前序 `done`

## 跟 ask-matt 技能组合怎么接

这套流程抄的是 [mattpocock/skills](https://github.com/mattpocock/skills) 里
`/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement` 那条主流程的骨架，
但**盘问逻辑内建在插件里**，不外包给技能。

原因：`ask-matt`、`grill-with-docs`、`to-spec`、`to-tickets` 这些技能都带
`disable-model-invocation: true`，模型调不动它们。只有 `grilling` 是模型可调的。
所以插件自己实现了那套盘问纪律：

| 纪律 | 实现 |
|---|---|
| 事实是你的活 | 提示段明确写「能自己查的就去查，别问用户」 |
| 决定是用户的活 | 每个问题必须带推荐答案和理由 |
| 前沿才能问 | `design_round` 只放前置条件已满足的决定 |
| 每轮带风险探测 | 代码保证：没登记过风险就自动追加一问 |
| 风险要有验证方式 | 四栏缺一栏拒绝，「无」「n/a」不算 |

技能组合仍然可以叠加用：主会话想走 `/grill-with-docs` 就自己调用，插件的
账本照样记；不想走技能，插件自己也够用。

## 流程

```
design_open      开一个设计批次（盘问阶段的容器）
design_round     取下一轮要问的问题；代码保证只要还没登记风险就带一个风险探测
design_question  记一个问过用户的问题和答案（拆票前至少 3 个）
design_answer    定一个决定，或登记一条风险（四栏缺一栏就拒绝）
design_plan      写下流程规划：分几步、每步产出什么、什么能并行
design_converge  收敛成规格
design_split     先拆成草稿票，每张挂风险、定模型
   ↓  你在中台面板点「批准」——批准即给就绪的票建会话并开跑
   ↓  前置没完成的票排队，前序 done 后自动接力
（子会话开跑）→ turn/end → 回传：定位 + 状态 + 子会话的最终汇报

回执（子会话侧，结束前调用）：
middleman_report_done({ outcome: "done" | "needs_review", report })
  - done         自测通过 → 主会话收到汇报，后继按依赖自动开跑
  - needs_review 没通过/拿不准 → 状态 needs_review，只回传汇报，不自动开跑
  - 没交回执的一轮按未完成结算（no_receipt）

恢复（失败不是终点）：
middleman_answer  主会话回答 waiting 票的技术性确认（方向/范围/取舍仍交给用户）
middleman_cancel  主会话取消跑歪的票，记 lead_interrupted
middleman_rewire  改一张未结束票的依赖表（前序失败时可把下级摘出来），改完立刻重算依赖
middleman_rebind  把票重绑到另开的新会话（接管失败票），之后新会话的 turn/end 结算到这张票
middleman_retry   票没跑成：重试（复核族不限、报错族 5 次）——主会话自己修，不必等用户
middleman_reparent 换了主会话：把回传改绑到当前会话
```

## 失败了谁来修：主会话先修，修不动再找你

这个插件的定位不是「每张票都让你盯」，而是**你专注设计与决策，细枝末节交给主会话**：

- **子会话的活是主会话拆的**，主会话比用户更懂它自己写的任务书和技术选型；
- 用户批准方案，等于已经授权了「必要的 debug 重跑」——所以重试不按花钱一刀切禁掉；
- 真正需要用户的，是「要不要继续」「换哪个方案」「还要不要做」这类决定，不是一条报错。

于是重试分两族（`core.LEAD_ERROR_RETRY_LIMIT`）：

| 族 | 什么时候 | 额度 |
|---|---|---|
| 复核族 | 子会话自评 `needs_review`、没交回执（`no_receipt`）、报告读不到（`receipt_unverified`） | **不限**。产出不对/没交自评，重跑是正常返工 |
| 报错族 | 网络中断（`NETWORK_FAILED`）、启动失败（`LAUNCH_FAILED`）、其它 error | 同一错误码 **5 次**。可能是外网/VPN 抖动，给够但不无限烧 |

两个细节：

- **只算主会话主动调的那几次**。DSH 自己的重连、60 秒宽限里的自动恢复都不消耗额度，
  所以网络抖动比旧版更不容易把次数打光；
- **用户动手就把额度还回去**：面板点「执行」「重跑」「重试启动」，主会话的计数清零。
  人是最终决策者。

额度用完时，主会话会把情况报告给你（而不是继续硬撑）。用户在面板上「重试启动」可以
清掉启动失败标记再试——这是旧版没有的出口（I-04）。

**重设计也走这条路**：批准后 `design_split` 已锁定，主会话改不了任务书。如果失败原因是
「任务书本身写歪了」，只重跑同一份只会再错一次——`middleman_retry({brief})` 可以换一份
任务书重发，旧 brief 与新 brief 的替换会记进票的 `retries` 审计（`briefChanged`）。

## 只有 `done` 会自动往下走

2026-11-18 起，依赖求值只认 `done`，而 `done` 来自**子会话自己的自评**：
结束前调 `middleman_report_done({ outcome: "done", report })`。中台不判断
报告内容——它是程序，只按自评记账；`needs_review`（自测没过/拿不准）只把
汇报送主会话，不自动开跑。没交回执的一轮按未完成结算（`no_receipt`）。

**通过与否是子会话自测的责任。** 复杂任务建议在设计阶段额外拆一张独立
验证票（依赖实现票），别只指望自评；简单任务可以信任自测。要放行，
主会话用 `middleman_rewire` 摘掉那条阻塞边；要重做，你在面板点「重跑」。
回归在 `test/i01-receipt.test.mjs`（10 条）。

## 四个已绑定的风险

| ID | 触发 | 当前处理 | 代码位置 / 测试 |
|---|---|---|---|
| R-1 | 启动失败后票静默卡在 queued | 写 `launchError` + `launchFailureCode`，立刻给主会话发一条「启动失败」信封；不自动重试，主会话用 `middleman_retry`（报错族，同一 code 5 次）或用户点「重试启动」 | `observer.relayBatch`、`routes.js` 的 `/approve`；`p1-host` / `p1-relay` |
| R-2 | 子会话撞 `max-tokens` 或宿主级中断，却被当成失败 | 按 reason 分类，记 `partial` | `core.classifyTurnEnd`；`p0.test.mjs` |
| R-3 | 拆票前没问清楚 | 至少 3 个已回答问题 + 流程规划 + 一条风险 | `core.designGateProblems`、`core.ticketProblems` |
| R-4 | 风险的「验证方式」承诺的单测不存在 | 验证方式含「单测」时要求写出测试文件，且文件在批次 `cwd` 下存在；「人工核对：…」允许 | `core.verificationTestGap`、`verifyscan.js` |

R-2：`max-tokens` 与宿主级 `interrupted` 都记为 `partial`；`partial` 不自动解锁后继。

R-4：验证方式由模型填写；闸门在 `design_answer`（登记）与 `design_split`（拆票）两处检查测试文件是否存在。写不成单测的验证方式可写「人工核对：…」。

### 终态票不会再被误「执行」

2026-11-17 现场事故：一张 20:08 就已 `cancelled` 的票，21:33 被用户误点「执行」，
`/run` 只拦了 running，于是它又被发了一整轮任务书，21:34 才被中止。

现在 `/run` 只接受 `suspended / queued / draft`；`done / failed / partial /
needs_review / no_receipt / receipt_unverified / user_interrupted / lead_interrupted`
（以及旧台账里的 `cancelled` / `interrupted`）
默认 409（`ticket-terminal`），要重跑必须显式带 `force: true`——那是面板上
「重跑」按钮的人工语义（先提示会重新计费），自动流程不会带它。面板同时把
批次按创建时间倒序、终态批次默认折叠置灰，减少误点的机会。回归在
`test/p1-run-guard.test.mjs`。

**终态不等于锁死**：中断/失败之后，你可以在那个子会话的对话页里手动继续，
或者点「重跑」开新一轮；后续回合照常结算，交回执 `done` 就回到 `done`。

### 中断分开记、网络中断先挂宽限

- 用户按停止 → `user_interrupted`；主会话调 `/cancel`（`by: "lead"`）→
  `lead_interrupted`。不再用同一个 `cancelled` 表示两种决定。
- 网络断开（`error.code === 'TRANSPORT'`）：DSH 自己的请求重试（0.5s 起步、
  5 轮约 15.5s）发生在 turn/end 之前，中台看到 TRANSPORT 时它已经结束。
  中台**不自己续跑**，只挂 60 秒宽限等后续活动；期间有新活动就撤销，到点
  仍无活动才报一次 `failed` + `code: 'NETWORK_FAILED'`（和别的报错同一族）。
- DSH 重启/崩溃后的补结算**静默**进行：状态照写，不推信封。要给主会话
  看的细节，主会话自己拉台账。

另外，`/approve` 里启动失败的票回 `queued`（不是 `draft`）：批次已批准时
`design_split` 被锁死，`draft` 票永远不会再被用户看见。票带 `launchError`
时 `evaluateBatch` 不会再自动启动它——中台会立刻给主会话发一条「启动失败」
信封，主会话用 `middleman_retry` 重试（按 `LAUNCH_FAILED` 记在报错族，同一
code 5 次），或用户在面板点「重试启动」。

## 安装

仓库不自带 `install.sh`。当前安装方式是 profile 依赖（`file:` 复制装载）：

1. 插件目录就位：`~/.dsh/plugins/dsh-whale-middleman`；
2. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加入
   `"dsh-whale-middleman": "file:C:/Users/admin/.dsh/plugins/dsh-whale-middleman"`；
3. 同一文件的 `dsh.profile.bundles` 加入 `dsh-whale-middleman`；
4. 用 pnpm 把依赖装进 profile 的 `node_modules`；
5. **完全退出 DSH 再启动**（不是关窗口）。

两处都要改：只改 `dependencies` 时旧 bundle 仍会被引用。

### 验证装好了

- 侧边栏多一行「中台」；
- `list_bundles` 显示 `dsh-whale-middleman` 与 0.2.1；
- 主会话里调 `middleman_status` 能返回批次列表（空列表也算可用）；
- 插件详情页显示中文标题/描述与预览图（`locale/` + `docs/`，本轮新增）。

### 从源码跑测试

测试不在 npm 包的 `files` 列表里；在源码目录运行：

```powershell
node scripts/test.mjs          # 15 套 125 条，逐文件起独立进程
node scripts/test.mjs retry    # 只跑文件名含 retry 的
node scripts/check.mjs         # 静态自检：内联块同步、locale、package 接线、禁止裸 save
```

`npm test` 就是 `node scripts/test.mjs`。**不要用 `node --test`**：它用管道收集子进程
输出，DSH 沙箱里会 `EPERM`（本机复现过）；`scripts/test.mjs` 用 `stdio: 'inherit'`，
沙箱内外都能跑。

### 然后就能用了

在**任意一个主会话**里说一句：

```
用中台派个子任务：帮我把 XXX 做掉
```

模型会自己开批次、盘问用户、收敛、等用户批准。详见上面「[怎么触发](#怎么触发)」。

## 数据

台账在 `~/.dsh/middleman/designs/<batchId>.json`。一个批次一份，只存状态与引用，不存对话正文。

```jsonc
{
  "id": "D-20261102-3cxz",
  "status": "approved",          // grilling → converged → approved（批次无终态；closed 是 /state 派生量）
  "decisions": [ /* 设计树的每个决定 */ ],
  "questions": [ /* 问过用户的问题与答案，拆票前至少 3 个 */ ],
  "plan":      { "steps": "", "output": "", "parallel": "" },
  "risks":     [ /* 四栏齐全的风险 */ ],
  "spec":      { "goal": "", "nonGoals": [], "acceptance": [] },
  "tickets":   [ /* 工单，带 riskIds 与 model */ ]
}
```

## 模型怎么选

主会话按工单类型挑，必须写 `model: { provider, model }`；你在面板上能直接看出它选了什么。建议：

| 票的类型 | 倾向 |
|---|---|
| 调研、探索 | 便宜、快 |
| 架构、设计 | 最强 |
| 机械改动、重命名 | 便宜 |
| 验收、独立测试 | 和实现方**不同的**模型 |

最后一条：同一模型自己验自己，容易漏掉自己犯的错。

## 已知取舍

- **卡片只在实时渲染时存在。** 刷新会话后，对话流里那张批准卡是空的——宿主不把 toolview 的渲染结果持久化进会话事件。台账里的工单还在，面板里的动作也还在，所以活照跑，只是那张卡片不再复现。
- **`selectModel` 会改全局默认模型。** 启动前读、启动后恢复；恢复失败只记日志，不回滚启动。改模型那条路（`/retarget`）同样如此。
- **技能组合受限。** `/grill-with-docs`、`/to-tickets` 这些主流程技能是 `disable-model-invocation`，模型调不动。所以盘问逻辑内建在插件里，没有外包给技能。
- **面板用 `React.createElement`。** 不用 JSX，于是仓库里就是能直接装的那一份，不需要构建步骤；代价是写起来比 JSX 啰嗦。
- **浏览器半区必须按 DSH 的客户端模块协议注册**（`window.__ModuleLoader__.load({id, factory})`）。写成普通 ESM 导出 `apply`，宿主会当宿主插件装载，然后卡在「waiting for service: slots」——slots 是浏览器侧的服务。
- **`session/modelCatalog` 在 0.2.1-rc.5 上会抛** `Cannot read properties of undefined (reading 'aborted')`。所以模型目录直接从 `ctx.llm` 读，不走那条网关路径。
- **`inject` 必须列全。** 少一个服务会在运行时报 `cannot get property X without inject`，而不是启动时失败——所以 `inject` 有专门的测试盯着。
- **子会话历史走 `session/follow`，不走 `session/page`。** page 的 `throughSeq` 是「读到第几号事件」，猜错就抛 "past cursor"，猜成 -1 则永远是空数组——两种猜法都表现为「子会话一个字没说」。follow 自己报游标，不用猜。
- **HTTP 写操作没有幂等键。** `/run`、`/answer` 在「消息已送达、台账还没写回」之间被多标签页并发请求时，子会话可能收到第二条任务书或答复；面板按钮已经用 busy 防连点，但跨标签页仍无保护。
- **同一批次两张票几乎同时结算时，回传信封可能重复一次。** 投递状态与结算共用整批 CAS，冲突的一方会重投（最多 5 次），不会丢，但可能重复。
- **结算连续 CAS 冲突会退化成 warn**，等下一轮 turn/end 或重启对账；outbox 不主动补扫「running 且有未结算 turn」的票。
- **钉模型失败且宿主拒绝取消会话时，可能留下一个台账不知道的孤儿会话**；错误信息里带会话 id，但不会自动回收。
- **面板的批次列表只在挂载时拉一次**；展开的批次与对话卡片会轮询。要刷新列表就收起再展开面板。
- **`/feedback`、`/retarget`、`/models` 只有宿主端点，面板还没有入口**；追加意见/改模型目前要走工具或直接请求接口。

## 测试

十五套 125 条，用 `node scripts/test.mjs` 跑（也可以直接 `node test/<file>.test.mjs`）：

| 套件 | 条数 | 盯着什么 |
|---|---|---|
| `p0` | 8 | 合并语义、CAS、jsonSafe、`turn/end` 分类、outbox/信封 |
| `p1-host` | 6 | 草稿票、批准即开跑、空批次拒绝、CAS 拒绝、失败隔离、`middleman_inbox` |
| `p1-client` | 13 | `batchView`/`inboxView`/`dependencyView` |
| `status-report` | 3 | 取正文只回单票投影 |
| `p1-relay` | 22 | 依赖求值、并发、重启恢复、网络宽限、静默结算、信封去重、启动失败不重试 |
| `p1-rewire` | 6 | rewire/rebind、审计、索引代际 |
| `p1-run-guard` | 8 | `/run` 守卫、force 重跑、`closed`、批准失败票改 queued |
| `i01-receipt` | 10 | 回执自评、最终汇报、端到端结算 |
| `ledger-write` | 6 | rename 重试、临时文件清理、CAS、并发写串行 |
| `client-bundle` | 3 | 内联判断层与 `card-model.js` 逐字一致 |
| `retry` | 16 | 重试两族/额度/状态守卫、启动失败按 LAUNCH_FAILED 记报错族、两个入口 |
| `answer-cancel` | 5 | 主会话答 waiting 票、取消记 `lead_interrupted`、子会话不能调 |
| `write-race` | 1 | 回写不覆盖并发结算 |
| `reparent` | 5 | 换主会话改绑、子会话不能认领 |
| `security` | 13 | batchId 路径穿越、CSRF（Content-Type / Origin / Host 白名单）、请求体形状、/cancel 状态守卫、批准幂等、子会话调主会话工具被拒 |

所有测试使用假 dispatcher，不建真实会话、不耗额度。

## 安全边界

中台只在**本机回环**上开 HTTP 端点（`/middleman/api`），并在这条围栏之外再加三层：

1. **写操作只认回环 Host + `application/json` + 同源 Origin**：跨站表单发不出
   `application/json`；DNS rebinding 的恶意域名也过不了 Host 白名单
   （只接受 `127.0.0.1` / `localhost` / `[::1]`）。
2. **批次 id 只允许字母、数字、下划线与短横线**：id 会被拼进
   `~/.dsh/middleman/designs/<id>.json`，挡住 `..`、`/`、`\`、盘符，避免把
   「读一个批次」变成「读盘上任意 JSON 文件」。
3. **会改台账的工具只给主会话**：`design_*`、`middleman_rewire`、`middleman_rebind`
   对子会话一律回 `not-a-lead`。低信任仓库内容不能诱导子会话自己拆票、摘依赖边
   或触发计费会话。

面板仍然不信任台账内容：所有文本都经 React 渲染（无 `innerHTML`），台账里的坏字段
会退化成占位而不是白屏；`model: null` 也按「未定模型」显示。

## 许可

GPL-3.0（GNU General Public License v3.0，仅此版本）。Copyright (c) 2026 sylas。

这是自由软件：可以自由使用、修改与再分发；分发（包括修改版）必须以同一许可证
提供完整源码，且不提供任何担保。完整条款见 [LICENSE](LICENSE)。