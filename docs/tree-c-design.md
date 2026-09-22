# /tree 批 C:打磨池收官(打开定位/翻页/段跳转/水平视口/中止重开/复制)

状态:设计中。

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
| 翻页 | tree-selector.ts:1018-1023 | `left`/`pageUp` → `sel = max(0, sel − vis)`;`right`/`pageDown` → `min(len−1, sel + vis)`;**夹紧不回绕**(↑↓ 才回绕) |
| 段跳转键 | keybindings.ts:150-157 | darwin `alt+left`+`ctrl+left` = foldOrUp;`alt+right`+`ctrl+right` = unfoldOrDown |
| foldOrUp 语义 | tree-selector.ts:1002-1009 | 选中节点**可折叠且未折** → 折;**否则**(含已折!)→ `findBranchSegmentStart("up")` |
| unfoldOrDown 语义 | tree-selector.ts:1010-1017 | 已折 → 展;否则 → `findBranchSegmentStart("down")` |
| 段起点算法 | tree-selector.ts:1125-1153 | down:沿首子链下行,遇**可见子 >1** 的节点 → 其首子的下标;单子链走到叶 → 停。up:沿可见 parent 上行,遇**可见子 >1** 的祖先:若当前段的起点在选中行上方 → 返回它;否则继续上行;到根 → 当前下标 |
| 水平视口 | tree-selector.ts:46-92 | **自动平移**(无手动键):gutter(光标列,宽 2)恒显;仅当选中行 anchor(正文起始列)超出 `viewportWidth − minVisibleAnchorContentWidth`(min=4,max=20,`viewportWidth/3` 夹中间)时,全体 body 左移 `anchorCol − anchorContextWidth`(context 2–12,`viewportWidth/4` 夹中间,上限 maxHorizontalScroll);body 切片用 `sliceByColumn(body, scroll, viewportWidth, true)` |
| anchorCol | tree-selector.ts:746-752 | `prefixPart = dim(prefix) + foldMarker + pathMarker`;**anchor = prefixPart 宽**(label 算正文,不算前缀);`bodyWidth = visibleWidth(body)` |
| 中止重开(两处) | interactive-mode.ts:5243-5246, 5298-5302 | ①三选 Esc → `showTreeSelector(entryId)`(**同一 entry 预选**);②`result.aborted` → status "Branch summarization cancelled" + `showTreeSelector(entryId)`。①imp 批 A 审查 P2 已做(循环);②未做——本批补 |
| 复制键 | keybindings.ts:130-133, tree-selector.ts:1029-1030 | `ctrl+x` → `copySelected()` |
| 复制文本提取 | tree-selector.ts:896-920 | message:bashExecution→command;有 content → 全部 text 块(`extractFullContent`);assistant 空文本回落 errorMessage。custom_message/compaction/branch_summary → summary。**空(trim 后)→ undefined** |
| 复制接缝 | interactive-mode.ts:5315-5327 | `onCopy(text)`:undefined → showError "Selected entry has no text to copy";否则 `copyToClipboard` → status "Copied selected message to clipboard";异常 → showError |

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

### D1 — TreeRow 增两字段(#3/#4 的数据基础)

`TreeRow` 增 `parentId: string | null` 与 `foldable: boolean`(children>0)。
buildTreeRows 在 flatten 时顺手填(零成本);组件不依赖树形查找。
`foldable` 只看**有无子节点**(不看过滤后可见性——与 `f` 键现行为一致:
折叠集合可以持有叶节点 id,渲染时 children>0 才生效)。

### D2 — 打开定位(#4)

