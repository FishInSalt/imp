# /tree 批 B:label 书签 + 两个设置 + /fork 合流

状态:设计稿(待独立设计审查)。

前置:`docs/tree-design.md`(批 A,已合并 main `6a542cd`,1104 tests)。本批是其中
"批 B 候选"的用户选定组合:label 编辑 + labeled-only 过滤(书签系统)、
treeFilterMode + branchSummarySkipPrompt 两个设置、/fork 与 /tree 的实现合流。

不在本批(继续延后):水平滚动、分支段跳转(`[`/`]`)、all 过滤**的设置面板值**
(见 D4——all 仍是可用过滤模式,只是默认值候选里没有它)……更正:pi 的设置面板
五个值都在;imp 照抄五值,本项不砍。label 时间戳切换(pi 的 shift+t)不实现
(imp 的 label 不记时间戳,记了也没处显示)。

## 0. pi 机制核实记录(亲读,2026-02-09)

| 机制 | pi 位置 | 行为 |
|---|---|---|
| 过滤模式 | tree-selector.ts:95,365-385 | 5 值 `default/no-tools/user-only/labeled-only/all`;labeled-only= `node.label !== undefined`;all=全过(含簿记) |
| 模式切换 | tree-selector.ts:1041-1077 | 每模式专用键(toggle↔default)+ 前后循环键;**切模式清空折叠** |
| treeFilterMode 设置 | settings-manager.ts:142,1340-1350 | "Default filter when opening /tree";getter 校验非法值回落 default;**只在设置面板写**(选择器内 Tab 不持久化) |
| 开选择器读取 | interactive-mode.ts:5208 | `initialFilterMode = settingsManager.getTreeFilterMode()` 传入构造器 |
| branchSummarySkipPrompt | settings-manager.ts:902-911 | 嵌套 `branchSummary:{skipPrompt?}`,默认 false;true 时 picker 流程**直接 wantsSummary=false,不问** |
| 三选跳过 | interactive-mode.ts:5236-5238 | `if (!skipPrompt) { while(true){...} }` |
| label 编辑键 | keybindings.ts:158-160 | **`shift+l`(大写 L)**——小写留给搜索,键位无冲突 |
| LabelInput | tree-selector.ts:1271-1323 | 组件内内嵌输入框("Label (empty to remove):",Enter 存(trim,空=删),Esc 取消);树列表暂时让位 |
| 提交回调 | tree-selector.ts:1392-1407 | `updateNodeLabel(id,label)`(内存+时间戳)+ `onLabelChangeCallback` → interactive-mode:5309-5313 `sessionManager.appendLabelChange(entryId,label)` |
| labeled-only 状态标签 | tree-selector.ts:651-656 | 状态行追加 ` [labeled]` / ` [all]` |

## 1. 目标与非目标

**目标**
1. label 成为用户可生产的书签:L 键编辑,书签可搜、可过滤(labeled-only)直达。
2. `treeFilterMode` 设置:记住 /tree 打开时的默认过滤模式。
3. `branchSummary.skipPrompt` 设置:总跳过"要不要摘要"三选。
4. /fork 的位置移动/历史重建走 navigateTree 同一条路(消双路径)。

**非目标**:不改 label 的存储格式(批 A 已定);不动摘要的模型/prompt;不实现
pi 的 label 时间戳、复制键、每模式专用过滤键(imp 保持 Tab 单循环——五个模式
两键循环太长,专用键则与搜索抢小写字母;批 B 不加)。

## 2. 决策

### D1 label 编辑的归属:组件内嵌(pi 同形)

- 键:**大写 `L`**(`data === "L"`)。小写永远是搜索字符——pi 用 shift+l 解决
  与搜索的冲突,imp 照抄;不需要 f 键那种 query 空守卫。
- `TreeSelectorComponent` 增一个内嵌输入态:`labelEdit: { entryId, buffer } | null`。
  激活时:render 画 `Label (empty to remove): <buffer>▏  enter=save esc=cancel`
  (替代状态行位置,树列表保持显示);handleInput 全部路由进 buffer
  (可打印字符/backspace;Enter=保存;Esc=取消)。
