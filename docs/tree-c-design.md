# /tree 批 C:打磨池收官(打开定位/翻页/段跳转/水平视口/中止重开/复制)

状态:已实现;实现审查闭环(1 P1+1 P2+5 P3,见 §7);测试 1127→1138。

前置:`docs/tree-design.md`(批 A)、`docs/tree-b-design.md`(批 B,均已在 main)。
本批是批 A 设计 §4 延后清单的收官:原 7 项中批 B 交付 4 项,本批交付剩余 3 项
(摘要中止后重开选择器、水平滚动、分支段跳转)+ 沿途记录的小项(打开时选中
当前位置、翻页、复制键)。**用户裁定:#7 label 时间戳不做**;每模式专用过滤键、
Shift+Tab 反向循环维持"永不做"(批 B 非目标,键位预算)。

## 0. pi 机制核实记录(亲读,2026-02-09)

| 机制 | pi 位置 | 行为 |
|---|---|---|
| 打开定位 | tree-selector.ts:132,143-145 | 构造器 `targetId = initialSelectedId ?? currentLeafId`;`findNearestVisibleIndex`:目标不在当前过滤的可见行里则**沿 parent 链上溯**到最近可见祖先;空树 0;兜底**最后一行** |
| 窗口模型 | tree-selector.ts:672-678 | **每次渲染把选中行居中**:`start = max(0, min(sel − floor(vis/2), len − vis))`(不是"仅当出窗才跟随") |
| 翻页 | tree-selector.ts:1018-1023 | `left`/`pageUp` → `sel = max(0, sel − vis)`;`right`/`pageDown` → `min(len−1, sel + vis)`;**夹紧不回绕**(pi 的 ↑↓ 回绕;imp 的 ↑↓ 夹紧是批 A 既有**未记录偏离**——本批不随 D3 改,记录在案) |
| 段跳转键 | keybindings.ts:150-157 | darwin `alt+left`+`ctrl+left` = foldOrUp;`alt+right`+`ctrl+right` = unfoldOrDown |
| foldOrUp 语义 | tree-selector.ts:1002-1009 | 选中节点**可折叠且未折** → 折;**否则**(含已折!)→ `findBranchSegmentStart("up")` |
| isFoldable | tree-selector.ts:1105-1117 | **可见**子 >0 **且**(无可见 parent=根,**或**可见 parent 的可见子 >1)——只在分支点/根可折,链中不可折 |
| 可见结构图 | tree-selector.ts:430-456,555-556 | visibleParent/visibleChildren 按**最近可见祖先**收养(过滤藏掉中间层时,后代挂到最近可见祖先;`findVisibleAncestor` 沿**原始** parent 链上溯) |
| unfoldOrDown 语义 | tree-selector.ts:1010-1017 | 已折 → 展;否则 → `findBranchSegmentStart("down")` |
| 段起点算法 | tree-selector.ts:1125-1153 | down:沿首子链下行,遇**可见子 >1** 的节点 → 其首子的下标;单子链走到叶 → 停。up:沿可见 parent 上行,遇**可见子 >1** 的祖先:若当前段的起点在选中行上方 → 返回它;否则继续上行;到根 → 当前下标 |
| 水平视口 | tree-selector.ts:46-92 | **自动平移**(无手动键):gutter(光标列,宽 2)恒显;仅当选中行 anchor(正文起始列)超出 `viewportWidth − minVisibleAnchorContentWidth`(min=4,max=20,`viewportWidth/3` 夹中间)时,全体 body 左移 `anchorCol − anchorContextWidth`(context 2–12,`viewportWidth/4` 夹中间,上限 maxHorizontalScroll);body 切片用 `sliceByColumn(body, scroll, viewportWidth, true)` |
| anchorCol | tree-selector.ts:746-752 | `prefixPart = dim(prefix) + foldMarker + pathMarker`;**anchor = prefixPart 宽**(label 算正文,不算前缀);`bodyWidth = visibleWidth(body)` |
| 中止重开(两处) | interactive-mode.ts:5243-5246, 5298-5302 | ①三选 Esc → `showTreeSelector(entryId)`(**同一 entry 预选**);②`result.aborted` → status "Branch summarization cancelled" + `showTreeSelector(entryId)`。①imp 批 A 审查 P2 已做(循环);②未做——本批补 |
| 复制键 | keybindings.ts:130-133, tree-selector.ts:1029-1030 | `ctrl+x` → `copySelected()` |
| 复制文本提取 | tree-selector.ts:896-920 | message:bashExecution→command;有 content → 全部 text 块(`extractFullContent`);assistant 空文本回落 errorMessage。custom_message→`extractFullContent(entry.content)`;**compaction/branch_summary**→summary。**空(trim 后)→ undefined** |
| 复制接缝 | interactive-mode.ts:5338-5349 | `onCopy(text)`:undefined → showError "Selected entry has no text to copy";否则 `copyToClipboard` → status "Copied selected message to clipboard";异常 → showError |

