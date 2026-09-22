# /tree 会话树导航(设计稿)

状态:设计完成,待独立设计审查 → 用户批准实现。

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
- `getTree()`:按 parentId 建树;`parentId===null || 自指 || 父缺失` → 根;
  子按 timestamp 排序;栈式(防深树爆栈)。
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
- `branchTo(entryId)`:switchBranch 的泛化——目标可为任意 entry;仍拒绝
  `tipId === leafId`(no-op 防误)与"目标在当前路径上"??**否**——pi 明确允许
  导航到当前路径上的任意点(回退自身路径=放弃后续,新分支从这里长)。
  仅保留:entry 必须存在、!== leafId。persistPosition 照旧。
  switchBranch(tip) 保留不动(/tree <n> 旧语义钉子),内部改薄为
  branchTo 的前置校验特例或直接保留。
- **label entry**:新 entry 类型 `{ type:"label", id, parentId, timestamp,
  targetId, label }`(parentId 挂当前 leaf——pi 亦如此,label 是会话流上的
  簿记 entry)。store 增 `appendLabelChange(targetId, label|undefined)` 与
  labelsById 重放(load 时逐行,后写胜,空 label=删)。**旧文件无 label entry
  天然兼容**;`/export`/resume/replay 不识别 label entry 时忽略(见 3.5)。
- `entriesToMessages` 侧:label entry 不产消息(buildContext 沿用现有 filter,
  显式跳过 label)。

TreeNode.label 来源:labelsById,而非 entry 本身(label entry 不进树——
pi 的 getTree 只收"内容 entry",label 在 _buildIndex 阶段已折进 nodeMap)。
**树节点 = 非 label entry**;这避免 label entry 以空描述节点出现在树里
(pi 树里 label entry 被 default 过滤,all 模式才显——imp 简化:永不显示,
理由:label 是注释不是内容,pi 的 all 模式面向调试)。

### 3.2 runner 层(src/runner.ts)

- `navigateTree(targetId, { summarize: boolean, customInstructions?: string })`:
  1. store 为 null → 抛;`targetId === leafId` → no-op 返回 `{ noop: true }`。
  2. 目标 entry 必须存在且**非 label entry**(label 不进树)。
  3. `editorText` 语义照 pi:目标是 user message → `newLeaf = target.parentId`、
     editorText=userText(target.message);否则 newLeaf=target。
  4. splitBranches **按 newLeaf** 计算 abandoned(不是按 target——用户消息
     重编辑路径上,target 本身也算被放弃;pi 的 collectEntriesForBranchSummary
     从 oldLeaf 收到 commonAncestor,与新 leaf 一致)。
     实现:store.splitBranches(newLeaf) 现成(它按 leaf 计路径)。
  5. summarize && abandoned 含 message → summarizeBranchSegment(现有,
     已带 thinking/abort?查:现签名无 signal,补 `{ signal }` 透传——
     pi 的摘要可 Esc 中止;imp 的 /tree 状态机在 compacting 态收 Ctrl+C,
     现走 abortActive() 通道,把 signal 传给 summarizeBranchSegment)。
     失败照旧 best-effort log+降级。
  6. branchTo(newLeaf) + 摘要时 appendBranchSummary(summary)。
  7. history 重建(buildContext),返回 `{ noop?, editorText?, summary:
     "written"|"empty"|"disabled"|"failed", messages }`。
  8. refreshSystemPrompt?——分支切换不改 cwd/tools,**不需要**;但摘要影响
     history 已重建。会话 store 不变(same store)。