- 保存动作组件内**不直接写库**:回调 `onLabelChange(entryId, label)`。
  组件内同时更新自己的 `roots` 副本?——**不更新**:TreeNode 是构造器传入的
  数组,组件对它只读。pi 的 updateNodeLabel 就地改 flatNode。imp 等价做法:
  回调返回新 label,组件重建 rows 时……rows 来自 buildTreeRows(roots)——
  组件持有 roots 引用,直接改 `node.label` 会污染调用方的树。**决策:就地改**。
  getTree() 每次调用都是新建的树(commands.ts 每次 `/tree` 现取),不存在共享;
  就地改 = pi 的 updateNodeLabel,渲染立即可见,无需重取。
- 落库:commands.ts 把 `session.appendLabelChange` 作为回调传进 treeSelect。
  **时序**:pi 是"提交即落库"。imp 相同——L 保存的瞬间 appendLabelChange
  (append-only,无风险),选择器继续开着。
- **两处不变式**:label entry 的 targetId 必须是**现存 entry**(防孤儿注记——
  校验 `store.getEntry(targetId)`,不存在则 note 拒绝);appendLabelChange 在
  选择器打开期间发生,leaf 未动,parentId=当前 leaf 语义不变。
- legacy shell:无选择器,无 L 键。**决策:不提供**(pi 亦无;legacy 的
  /settings 也不能编辑 label)。

### D2 labeled-only / all 过滤(5 模式)

- `TREE_FILTER_MODES = ["default","no-tools","user-only","labeled-only","all"]`,
  Tab 单循环(5 步一圈;Shift+Tab 反向**不加**——非目标里的键位纪律)。
- `passesFilter` 增两支:
  - `labeled-only`:`node.label !== undefined`(对 entry 判定:批 A 的 label
    折叠发生在 getTree 的 TreeNode 上——**过滤需要 row 级 label**。实现:
    passesFilter 增参 `label: string | undefined`,调用点传 `node.label`)。
    当前 leaf 绝对可见规则不变。
  - `all`:跳过簿记隐藏(thinkingLevelChange/session_info 也显示)。
    describeEntryForTree 已能描述这两类(批 A 写过)。
- **切模式清空折叠**(pi 同):Tab 后 `this.folded.clear()`。理由:labeled-only
  下折叠一个书签会藏掉整个模式的意义;清空是防呆。搜索查询保留(pi:切模式
  不清查询——pi 只在 Esc/退格时动查询。核实:pi 的 filter 键不清 searchQuery,
  但 applyFilter 会带着查询过滤。imp 照抄:模式切换保留查询)。

### D3 状态行与标题

- 状态行模式标签:`[labeled]`/`[all]`(pi 字面)。
- 标题栏帮助文案加 `L=label`:
  `Navigate the session tree (enter=go · tab=filter · f=fold · L=label · type to search)`。

### D4 treeFilterMode 设置

- `ImpSettings.treeFilterMode?: "default"|"no-tools"|"user-only"|"labeled-only"|"all"`
  (settings.ts 自带字面联合,注释指明与 repl 层 TreeFilterMode 同步;避免
  core → repl 的反向依赖)。
- coerceSettings:非法值**静默丢弃**(回落 default)——与 imp 全部设置的宽容
  加载一致(pi 的 getter 校验等价)。
- 读取:commands.ts 的 /tree 在开选择器前
  `effective.treeFilterMode ?? "default"`,经 TreeSelectRequest.initialFilterMode
  传入。**LIVE 读**(settingsEntries 同款:不信任 runner 构造时快照——/settings
  本会话改了要立刻生效)。
- **不持久化 Tab 循环**(pi 同:设置面板才是写入口)。
- /settings 面板:增条目 `treeFilterMode`,kind "mode",值列五字面;
  `/settings treeFilterMode labeled-only [scope]` 可写。SETTING_KEYS 增补。
- **编号树(legacy)不读它**:legacy 永远 default(pi 同——设置只喂选择器)。

### D5 branchSummary.skipPrompt 设置

- `ImpSettings.branchSummary?: { skipPrompt?: boolean }`(**嵌套**,pi 的形状;
  与 images/mcp 同款 coerce + 深合并 + raw 补丁)。
- 语义(仅 picker 流程):true 时跳过三选,`summarize=false` 直接导航
  (pi 的 `if (!skipPrompt) {...}` 等价:不问,wantsSummary 保持 false)。
- **与 IMP_BRANCH_SUMMARY=0 正交**:env=0 是硬关(摘要代码路径不跑,
  编号路径也看它);skipPrompt 只省一次交互。两者可同真(env 仍然全关)。