## 1. 目标与非目标

**目标**(编号沿用盘点答复)
1. **#4 打开定位**:选择器打开时光标落在**当前 leaf**(或指定的 initialSelectedId);
   被过滤遮住时上溯最近可见祖先。窗口改 pi 的**居中模型**。
2. **#5 翻页**:←/→/PgUp/PgDn 整窗移动,夹紧不回绕。
3. **#3 分支段跳转**:alt+←/→(与 ctrl+←/→ 同绑,pi darwin 默认)foldOrUp/
   unfoldOrDown 双语义 + findBranchSegmentStart。
4. **#2 水平视口**:照抄 pi 的 renderHorizontalViewport(自动平移,anchor 驱动)。
5. **#1 中止重开**:navigateTree 返回 aborted 后,选择器带 initialSelectedId 重开
   (numbered/legacy 路径不变,只 note);三选 Esc 的重开**升级为同 entry 预选**。
6. **#6 复制**:ctrl+x 复制选中条目全文(text 块/summary/工具输出)到剪贴板。

**非目标**:label 时间戳(用户裁定不做);每模式专用键、Shift+Tab 反向(永不做);
键位可配置(imp 无 keybindings 注册表,继续硬编码 matchesKey);pi 的 TreeHelp
帮助面板(状态行一行提示维持);`f` 折叠键保留(imp 自有,与 alt+方向并存)。

## 2. 设计

### D1 — 组件侧原始 parent 图(#3/#4 的数据基础;审查 P1-1/P1-2/P2-2 修订)

**TreeRow 不改**。组件构造器遍历 roots 一次,建 `rawParent: Map<id, parentId|null>`
(全树原始父子,不看过滤)——D2 的上溯定位与 D4 的可见结构图都从它出发
(pi 的 entryMap 同构,pi:158-162)。过滤语义所需的"可见收养"在 D4 用它推导。

### D2 — 打开定位(#4)

构造器尾部:`selected = findNearestVisibleIndex(initialSelectedId ?? leafId)`。
- 目标 id 命中当前行集 → 其下标;
- 未命中(被过滤/折叠遮住,或重开时 id 已消失)→ **沿 D1 的 rawParent 链上溯**
  最近**可见**行(目标自身无 TreeRow 也可走——这就是不能靠 TreeRow.parentId 的
  原因,审查 P2-2);