构造器尾部:`selected = findNearestVisibleIndex(initialSelectedId ?? leafId)`。
- 目标 id 命中当前行集 → 其下标;
- 未命中(被过滤/折叠遮住,或重开时 id 已消失)→ **沿 parentId 上溯**最近可见行;
- 行集空 → 0;兜底 `rows.length − 1`(pi 同)。
`rows()` 依赖 `this.mode`(initialFilterMode)——定位在 mode 赋值之后。
**窗口模型随之改**:删 scrollOffset 状态,render 每次按
`start = max(0, min(selected − floor(vis/2), len − vis))` 居中(pi:672-678)。
理由:①pi 对齐;②删状态更简单;③翻页(#5)落点天然居中。批 A 的"跟随滚动"
是一次有意的未记录简化——本批修正,注意现有测试若有钉窗口起点者需改。

### D3 — 翻页(#5)

handleInput 增两支(在 ↑↓ 之后):
`matchesKey(data,"left") || matchesKey(data,"pageup")` → `selected = max(0, selected − vis)`;
`matchesKey(data,"right") || matchesKey(data,"pagedown")` → `selected = min(len−1, selected + vis)`。
夹紧、不回绕、不清查询不清折叠。PgUp/PgDn 序列(`\x1b[5~`/`\x1b[6~`)由
pi-tui 的 matchesKey 解析(与 ↑↓ 同一解析器,实现时以单测钉序列)。
嵌套 labelEdit 输入照旧全吞。

### D4 — 分支段跳转(#3)

`alt+left || ctrl+left` → foldOrUp;`alt+right || ctrl+right` → unfoldOrDown(pi darwin
defaultKeys 双绑)。语义**逐行照抄 pi**:
- foldOrUp:`foldable && !folded.has(id)` → `folded.add` + clamp;否则 findBranchSegmentStart("up")。
- unfoldOrDown:`folded.has(id)` → delete + clamp;否则 findBranchSegmentStart("down")。
段起点算法按行集实现(pi:1125-1153):
- 可见 children 映射:按 `parentId` 对 rows 分组;可见 parent 映射:parentId 直接可得。
- down:自选中 id 起,`children = group(id)`;空 → 停(当前下标);**>1 → 首子下标**;
  恰 1 → 下行。**注意 active-first 排序**:group 顺序即 rows 顺序(数组保序),"首子"
  = 组内第一行,与 pi 的 `children[0]` 同义(pi 也 active-first)。
- up:自选中 id 上行;每到一个 parent 其组 >1:若组内"当前 id"的下标 < selected →
  返回该下标;否则继续上;parent null → 停。
折叠加 clampSelection(行数会缩);跳转后无 clamp 必要(下标必在界内)。
批 A 砍它的理由是"同键两义",但 pi 的两义自洽(alt+← = 收拢当前语境:能折则折,
不能折则回到段首),且用户标准是 pi 对齐——照抄并记录。

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
  toolResult → 各 result 的 output join("\n\n");
- branchSummary / compaction → summary;thinkingLevelChange / session_info / label → undefined;
- 全部 trim 后空 → undefined。
需要 entry 而非 TreeRow → 组件已有 roots,D2 之外加 `findNode(entryId)` 小工具
(setNodeLabel/findNodeLabel 已有同型遍历,合并一个)。
commands 侧(pi:5315-5327):
```
onCopy: (text) => {
  if (text === undefined) { ctx.renderer.error("imp: selected entry has no text to copy"); return }
  void copyToClipboard(text)
      .then(() => ctx.renderer.status("▪ copied selected entry to clipboard"))
      .catch((e) => ctx.renderer.error(`imp: copy failed — ${…}`))
}
```
copyToClipboard 已在 commands.ts import(现成)。异步不阻塞组件(组件回调为同步 void)。
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
1. 打开定位:default 模式光标在 leaf 行;user-only 下 leaf 是 toolResult 行 → 上溯
   最近可见 user 祖先;initialSelectedId 指定;id 失踪 → 上溯到根;空行集 0。
2. 居中窗:leaf 为末行 + vis=4 → 首渲染即含 leaf 且窗口起点居中(断言渲染行含
   leaf 行与窗口行数)。
3. 翻页:vis=4、12 行 → right 跳 +4 夹紧;再 right 夹在末行;left 回跳;PgDn 序列
   `\x1b[6~` 同 right;不清查询不清折叠(先打字再翻页,查询仍在状态行)。
4. 段跳转:分支 fixture——分支根上 alt+left 折叠(行数缩);**已折**行上 alt+left
   → 跳段首(不是展开!);alt+right → 展开;非折叶上 alt+right → 跳下一分支段首;
   线性链上 alt+left → 跳链首(根)。ctrl+left 序列同 alt+left(双绑)。
5. 水平视口:构造深缩进(indent≥4)+宽 20 终端:选中深行 → 其 text 可见(切片后
   仍含 text 片段)、浅行开头被切;宽 80 → 无平移(全行完整)。
6. 复制:user/assistant/toolResult/branchSummary 各型文本正确;thinkingLevelChange →
   undefined;ctrl+x 触发 onCopy;空文本 assistant → undefined。
命令级(repl-commands.test.ts):
7. aborted 重开:fake navigateTree 首次 {aborted} 后成功 → treeSelect 调用两次,
   第二次 initialSelectedId = 目标 id;note 出现;成功后正常 replay。
8. 三选 Esc 重开带预选:Esc 后第二次调用 initialSelectedId = picked(批 A 只断重开,
   现加预选断言)。
9. onCopy 接缝:mock clipboard-write → onCopy(text) 后 status 出现;onCopy(undefined)
   → error 出现。
回归:翻页/段跳转与搜索、折叠、labelEdit 的交互(搜索中 alt+left 不进查询 buffer、
labelEdit 中全吞)。

## 5. 风险与大小

- **窗口模型改动波及现有测试**:批 A 若有钉"跟随滚动"的渲染断言需改(居中)。
- alt/ctrl+方向序列的终端差异:pi-tui matchesKey 已处理(xterm/kitty),单测钉
  `\x1b[1;3D`/`\x1b[1;5D`/`\x1b\x1b[D` 至少两类。
- 段算法的 active-first 排序交互:首子=可见序第一(与 pi 同序),fixture 覆盖
  旧分支在前的情况。
- 估算:组件 +~200、commands +~50、shell/类型 +~15、测试 +~380、README/文档。
  约 650 行,批 B 的一半弱。