- switchSessionBranch 保留(/tree <n> tip 语义)或内部改调 navigateTree
  (tip 无 editorText 场景——tip 是 message 时也有!统一走 navigateTree,
  行为严格超集:旧调用点 tips 都是 leaf!=target 的 message entry →
  editorText 会带出。**需要防回归**:旧 /tree <n> 语义是"切过去继续",
  不是"把 tip 的用户消息放回输入框"。**决策 D3**:switchSessionBranch
  保留独立实现;navigateTree 是新入口,/tree 树选择器专用。两路后续
  再合并(见 §6 判断点)。

### 3.3 树选择器组件(src/repl/components/tree-selector.ts,新)

自绘组件,不依赖 pi-tui 的 SelectList(平铺模型装不下树):
- 落地在 TuiShell.select 同款 overlay(askContainer + setFocus),接口
  `openTreeSelector({ tree, leafId, onSelect(entryId), onCancel() })`。
  归属:LineInput 增可选方法 `treeSelect?(options): Promise<string | null>`
  (entryId 或 null),与 select() 并列;shell.ts 实现,legacy 无此方法。
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
    - navigateTree → clearView + replay + note(含 editorText 回填:
      `ctx.setInput?.(editorText)`——LineInput 增可选 setInput,
      仅当输入框为空时回填,照 pi)
  - legacy(无 treeSelect):**树文本版**(连接符+缩进渲染成平铺行,
    编号 1..n),`/tree <n>` 用同序号。渲染函数与 TUI 组件共享
    (组件侧导出 buildTreeRows(tree, leafId, filter): Row[])。
- `/tree <n>`:序号=树渲染行序(不再只是 tip)——**行为变化**,旧语义
  (tip 列表序号)被取代;现有测试同步改。README/CHANGELOG 不存在,
  note 提示即可。
- 摘要进行中:state machine 已把 tree 归 compacting 态(:491),
  Ctrl+C → abortActive() → signal 传 summarizeBranchSegment →
  navigateTree 返回 aborted → note "summarization cancelled — branch kept"。
  **决策:中止摘要=中止整个导航**(pi 同——返回 cancelled 不切换)。
  简化差异:pi 中止后重开选择器;imp note+留在原分支(少一次 overlay
  嵌套;记录差异)。
- allowedDuringRun: false 照旧。

### 3.5 兼容与不动的面
- 旧会话文件:无 label entry → 正常;load 重放遇未知 type 前已如何?
  查 store.ts 解析——严格校验,未知 type 抛。**加 label 到 union 即可**,
  不存在"旧版 imp 读新文件"义务(单机工具)。
- replay/回放:label entry 跳过(不渲染、不产消息)。
- export(M19 候选)未存在,无面。
- /fork 不动(它与 /tree 导航到 user entry 最终会合流,批 B 评估)。
- summarizeBranchSegment 签名加可选 signal:向后兼容(可选参)。
- transcript.ts(折叠渲染)不涉。

### 3.6 测试
- store:getTree(单根/多根孤儿/时间排序/label 折叠/label entry 不入树)、
  branchTo(interior/root/null 父/自身=拒绝/position marker 落盘)、
  appendLabelChange+重放(后写胜/空=删/未知 target 容忍)、
  buildContext 跳过 label。
- runner:navigateTree(到 assistant entry=leaf=目标/到 user entry=父+editorText/
  摘要 written/empty/disabled/failed/aborted/当前 leaf no-op/history 重建
  与 buildContext 尊重新路径 compaction)。
- 组件:buildTreeRows 快照(连接符/缩进/折叠/过滤/搜索/活动路径/多根);
  keymap(↑↓ Enter Esc Tab f)。
- 集成:treeSelect 存在时命令流(mock resolve entryId)、legacy 文本树、
  /tree <n> 新序号语义、abort 流。

## 4. 规模与分批
- 批 A(本设计):store +~150、runner +~90、组件 +~330(含 buildTreeRows)、
  commands +~120、shell/input 接缝 +~60,测试 +~400 → **~1150 行**。
- 批 B(延后,记录):水平滚动、分支段跳转、label 编辑(l)、labeled-only/all
  过滤、treeFilterMode/skipPrompt 设置、/fork 合流、switchSessionBranch 统一、
  摘要中止后重开选择器。

## 5. 风险
- 树渲染的列宽/ANSI 处理抄 pi 的坑(gutter/截断用 visibleWidth,
  imp 已有 truncateToWidth 同源工具?查 shell.ts 用 pi-tui 的)。
- position marker 与 branchTo 的组合:navigateTree 写 position 后若摘要
  appendBranchSummary 又写 position?查 append() 现状——append 只 append entry,
  position 仅 switchBranch 显式写。branchTo 同样显式写一次,无重复。
- 深树性能:flatten O(n),搜索 O(n·子串),典型 <2k entry 无虞;
  pi 的 maxVisibleLines 窗口滚动照抄。

## 6. 判断点(需用户定夺)
1. **label 系统**:本批实现 entry 格式+树显示+labeled 树内搜索,编辑(l 键)
   延后批 B。还是连编辑一起做?(pi 的 label 在导航重会话时价值大;
   imp 用户可先用 export/手工编辑 jsonl?不——append-only,无手工路径。
   建议批 B 做编辑,但格式先行,避免日后格式迁移。)
2. **过滤模式砍到 3**(default/no-tools/user-only):pi 有 5。取舍见 3.3。
3. **/tree <n> 序号语义变更**(tip 列表→树行序号):破坏既有钉子(测试改),
   用户习惯变更。或保留 <n>=tip 序号,树内选择只走 TUI?
4. **switchSessionBranch 不统一**:两入口并存(旧 tip 切换/新树导航),
   行为差异(编辑器回填)记录在案。批 B 合流。
5. 摘要询问:三选照抄 pi(含 custom prompt),IMP_BRANCH_SUMMARY=0 时
   直接 No(不询问)。还是 0 也询问只是默认 No?(建议前者=现状语义)。