- 编号路径(`/tree <n>`)不受 skipPrompt 影响——它本来就不问。
- /settings 面板:条目 `branchSummary.skipPrompt`,kind "boolean";
  SETTING_KEYS/parseSettingValue/settingPatchFor 增补(嵌套走 mcp. 同款分支)。

### D6 /fork 合流(forkSessionAt → navigateTree 薄包装)

现状双路径:
- forkSessionAt:forkBefore(leaf=parentId+persistPosition)+ 手动 history 重建
- navigateTree:user 消息目标 = branchTo(parentId)(同一移动)+ buildContext 重建
  + noop 守卫 + 身份守卫 + editorText 提取 + 图像丢弃标记 + 摘要

**决策**:`forkSessionAt` 保留签名,实现改为调 `navigateTree(entryId,
{summarize:false})`:
- noop(目标 parent 就是当前 leaf,即"fork 最新一条消息"):原 forkBefore
  会把 leaf 挪到 parent——若 parent 就是当前 leaf 则是原地空转;navigateTree
  报 noop。/fork 的 UX:note "already forking at the newest message"。
  **行为差异记录**:原实现此场景下 retained=全部、abandoned=0、无 note——
  合流后多一句提示,更诚实。
- editorText:forkSessionAt **消费**它(fork 的语义就是"重打这条消息"),
  作为返回字段透传给 /fork 命令——**命令层已有回填逻辑**(/tree 写的),
  /fork 复用:空编辑器则回填,否则 note。原实现没有回填(一个既有缺口,
  合流顺手补上;README 幸存清单同步)。
- retained/abandoned 计数:forkBefore 的返回值丢了。**决策:/fork 的 note
  改用 navigateTree 的语言**(`forked before "…" — N messages kept on this
  branch`)。N=navigateTree 返回的 messages;abandoned 从 note 里去掉
  (树还在,/tree 看得见;两个数字不如一个诚实)。**取舍**:教学性略降,
  单一事实源升。
- forkBefore(存储层)保留——navigateTree 的 branchTo 是它的超集,但
  forkBefore 语义(含 onCurrentPath 防御)仍是 store 公共 API;不再有
  runner 调用方后标记 deprecated 注释,测试继续钉它。
- userForkPoints/forkPoints(选择器数据)不变——/fork 的列表 UX 保留
  (只列当前路径用户消息+预览,比全树好用)。

### D7 测试计划(§8 对应)

- tree-selector.test.ts(+~10):L 键开输入/可打印进 buffer/backspace/Enter
  落回调(含 trim、空=删=undefined)/Esc 取消不落/labeled-only 只显 label 行
  (leaf 恒显)/all 显簿记/Tab 五循环+切模式清折叠保留查询/initialFilterMode
  生效/就地改 label 后 rows 立即反映。
- settings.test.ts(+~6):treeFilterMode coerce(合法/非法/缺省)、嵌套
  branchSummary.skipPrompt(coerce/深合并/raw 未知键幸存/saveSettings 嵌套)。
- repl-commands.test.ts(+~5):skipPrompt=true 时 picker 流程无三选直接切;
  treeFilterMode 设置喂给选择器(拦截 treeSelect 断言 initialFilterMode);
  /settings treeFilterMode 值解析五字面;/fork 走 navigateTree(mock 断言
  调用与 noop note);/fork editorText 回填。
- tree-nav.test.ts(+~2):forkSessionAt 与 navigateTree(user 消息,无摘要)
  结果等价(位置、history);noop 场景。
- 预计 1104 → ~1127。

### D8 README/文档

- README `/tree` 段:L 键、五过滤、两设置、/fork 行为微调。
- 本文档实现后补 §9(实现审查记录,惯例)。

## 3. 风险与守卫

- **L 键与 IME**:大写 L 是单字节 "L"(0x4C),无组合;matchesKey 不需要。
  可打印守卫分支放最后,L 分支在其前——与 f 相同的结构。
- **就地改 roots**:调用方(commands.ts)每次 `/tree` 都 getTree() 新建,
  无共享;测试若复用同一 roots 数组需知悉(测试自己建,可控)。
- **设置 LIVE 读**:effectiveSettings 每次读盘——/tree 频度低,无性能顾虑。
- **/fork 合流的行为差异**:noop 场景的 note、abandoned 计数消失、
  editorText 回填新增——测试随改,README 记录。
