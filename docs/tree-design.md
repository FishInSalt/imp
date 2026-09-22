# /tree 会话树导航(设计稿)

状态:已实现(设计审查闭环后用户批准;实现审查待跑;测试 1075→1101)。设计审查记录见 §7。

## 0. 背景与目标

imp 已有简版 `/tree`(M10 #10 batch 2):**平铺的其他分支 tip 列表** + 可选摘要切换。
pi 的 `/tree` 是完整的**会话树可视化导航器**。本批把 imp 的 /tree 升级到 pi 形态:
树形渲染、任意节点导航、过滤/搜索/折叠、分支摘要询问。

pi 参考坐标(全部亲读核实):
- `packages/coding-agent/src/core/session-manager.ts` — getTree(:1324)/branch(:1371)/
  branchWithSummary(:1393)/label entries(:983,_buildIndex 增量重放)/_rewriteFile(:1000 迁移)
- `packages/coding-agent/src/core/agent-session.ts:3136-3330` — navigateTree 全流程
- `packages/coding-agent/src/modes/interactive/components/tree-selector.ts`(1427 行)— TUI
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5205-5335` — 命令接线+摘要询问
- `packages/agent/src/harness/runtime/` — pi 的持久化操作机(admission/drive),imp 无需对应物

## 1. pi 机制核实结论(事实基线)

### 1.1 数据模型
- 会话文件 append-only **树**:每 entry 有 `id`/`parentId`/`timestamp`;`leafId` 是
  "当前写位置"指针,load 时=文件最后一个 entry(_buildIndex)。
- `branch(branchFromId)`:**只移 leafId**。下一次 append 成为目标 entry 的 child,
  新分支自然形成;什么都不删除。目标可为任意 entry(含 root 之上 resetLeaf)。
  **审查修正(§7 P1-5)**:pi 的 appendLabelChange 同样推进 leaf,label entry
  是普通链节点(getTree 建节点,分支时 re-chain 子树)——imp 有意不采用
  此形状(见 3.1)。
- `getTree()`:按 parentId 建树;`parentId===null || 自指 || 父缺失` → 根
  (**自指规则照抄**,pi :1335);子按 timestamp 排序;栈式(防深树爆栈)。
  环状 parentId(a→b→a)不会使 getTree 死循环(map 建树不走父链),但
  会使 imp 既有的 getBranch 死循环——既有问题、出范围,此处记录防止
  有人在 getTree 里“顺手修”。
- **label entry**(`type:"label", targetId, label`):append-only 地给任意 entry
  加/删注记;`label:""` = 删除。_buildIndex 重放时维护 labelsById(后写胜)。
- label 可附在 summary entry 上(摘要后自动加 label)。

### 1.2 navigateTree 语义(agent-session.ts:3136)
1. 前置:流中/压缩中拒绝;`targetId === leafId` → no-op。
2. 摘要来源:扩展 session_before_tree 可接管/取消;否则内置 summarizer,
   自定义指令、reserveTokens、专用 AbortController(Esc 可中止摘要)。
3. **editorText 语义(关键,差点漏)**:
   - 目标是 **user message entry** → `newLeafId = target.parentId`(**不是** target),
     该用户消息的文本**回到输入框**可改——重新编辑此轮。下次提交以改后文本
     重新 append(旧轮留在原分支)。
   - 目标是其他 entry → `newLeafId = targetId`。
4. 摘要 entry 落在**新位置头**(branchWithSummary),fromId 记旧 leaf;可附 label。
   无摘要时:newLeafId===null → resetLeaf,否则 branch。
5. `agent.state.messages = buildSessionContext().messages` 重建;session_tree 事件。

### 1.3 TUI(TreeSelectorComponent)
- 渲染:光标 `› ` + `├─/└─/│` 连接符(每层 3 字符)+ `[label] ` + 单行描述
  (user: 文本 accent / assistant: 文本 / 工具调用名+参数摘要 / compaction /
  branch summary / title);活动路径节点前置 `• `;多根时虚拟根(根降一层)。
- **5 过滤模式**循环(default→no-tools→user-only→labeled-only→all):
  default 藏 label/model_change/thinking_level_change/session_info/custom entry、
  藏纯工具调用无文本的 assistant(错误/中止除外)、当前 leaf 永远显示;
  no-tools 再去 toolResult;user-only 只剩 user;all 全显。
- 打字即搜(子串,匹配 label+role+内容),backspace 删,Esc 先清搜索再退出。
  **审查修正(§7 P2-3)**:"当前 leaf 永远显示"在 pi 仅对纯工具 assistant
  豁免规则成立;settings entry 与 no-tools 的 toolResult 仍藏当前 leaf——
  imp 取绝对规则(见 3.3)。
- 折叠 ⊟/⊞:方向键在可折叠节点上=折叠/展开,否则=跳到上/下分支段起点。
- 水平视口:选中行锚点(内容起点)若挤出右侧则 body 整体左移,gutter 固定。
- l 键编辑 label(内嵌 Input);复制键;label 时间戳开关。
- 底部 `(i/n) [filter]` 状态行。
- 选择流程:当前 leaf → "Already at this point";否则 select 摘要三选
  (No summary / Summarize / Summarize with custom prompt,可设 skip-prompt
  直接默认 No)→ custom prompt 走内嵌编辑器 → 停流 → navigateTree →
  清屏重放 + editorText 回填(仅当输入框为空)→ 摘要中止/取消各回树选择器。

### 1.4 设置
treeFilterMode(默认过滤模式)、branchSummarySkipPrompt —— pi 在 settings.json。

## 2. imp 现状与差距

已有:
- store 层树基座完整:parentId/leafId/**position marker(pi 没有,imp 更强)**/
  getBranch(任意 leaf)/splitBranches/switchBranch(**仅 tip**)/appendBranchSummary/
  buildContext(沿路径找最近 compaction)。
- `/fork`(userForkPoints→forkBefore)≈ pi 的"导航到用户消息重编辑"(但直接切,
  无摘要、文本不回输入框)。
- `/tree` 简版:其他 tip 平铺列表,select 选择或 `/tree <n>`,切换+可选摘要
  (IMP_BRANCH_SUMMARY=0 禁),clearView+replay+note。
- TuiShell select():SelectList+filterable 平铺选择器;ask()/secret() 可复用。

缺失:树渲染选择器、任意节点导航(interior)、label 系统、过滤模式/搜索/折叠/
水平滚动、摘要三选 UI、skip-prompt/默认过滤设置、editorText 回填。

## 3. 设计

### 3.1 store 层(src/core/session/store.ts)

新增:
- `getTree(): TreeNode[]` — `{ entry, children, label? }`;照 pi 语义(孤儿当根、
  子按 timestamp、栈式);label 解析规则见下。
- `branchTo(entryId: string | null)`:switchBranch 的泛化——目标可为任意
  entry;**null = resetLeaf 语义**(回到任何 entry 之前,重编辑首条消息;
  审查 P1-2);仍拒绝 `entryId === leafId`(no-op 防误)。**允许目标在
  当前路径上**(回退自身路径=放弃后续,新分支从这里长;store 的
  switchBranch"on the current branch"拒绝仅对 tip 语义有意义,branchTo
  不继承)。persistPosition 照旧。
  switchBranch(tip) 随 switchSessionBranch 一并删除(零调用点)。
- **label entry**:新 entry 类型 `{ type:"label", id, parentId, timestamp,
  targetId, label }`。**appendLabelChange 不移动 leafId**(审查 P1-5 修正:
  pi 的 appendLabelChange 会推进 leaf 且 getTree 把 label 当普通链节点、
  分支时需 re-chain;imp **有意偏离**——label 是纯簿记旁挂,用不推进
  leaf 的裸 append 写入,parentId=当时 leaf)。由此 label entry 永远不在
  任何内容 entry 的父链上:getBranch 天然不经过、getTree 排除后无孤儿
  子树、buildContext 跳过。**与 pi 的差异记录在案**(代价:label 与
  分支无关,文件级全局,见 §7 P1-5 论证;pi 的 label 会随分支消失,
  imp 不会——导航场景 label 是定位注记,文件级更符合直觉)。
  store 增 `appendLabelChange(targetId, label|undefined)` 与 labelsById
  重放(load 时逐行,后写胜,空 label=删;**重放不区分 label entry 在
  哪条链上**——文件级语义)。**旧文件无 label entry 天然兼容**;
  `/export`/resume/replay 不识别 label entry 时忽略(见 3.5)。
- `entriesToMessages` 侧:label entry 不产消息(buildContext 沿用现有 filter,
  显式跳过 label)。

TreeNode.label 来源:labelsById(文件级,重放后写胜);**树节点 = 非 label
  entry**。由于 label 永不在内容链上(3.1 的旁挂设计),排除它们不会产生
  pi 那种孤儿子树问题(pi 需 re-chain,imp 不需要)。pi 的 all 过滤模式把
  label entry 显示为节点——imp 不做(理由:label 是注释不是内容;all 模式
  面向调试且本批不实现)。

### 3.2 runner 层(src/runner.ts)

- `navigateTree(targetId, { summarize: boolean, customInstructions?: string })`:
  1. store 为 null → 抛;`targetId === leafId` → no-op 返回 `{ noop: true }`。
  2. 目标 entry 必须存在且**非 label entry**(label 不进树)。
  3. `editorText` 语义照 pi:目标是 user message → `newLeaf = target.parentId`、
     editorText=userText(target.message);否则 newLeaf=target。
  4. 摘要集合 **= `store.splitBranches(targetId).abandoned`**(审查 P1-1 修正:
     pi 的 collectEntriesForBranchSummary 以 **target** 求公共祖先、从旧 leaf
     收到祖先**不含**——即"目标之后的一切";重编辑场景 target=用户消息
     被排除在外,正好回输入框。splitBranches(newLeaf) 会把被重编辑的消息
     也算进摘要集,与 pi 不符。splitBranches(targetId) 在全情形与 pi 等价:
     target 在当前路径上→祖先=target 自身;target 在他枝→祖先=分叉点。)。
     **注意次序**:splitBranches 必须在 branchTo **之前**算(照现 switchSessionBranch)。
  5. summarize && abandoned 含 message → summarizeBranchSegment(**现有
     signal 参数**——审查 P2-1:签名已支持,勿重复加;abort 时它 throw
     "branch summary: summarizer aborted",**catch 里先查 signal.aborted**:
     abort → 返回 `{ aborted: true }`,不 branchTo、不切、不算 failed——
     中止=中止整个导航(pi 同语义);真失败照旧 best-effort log+降级切换)。
  6. `branchTo(newLeaf)`(**审查 P1-2:newLeaf 可为 null**——目标是根路径上
     的首条用户消息时 parent=null;null 语义=resetLeaf,position marker
     写 `{type:"position",leafId:null}`,forkBefore 先例)+ 摘要时
     appendBranchSummary(summary)(parentId=newLeaf,可能为 null →
     summary 成为新根;此后用户 append 挂 summary 下——pi 同形)。
  7. **身份守卫**(审查 P2-2,照 switchSessionBranch :672-679):await 后
     `this.sessionStore !== store` → 返回 failed,不 append 不重建。
  8. history 重建(buildContext),返回 `{ noop?, aborted?, editorText?,
     summary: "written"|"empty"|"disabled"|"failed", messages }`。
  9. refreshSystemPrompt?——分支切换不改 cwd/tools,**不需要**;但摘要影响
     history 已重建。会话 store 不变(same store)。
- **switchSessionBranch 统一进 navigateTree**(审查 P1-4 消解:设计原稿
  D3 保留旧入口与 §3.4 序号变更自相矛盾)。navigateTree 是旧行为的严格
  超集:tip 是非 user entry 时行为与旧 switchSessionBranch 完全一致;
  tip 是 user message 时多出 editorText(pi parity,正是树导航要的语义)。
  旧方法删除,`/tree <n>` 全部走 navigateTree;既有 tip 语义测试随行为
  变更同步改(约 9 例,见 §7 判断点 3)。

### 3.3 树选择器组件(src/repl/components/tree-selector.ts,新)

自绘组件,不依赖 pi-tui 的 SelectList(平铺模型装不下树):
- 归属:LineInput 增可选方法 `treeSelect?(options): Promise<string | null>`
  (entryId 或 null),与 select() 并列;shell.ts 实现,legacy 无此方法。
  **生命周期照 select() 全套契约**(审查 P2-6):注册为 this.selector
  (`{teardown, filterKey}`)——预监听器把 Ctrl+C 路由进组件、吞 Ctrl+D、
  隐藏 placeholder、SIGINT/close teardown、并发 picker 排队 pendingSelects。
  不注册则 Esc/Ctrl+C 漏到状态机中断路径、SIGINT 悬挂 overlay。
- 渲染(批 A):光标、`│ ├─ └─` 连接符、活动路径 `•`、`[label]`、
  单行描述(user/assistant/工具名/compaction/branch summary/session_info→title)、
  底部 `(i/n)`。
- 描述文本复用/抽自现有:otherBranchTips 的 shorten、replay 的入口——
  新增 `describeEntryForTree(entry): string`(store.ts 或组件侧;
  **组件侧**,store 保持纯数据)。
- 交互(批 A):↑↓、Enter(选择)、Esc(先清搜索再退出)、打字搜索
  (子串,匹配 label+role+描述)、backspace、Ctrl+C=Esc。
- 过滤模式(批 A 收敛为 3):default(藏 label/非内容 entry、藏纯工具
  assistant、当前 leaf 恒显)/ no-tools(再藏 toolResult message)/
  user-only。Tab 循环,底部状态行显示 `[no-tools]`。
  **“当前 leaf 恒显”对全部三模式绝对生效**(审查 P2-3 定夺:pi 仅对
  纯工具 assistant 规则豁免当前 leaf,no-tools 下 toolResult 叶子仍被藏;
  imp 取绝对规则——更强、心智更简,避免“切完分支树里看不到自己”)。
  **砍 labeled-only/all**(无 label 编辑时不自洽;all 面向调试)。
- 折叠(批 A 简化):f 键折叠/展开选中节点子树(独立键,不占用方向键的
  分支段跳转语义——**分支段跳转砍掉**,pi 的方向键双语义是可发现性负担)。
  折叠时连接符中段显示 `⊟`/`⊞`。
- 水平滚动(批 A 简化):不实现——行超宽直接截断(visibleWidth 截断,
  搜索高亮不跨行)。理由:3 字符/层+折叠兜底,典型会话 <8 层;
  pi 的锚点视口 60 行代码换低频收益。**记录为批 B 候选**。
- 多根(imp 可能吗?position marker/异常文件可致孤儿):孤儿当根,
  多根时降一层显示+顶部 `· roots: n` 一行(照 pi 虚拟根思路)。
- label 编辑(批 B):l 键 → secret()-风格内嵌输入;skip-prompt、
  treeFilterMode 设置(批 B,settings.json)。

### 3.4 命令层(src/repl/commands.ts)

- `/tree`(无参):
  - TUI:treeSelect 选择 entry →
    - === 当前 leaf → note "already at this point"
    - 否则 select 三选("Summarize the left branch?"→ No summary /
      Summarize / Summarize with custom prompt;IMP_BRANCH_SUMMARY=0 时跳过
      询问直接 No);custom → secret() 风格输入;Esc 中断回树选择器
    - navigateTree → clearView + replay + note(含 editorText 回填)
  - editorText 回填(**审查 P2-5:复用现有 setText/getText 接缝**,绑进
    CommandContext,不新增 setInput):仅当输入框为空时 setText,照 pi;
    **非 TUI(legacy/print)无编辑器**——以 note 打印截断文本
    (`▪ back in editor: “…”`,/fork preview 先例),文本不静默丢失。
  - **摘要中止通道(审查 P1-3)**:摘要 await 前创建 AbortController,
  `ctx.onLongOpAbort(controller)`(/login 先例,repl.ts:1192),完成后
  `ctx.onLongOpAbort(null)`;controller.signal 传 summarizeBranchSegment。
  compacting 态 Ctrl+C → longOpAbort.abort() → summarizer throw →
  navigateTree 查 signal.aborted → 返回 aborted → note "summarization
  cancelled — branch kept"。**不走 abortActive()**(那是 run 控制器,
  命令态下为 null,原稿有误)。
- `/tree <n>`(legacy 与 TUI 通用):序号=树渲染行序(default 过滤后),
  走 navigateTree。legacy 无交互询问通道 → summarize=branchSummaryEnabled
  (现 /tree <n> 同语义:能捕就捕);editorText 以 note 打印。树渲染函数
  与 TUI 组件共享(组件侧导出 buildTreeRows(tree, leafId, filter): Row[])。
  序号语义变更(tip 序号→树行序号)随 P1-4 统一一并生效。
- allowedDuringRun: false 照旧。

### 3.5 兼容与不动的面
- 旧会话文件:无 label entry → 正常;load 重放遇未知 type 严格校验抛出
  (已核实)。**加 label 到 union + parseEntryLine 分支即可**,
  不存在"旧版 imp 读新文件"义务(单机工具)。
- replay/回放:label entry 跳过(不渲染、不产消息)。
- export(M19 候选)未存在,无面。
- /fork 不动(它与 /tree 导航到 user entry 最终会合流,批 B 评估)。
- summarizeBranchSegment 已有 signal 参数(§7 P2-1),仅接线不加签名。
- transcript.ts(折叠渲染)不涉。

### 3.6 测试

(合并入 §8,含审查增补项。)

## 4. 规模与分批
- 批 A(本设计;审查 P3 上调组件估算):store +~150、runner +~130、
  组件 +~550(flatten/gutter/过滤/搜索/折叠/窗口滚动+buildTreeRows,
  参照 pi 同子集约其体量一半)、commands +~140、shell/input 接缝 +~80,
  测试 +~450 → **~1500 行**。
- 批 B(延后,记录):水平滚动、分支段跳转、label 编辑(l)、labeled-only/all
  过滤、treeFilterMode/skipPrompt 设置、/fork 合流、摘要中止后重开选择器。
  (switchSessionBranch 统一已提前入批 A,见 §7 P1-4。)

## 5. 风险
- 树渲染的列宽/ANSI 处理抄 pi 的坑(gutter/截断用 visibleWidth,
  imp 已有 truncateToWidth 同源工具,shell.ts/tui.ts 已用)。
- position marker 与 branchTo 的组合:append 只 append entry,position 仅
  branchTo 显式写一次。**重开规则**(审查 P3 补测):branchTo 写 position→
  摘要 appendBranchSummary 追加 entry→重开时 leaf=文件末 entry(摘要),
  与内存态一致,但需测试钉住此交互。
- 深树性能:flatten O(n),搜索 O(n·子串),典型 <2k entry 无虞;
  pi 的 maxVisibleLines 窗口滚动照抄。

## 6. 判断点(审查后定夺,待用户确认)
1. **label 系统**:批 A 只做格式+旁挂写入 API+树显示/搜索,编辑(l 键)
   批 B。审查意见:同意,但格式形状(P1-5 旁挂不进链)必须现在钉死。
2. **过滤模式砍到 3**:审查同意;当前 leaf 恒显取绝对规则(强于 pi)。
3. **/tree <n> 序号语义变更**(tip 序号→树行序号):审查建议变更并统一
   走 navigateTree(P1-4 消解),非 TUI 下 editorText 以 note 打印。约 9 例
   既有测试随行为变更改(repl-commands ~7、repl-tui ~2)。
4. **switchSessionBranch 统一**(原“并存”方案废弃):navigateTree 严格
   超集,旧方法删除。审查推荐现在合,避免两套摘要/中止路径双维护。
5. 摘要询问:三选照抄 pi(含 custom prompt);IMP_BRANCH_SUMMARY=0 时
   直接跳过询问(不捕要),即现状语义;legacy `/tree <n>` 能捕则捕(无
   交互通道,同现状)。

## 7. 独立设计审查记录(fresh-context reviewer,审查后逐项亲自核实)

判 needs-fixes:5 P1+6 P2+多 P3;事实核查 21/24 pi 断言、12/12 imp 断言
成立(3 处 pi 断言被驳,见 P1-1/P1-5/P2-3)。全部采纳:
- **P1-1 摘要集合等价性错误**:"splitBranches(newLeaf)≡pi"不成立——亲读
  branch-summarization.ts:108-141 确认 pi 以 target 求祖先且不含 target,
  重编辑场景下我的算法会把回编辑器的消息也捕进摘要。改
  splitBranches(targetId)(全情形等价)。
- **P1-2 branchTo 缺 null 语义**:重编辑首条用户消息时 newLeaf=null,
  原设计无法表达(pi resetLeaf)。branchTo 接受 null。
- **P1-3 中止通道错误**:abortActive() 是 run 控制器、命令态下为 null,
  原设计的中止链路是哑的;且 summarizeBranchSegment 已有 signal 参数
  (P2-1)、abort 会 throw 被误归为 failed 继续切换。改 onLongOpAbort
  (/login 先例)+ signal.aborted 区分中止/失败。
- **P1-4 内部矛盾**:D3 保留旧入口 vs §3.4 序号变更互斥。定夺:统一走
  navigateTree,switchSessionBranch 删除。
- **P1-5 label 形状自相矛盾且错误描述 pi**:“parentId 挂当前 leaf(pi 亦
  如此)”与“pi getTree 只收内容 entry”均被驳——pi 的 label 推进 leaf、
  是链节点、分支时 re-chain。imp 改旁挂不进链(有意偏离,差异记录)。
- **P2×6**:signal 已存在(勿重复加)、navigateTree 补身份守卫、当前
  leaf 恒显范围定为绝对、legacy 无询问通道/editorText 以 note 打印、
  复用 setText/getText 而非新增 setInput、treeSelect 必须照 select()
  全套生命周期契约注册。
- **P3**:事实基线修正(§1.1/§1.3)、自指根规则/环状链注释、editorText
  丢图像记录(文本块拼接,图像无贡献;UI 提示 text only)、规模上调
  (§4)、测试补:position-marker×摘要重开序、abort-vs-failed、回填仅
  空编辑器、label 旁挂在 getTree、legacy note、IMP_BRANCH_SUMMARY=0。
- **非目标显式声明**(审查 P3):不移植 pi 的 session_before_tree 扩展
  接管、navigateTree 的 label 参数;branchSummary entry 仍无 fromId。

## 8. 测试计划(增补审查项)
- store:getTree(单根/多根孤儿/时间排序/label 折叠/label entry 不入树/
  **自指根**)、branchTo(interior/root/**null**/自身=拒绝/position marker
  落盘/**与摘要 append 的重开序**)、appendLabelChange+重放(后写胜/
  空=删/**旁挂不进链不推进 leaf**)、buildContext 跳过 label。
- runner:navigateTree(到 assistant entry=leaf=目标/到 user entry=
  父+editorText/**首条消息 newLeaf=null**/摘要 written/empty/disabled/
  failed/**aborted(不切不算 failed)**/当前 leaf no-op/身份守卫/
  history 重建与 buildContext 尊重新路径 compaction)。
- 组件:buildTreeRows 快照(连接符/缩进/折叠/过滤/搜索/活动路径/
  多根/当前 leaf 恒显跨三模式);keymap(↑↓ Enter Esc Tab f)。
- 集成:treeSelect 存在时命令流(mock resolve entryId)、legacy 文本树、
  /tree <n> 树行序号、**摘要中止流(longOpAbort)**、editorText 回填仅
  空编辑器、legacy note 打印。