- 行集空 → 0;兜底 `rows.length − 1`(pi 同)。
`rows()` 依赖 `this.mode`(initialFilterMode)——定位在 mode 赋值之后。
**窗口模型随之改**:删 scrollOffset 状态,render 每次按
`start = max(0, min(selected − floor(vis/2), len − vis))` 居中(pi:672-678)。
理由:①pi 对齐;②删状态更简单;③翻页(#5)落点天然居中。批 A 的"跟随滚动"
是一次有意的未记录简化——本批修正,注意现有测试若有钉窗口起点者需改。
注意:行集尾部时窗口被夹到 `[len−vis, len)`,选中行是**末行而非几何居中**——
测试要用**中部**行钉居中(审查 P2-1),尾部两种模型渲染相同。

### D3 — 翻页(#5)

handleInput 增两支(在 ↑↓ 之后):
`matchesKey(data,"left") || matchesKey(data,"pageUp")` → `selected = max(0, selected − vis)`;
`matchesKey(data,"right") || matchesKey(data,"pageDown")` → `selected = min(len−1, selected + vis)`。
KeyId 字面量是**驼峰** `"pageUp"`/`"pageDown"`(pi-tui keys.d.ts SpecialKey;审查 P3-3)。
夹紧、不回绕、不清查询不清折叠。PgUp/PgDn 序列(`\x1b[5~`/`\x1b[6~`)由
pi-tui 的 matchesKey 解析(与 ↑↓ 同一解析器,实现时以单测钉序列)。
嵌套 labelEdit 输入照旧全吞。

### D4 — 分支段跳转(#3)

`alt+left || ctrl+left` → foldOrUp;`alt+right || ctrl+right` → unfoldOrDown(pi darwin
defaultKeys 双绑)。语义**逐行照抄 pi**:
- foldOrUp:`foldable && !folded.has(id)` → `folded.add` + clamp;否则 findBranchSegmentStart("up")。
- unfoldOrDown:`folded.has(id)` → delete + clamp;否则 findBranchSegmentStart("down")。
**可见结构图(审查 P1-1 修订)**:先按行集建两图——
- `visibleParent: Map<id, 最近可见祖先|null>`:沿 D1 的 rawParent 链上溯,跳过被
  过滤/折叠藏掉的中间层,落到首个在行集里的祖先(pi `findVisibleAncestor`,430-456);
- `visibleChildren: Map<parent, 可见子行[]>`:按行序(=active-first 序)分组收养。
**不能用裸 parentId 分组**:默认模式藏掉无文本 assistant 后,工具行 `t1` 不在行集,
其子 `after/r1` 必须收养到可见祖先 `q1` 下——裸分组会让 down 在 `q1` 处死停
(组空),up 走进无行的 id 断链(pi 特意为此建收养图,审查 P1-1 实锤)。
段起点算法(pi:1125-1153,在两图上):
- down:自选中 id 起,`children = visibleChildren(id)`;空 → 停(当前下标);
  **>1 → 首子下标**;恰 1 → 下行。首子 = 组内第一行(pi 也 active-first,同序)。
- up:沿 visibleParent 上行;每到一个 parent 其组 >1:若当前 id 的下标 < selected →
  返回该下标;否则继续上;parent null → 停。
**foldOrUp 的"可折"判定用 pi 的 isFoldable(审查 P1-2 修订)**:
`visibleChildren(id).length > 0 且 (visibleParent(id) 为 null 或 其组 >1)` ——
只在**分支点/根**可折,链中行不可折(alt+← 在链中行上是跳段首,不是折叠)。
`f` 键维持批 A 现语义(任意行切换折叠集,渲染 children>0 才生效)——imp 自有键,
与 pi 无对应物,记录为既有偏离;alt+←/→ 的语义则与 pi 完全一致。
折叠加 clampSelection(行数会缩);跳转后无 clamp 必要(下标必在界内)。

### D5 — 水平视口(#2)

照抄 renderHorizontalViewport(pi:46-92)+ 五常量(gutter 宽 2、anchor 可见宽
4–20(/3)、anchor 上下文 2–12(/4))。imp 行构成:`gutter = "› "/"  "`;
`body = dim(prefix) + "• "(active path) + "[label] "(有则) + text + "  ◂"(leaf)`;
`anchorCol = visibleWidth(dim(prefix) + marker)`——**label 归正文**(pi:746-752,
prefixPart 不含 label)。每行 `bodyWidth = visibleWidth(body)`。
渲染:选行 anchor 超界 → 全体 body `sliceByColumn(body, scroll, viewportWidth, true)`
(pi-tui 已导出,tui.ts 转口补一项)+ `\x1b[0m` 收尾,gutter 恒显;最后
`truncateToWidth(line, width)`。反选样式维持(整行包 `\x1b[7m`,内部 ANSI 不动)。
状态行不进视口(单行,truncate)。窄端+深缩进才有平移;典型 ≤8 层会话不可见。

### D6 — 中止重开(#1)

/tree 的 picker 路径改两层循环(批 A 已有内层三选循环):
```
for (;;) {
  picked = await ctx.treeSelect({ roots: session.getTree() /* fresh */, leafId,
      initialFilterMode, initialSelectedId: reopen ?? undefined, onLabelChange, onCopy })
  reopen = null
  …三选循环(Esc → reopen = picked; continue)…
  result = await navigateTree(targetId, …)
  if (result.aborted) { note("▪ summarization cancelled — stayed on the current branch");
                        reopen = targetId; continue }   // pi:5298-5302 + 同 entry 预选
  …成功路径 return "handled"(现行为不变)…
}
```
`TreeSelectRequest` 增 `initialSelectedId?: string`;shell.ts 透传组件。
numbered(/tree n)与 legacy 路径**不变**(无选择器可重开,维持 note-only);
noop 分支 picker 路径不可达(leaf 先短路),维持现有 note 防御。
aborted 后树可能有半成品?——navigateTree 的 aborted 在 append 之前返回
(批 A 实现),fresh getTree() 无残留;即便有,id 失踪也走 D2 的上溯,安全。

### D7 — 复制(#6)

组件:构造器 opts 增 `onCopy?: (text: string | undefined) => void`;handleInput
在 enter 支后增 `matchesKey(data,"ctrl+x")` → 取选中行对应 entry 的复制文本回调。
文本提取 `getEntryCopyText`(pi:896-920 的 imp 版):
- user → contentText(content);assistant → text 块 join(" ")(空则 undefined);
  toolResult → 各 result 的 **content**(字段名 content,非 output,审查 P3-4)
    经 contentText 后 join("\n\n");
- branchSummary / compaction → summary;thinkingLevelChange / session_info / label → undefined;
- 全部 trim 后空 → undefined。
需要 entry 而非 TreeRow → 组件已有 roots,D2 之外加 `findNode(entryId)` 小工具
(setNodeLabel/findNodeLabel 已有同型遍历,合并一个)。
commands 侧(pi:5315-5327):
```
onCopy: (text) => {
  if (text === undefined) { ctx.renderer.error("imp: selected entry has no text to copy"); return }
  const write = ctx.copyText ?? ((v) => copyToClipboard(v))   // 既有剪贴板测试接缝
  void write(text)
      .then(() => ctx.renderer.status("Copied selected entry to clipboard"))
      .catch((e) => ctx.renderer.error(`imp: copy failed — ${…}`))
}
```
**走 `ctx.copyText ?? copyToClipboard` 接缝**(审查 P2-3:测试从不碰真剪贴板,
commands.ts:1616 先例);status 文案无 ▪ 前缀(status() 约定,审查 P3-7)。
异步不阻塞组件(组件回调为同步 void)。
嵌套 labelEdit 中 ctrl+x 被吞(设计,批 B 已定)。

### D8 — 提示文案

状态行与 shell.ts 标题追加:`←→ page · alt+←→ branch · ^x copy`
(状态行单行 truncate,完整键表进 README;不引 pi 的 TreeHelp 面板)。

## 3. 接缝清单

| 文件 | 改动 |
|---|---|
| components/tree-selector.ts | D1 字段;D2 定位+居中窗;D3 翻页;D4 段跳转;D5 视口;D6 无;D7 onCopy+findNode;D8 提示 |
| repl/commands.ts | D6 两层循环 + TreeSelectRequest.initialSelectedId/onCopy;D7 onCopy 实现;D8 标题 |
| repl/shell.ts | treeSelect 透传两新选项 |
| repl/line-input.ts | TreeSelectRequest 类型增字段 |
| tui.ts | 转口 sliceByColumn |
| README.md | /tree 键表更新 |

runner/store/settings:**零改动**。

## 4. 测试计划

组件级(tree-selector.test.ts,posterTree 扩深链 fixture):
1. 打开定位:default 模式光标在 leaf 行;**initialSelectedId 指到 user-only 下被藏的
   非叶行** → 沿 rawParent 上溯最近可见行(审查 P2-2:leaf 绝对可见,"leaf 被藏"
   不可能发生);id 失踪(重开时)→ 上溯到根;空行集 0。
2. 居中窗(审查 P2-1:**中部行**才有判别力——尾部两模型渲染相同):
   ≥10 行 fixture、vis=4、initialSelectedId=中部行 → 首渲染窗口 = [sel−2, sel+2);
   ↓ 一行使选中越过中心 → 窗口起点 +1(移动即重居中)。
3. 翻页:vis=4、12 行 → right 跳 +4 夹紧;再 right 夹在末行;left 回跳;PgDn 序列
   `\x1b[6~` 同 right;不清查询不清折叠(先打字再翻页,查询仍在状态行)。
4. 段跳转:分支 fixture——分支根上 alt+left 折叠(行数缩);**已折**行上 alt+left
   → 跳段首(不是展开!);alt+right → 展开;非折叶上 alt+right → 跳下一分支段首;
   **线性链中行**上 alt+left → 跳链首(**不折叠**——isFoldable 分支点判定,审查
   P1-2 的钉子);**藏掉中间层后**:默认模式藏无文本 assistant,工具行消失、其子
   收养到可见祖先——自收养点 alt+right → 跳到收养首子;自深层 alt+left → 沿收养
   链跳段首(审查 P1-1 的钉子);ctrl+left 序列同 alt+left(双绑)。
   翻页补:行数 < vis 时 ←/→ 夹在两端不动(双端夹紧钉子)。
5. 水平视口:构造深缩进(indent≥4)+宽 20 终端:选中深行 → 其 text 可见(切片后
   仍含 text 片段)、浅行开头被切;宽 80 → 无平移(全行完整)。
6. 复制:user/assistant/toolResult/branchSummary 各型文本正确;thinkingLevelChange →
   undefined;ctrl+x 触发 onCopy;空文本 assistant → undefined。
命令级(repl-commands.test.ts):
7. aborted 重开:fake navigateTree 首次 {aborted} 后成功 → treeSelect 调用两次,
   第二次 initialSelectedId = 目标 id;note 出现;成功后正常 replay。
8. 三选 Esc 重开带预选:Esc 后第二次调用 initialSelectedId = picked(批 A 只断重开,
   现加预选断言)。
9. onCopy 接缝(审查 P2-3:**不需要 mock**——走 ctx.copyText 接缝):
   ctx.copyText 注入捕获 → onCopy(text) 后 status "Copied selected entry to clipboard"
   且捕获值 = text;onCopy(undefined) → error 出现。
回归:翻页/段跳转与搜索、折叠、labelEdit 的交互(搜索中 alt+left 不进查询 buffer、
labelEdit 中全吞)。

## 5. 风险与大小

- **窗口模型改动波及现有测试**:批 A 若有钉"跟随滚动"的渲染断言需改(居中)。
- **键位改动波及现有测试**(审查 P3-6):tree-selector.test.ts:256 在查询中途喂
  `\x1b[C`(右)——D3 落地后它是翻页而非无效输入,该测试的选择数学会变(预期内)。
- alt/ctrl+方向序列的终端差异:pi-tui matchesKey 已处理(xterm/kitty),单测钉
  `\x1b[1;3D`/`\x1b[1;5D`/`\x1b\x1b[D` 至少两类。
- 段算法的 active-first 排序交互:首子=可见序第一(与 pi 同序),fixture 覆盖
  旧分支在前的情况。
- 估算:组件 +~260(含 P1-1 可见收养图 ~40-60)、commands +~50、shell/类型 +~15、
  测试 +~400、README/文档。约 730 行,批 B 的一半弱。


## 6. 设计审查记录(2026-02-09,fresh-context adversarial)

判 BLOCK → 修订后采纳全部 12 项(2 P1+3 P2+7 P3),逐项亲核 pi 源码属实:

- **P1-1 D4 裸 parentId 分组是死路**:pi 的 visibleParent/visibleChildren 按**最近
  可见祖先**收养(pi:430-456,555-556)——过滤藏掉中间层后,后代必须挂到可见
  祖先,否则 down 死停(组空)、up 断链。修订:D4 重写为收养图 + D1 改组件侧
  rawParent 全图(顺带解决 P2-2 的"隐藏目标无 TreeRow"问题,TreeRow 不再需要
  新字段)。
- **P1-2 D1 的 foldable=children>0 与"逐行照抄 pi"自相矛盾**:pi 的 isFoldable
  (1105-1117)只在**分支点/根**可折(可见子>0 且 可见父的组>1);链中行
  alt+← 是跳段首不是折叠——我的 §4.4 测试预期恰恰断言 pi 的行为,设计文本却
  保证相反。修订:D4 用 pi 判定;`f` 键维持 imp 现语义(自有键,记录偏离)。
- **P2-1 居中窗测试无判别力**:尾部窗口两模型渲染相同;改中部行 + 移动重居中断言。
- **P2-2 "user-only 下 leaf 被藏"不可能**(leaf 绝对可见,批 A 规则);改
  initialSelectedId 指向被藏非叶行;D2 补"沿 rawParent 上溯"(目标无行可走)。
- **P2-3 onCopy 硬编 copyToClipboard 绕过测试接缝**:改 `ctx.copyText ?? copyToClipboard`
  (commands.ts:1616 先例),测试免 mock。
- **P3×7**:§0 表 custom_message 行更正(extractFullContent 非 summary);onCopy
  引用移 5338-5349;KeyId 驼峰 "pageUp"/"pageDown";ToolResult 字段是 content 非
  output;"↑↓ 回绕"注明是 pi 行为(imp 夹紧是既有未记录偏离,不随本批改);
  §5 补键位测试churn(:256 的 \x1b[C);status() 文案去 ▪ 前缀。


## 7. 实现审查记录(`2263c68` 后,2026-02-09)

判 BLOCK→修后 OK:A-I 九项全查,D4 收养图/isFoldable/段算法、D5 视口逐行
pi 对齐确认;1 P1+1 P2+5 P3,全部亲核采纳:

- **P1 残留调试输出**:批 C 排障时我加的 `SHARED-NAV>>>` console.error——按
  DEBUG_TC 行过滤清理时多行语句的续行漏网。numbered 路径每次导航都会打到
  stderr。已删。
- **P2 summarize/customInstructions 跨重开轮泄漏**:第一轮选"Summarize"→
  摘要中止重开→第二轮选"No summary"仍会摘要(choice 0 只是不置 true,不清
  旧值);custom 同理。pi 每次选择重新声明两变量。修:轮顶重置 + ask 循环内
  `summarize = choice !== 0`(pi 的 wantsSummary 逐次重算)。
- **P3-1** findNearestVisibleIndex 空 target 且行集非空时返回 0,pi 落末行
  ——去掉 `|| targetId === null` 短路,走末行兜底。
- **P3-5** 末次 truncate 补 pi 的 `""`(切片行干净收尾,不出默认省略号)。
- **P3-4 补钉**:branchSummary→summary、thinkingLevelChange→undefined、
  alt+←/→ 查询免疫、onCopy 写失败→"imp: copy failed —"。
- **P3-2/P3-3 记账不修**:visibleLines 组件层 floor 3(pi 无,批量 A 自定,
  生产路径不受影响);复制文本 assistant 块 join(" ")(pi 连接 "" )与
  contentText 的 \n——设计 D7 原文如此,记为有意。

测试 1137→1138(净增 1 个 it:P3-4 钉子并入既有测试);门禁 1138/1138、typecheck 0、biome 0、build 0。
