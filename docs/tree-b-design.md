# /tree 批 B:label 书签 + 两个设置 + /fork 合流

状态:已实现(设计审查闭环 §4;实现审查待跑);测试 1104→1122。

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

- 键:**大写 `L`**(`data === "L"`),分支放在可打印守卫**之前**(pi 结构)。
  小写永远是搜索字符;**大写 L 任何时刻都开编辑——包括搜索激活时**(pi 同:
  editLabel 分支先于搜索追加分支,大写 L 进不了查询;搜索不区分大小写,想搜
  含 L 的词用小写)。钉测试(§4 P2)。
- `TreeSelectorComponent` 增一个内嵌输入态:`labelEdit: { entryId, buffer } | null`。
  激活时:render 画 `Label (empty to remove): <buffer>▏  enter=save esc=cancel`
  (替代状态行位置,树列表保持显示);handleInput **全部**路由进 buffer:
  可打印字符进 buffer、backspace 删、Enter 保存、Esc 取消;**其余键(箭头/Tab/
  f/L)吞掉**——嵌套输入不漏给树(钉测试,§4 P2)。
- 保存动作组件内**不直接写库**:回调 `onLabelChange(entryId, label)`。
  组件内同时更新自己的 `roots` 副本?——**不更新**:TreeNode 是构造器传入的
  数组,组件对它只读。pi 的 updateNodeLabel 就地改 flatNode。imp 等价做法:
  回调返回新 label,组件重建 rows 时……rows 来自 buildTreeRows(roots)——
  组件持有 roots 引用,直接改 `node.label` 会污染调用方的树。**决策:就地改**。
  getTree() 每次调用都是新建的树(commands.ts 每次 `/tree` 现取),不存在共享;
  就地改 = pi 的 updateNodeLabel,渲染立即可见,无需重取。
- 落库:commands.ts 把 `session.appendLabelChange` 作为回调传进 treeSelect。
  **时序**:pi 同——提交即落库,选择器继续开着。**回调 try/catch**(§4 P3:
  appendFileSync 的磁盘满/只读异常会经 TUI 键路径裸抛杀进程——pi 同样裸奔,
  imp 不学这处):失败 → renderer.error,选择器保持;此时树上展示的是未落库
  的就地 label(理论态:rows 只列现存 entry 且目标已校验,实际不可达——记录)。
  pi 的时序是先改内存后落库(tree-selector.ts:1394-1396),imp 照抄。
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
- **四处置折叠**(§4 P3 对齐 pi):Tab 切模式、搜索打字、backspace、
  Esc 清查询——四处都 `this.folded.clear()`(pi:1077-1097 均清)。理由统一:
  折叠是浏览态,过滤/搜索是找路,后者必须能照亮被折叠的子树;否则 labeled-only
  下折叠一个书签节点会把它后面的书签全部藏掉。查询在模式切换时保留(pi 同)。

### D3 状态行与标题

- 状态行(§4 P3,两处都改,别只改标题):模式标签用映射(default 无、
  no-tools/user-only 原样、**labeled-only→`[labeled]`、all→`[all]`**——pi 字面,
  不是 `[labeled-only]`);状态行尾部帮助串加 `L=label`:
  `· enter=go tab=filter f=fold L=label`。
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
- /settings 面板(§4 P2:`kind:"mode"` 的循环逻辑硬编码了队列两值
  `all ↔ one-at-a-time`,直接挂 treeFilterMode 会把非法值写进文件再被 coerce
  静默吞掉):`SettingEntry` 增 `values?: string[]`,mode 循环在 entry.values
  里转(pi 的 settings-selector.ts:554-559 同款 values 数组);parseSettingValue
  仍是两路(面板/命令行)唯一校验器,`as QueueMode` 类型谎话随之消灭。
  条目 `treeFilterMode`,values 五字面;`/settings treeFilterMode labeled-only
  [scope]` 可写。SETTING_KEYS 增补。
- **编号树(legacy)不读它**:legacy 永远 default(pi 同——设置只喂选择器)。

### D5 branchSummary.skipPrompt 设置

- `ImpSettings.branchSummary?: { skipPrompt?: boolean }`(**嵌套**,pi 的形状;
  与 images/mcp 同款 coerce + 深合并 + raw 补丁)。
- 语义(仅 picker 流程):true 时跳过三选,`summarize=false` 直接导航
  (pi 的 `if (!skipPrompt) {...}` 等价:不问,wantsSummary 保持 false)。
- **与 IMP_BRANCH_SUMMARY=0 正交**:env=0 是硬关(摘要代码路径不跑,
  编号路径也看它);skipPrompt 只省一次交互。两者可同真(env 仍然全关)。
- 编号路径(`/tree <n>`)不受 skipPrompt 影响——它本来就不问。
- **LIVE 读**(§4 P3,与 D4 同理明说):三选跳过的判断在 picker 流程当场
  effectiveSettings,不缓存(pi 在 ask 时点读,interactive-mode.ts:5236)。
- /settings 面板:条目 `branchSummary.skipPrompt`,kind "boolean";
  SETTING_KEYS/parseSettingValue/settingPatchFor/**settingSource 的 pick()**
  增补(嵌套走 mcp. 同款分支——漏了 pick() 则来源列永远显示 [default],§4 P3)。

### D6 /fork 合流(forkSessionAt → navigateTree 薄包装)

现状双路径:
- forkSessionAt:forkBefore(leaf=parentId+persistPosition)+ 手动 history 重建
- navigateTree:user 消息目标 = branchTo(parentId)(同一移动)+ buildContext 重建
  + noop 守卫 + 身份守卫 + editorText 提取 + 图像丢弃标记 + 摘要

**决策**:`forkSessionAt` 改为 **async** 且**返回 navigateTree 的结果联合 +
preview**(§4 P2:同步方法转发不了 async;retained/abandoned 被 D6 本身废弃,
签名不可能保留)。Runner 接口与 /fork 调用点(await + 解构)随之改。

**noop 映射(§4 P1,重写)**:navigateTree 的 noop 守卫是
`targetId === store.getLeafId()`(目标**本身**是当前位置),不是"目标的
parent 是当前 leaf"——后者走 positionMoves 分支,返回完整结果+editorText
(批 A 实现审查轮加的)。/fork 的**主场景恰是前者**:未应答的最新用户消息
(回合中止/出错,没有 assistant 落盘)= 目标就是 leaf,合流后 navigateTree
报 noop,/fork 死路——**回归**。原 forkBefore 无 leaf 守卫,无条件
`leafId = target.parentId`(store.ts:431),这正是 store.ts:404-410 文档串
写的"重打最后一条消息"。修法(采纳审查建议):
- **放宽 navigateTree**:`targetId === leafId` 且目标是 **user 消息** → 照常
  走(newLeaf=parentId,返回 editorText),不再 noop;非 user 的 leaf 目标
  仍 noop。/tree 两条面都先短路 leaf 选中(commands.ts:969 picker、
  ~1004 编号——"already at that point"),内部守卫只有直接 API(/fork)
  能摸到,放宽不影响 /tree 的 pi 对齐(pi 的 /tree 对 leaf 选中同样
  "Already at this point")。
- 等价测试钉这个场景(fork 最新未应答消息:位置移动、editorText 回填)。
- noop 真触发面(非 user leaf,如 assistant tip):/fork 的选择器根本列不出
  (只列 user 消息)——防御路径,note "already at that point"。

- editorText:forkSessionAt **消费**它(fork 的语义就是"重打这条消息"),
  作为返回字段透传给 /fork 命令——**命令层已有回填逻辑**(/tree 写的),
  /fork 复用:空编辑器则回填,否则 note。原实现没有回填(一个既有缺口,
  合流顺手补上;README 幸存清单同步)。
- retained/abandoned 计数:forkBefore 的返回值丢了。**决策:/fork 的 note
  改用 navigateTree 的语言**(`forked before "…" — N messages kept on this
  branch`)。N=navigateTree 返回的 messages;abandoned 从 note 里去掉
  (树还在,/tree 看得见;两个数字不如一个诚实)。**取舍**:教学性略降,
  单一事实源升。
- **目标校验(§4 P3 明说)**:forkSessionAt 原有的 userForkPoints().find
  防御(off-path/非 user 抛 SessionNotFoundError)随转发消失——navigateTree
  收任何非 label entry。**保留为 wrapper 前置检查**(两行,防御不降级)。
- forkBefore(存储层)保留——navigateTree 的 branchTo 是它的超集,但
  forkBefore 语义(含 onCurrentPath 防御)仍是 store 公共 API;不再有
  runner 调用方后标记 deprecated 注释,测试继续钉它。
- userForkPoints/forkPoints(选择器数据)不变——/fork 的列表 UX 保留
  (只列当前路径用户消息+预览,比全树好用)。

### D7 测试计划(§8 对应)

**既有测试会破(§4 P2,先列清)**:
- tree-selector.test.ts:256-269 Tab 三循环——第三次 Tab 断言回 default,
  五模式后落在 labeled-only。改断言为五步。
- repl-commands.test.ts:821-822、860-861 与 repl-tui.test.ts:1850、1892、
  1935-1936——钉着 `forked before "…"` + `N messages kept, M left` 的
  note;D6 去掉 abandoned 计数,note 文案变。逐处更新(repl-tui 进改动
  文件清单)。

**新增**:
- tree-selector.test.ts(+~12):L 开输入(含**搜索激活时**)/可打印进
  buffer/backspace/Enter 落回调(trim、空=undefined)/Esc 取消不落/
  **label-edit 中箭头/Tab/f/L 吞掉**/labeled-only 只显 label 行(leaf 恒显)/
  all 显簿记/Tab 五循环+清折叠保留查询/**搜索打字与 backspace 清折叠**/
  initialFilterMode 生效/就地改 label 后 rows 立即反映。
- settings.test.ts(+~6):treeFilterMode coerce(合法/非法/缺省)、嵌套
  branchSummary.skipPrompt(coerce/深合并/raw 未知键幸存/saveSettings 嵌套)。
- repl-commands.test.ts(+~6):skipPrompt=true 时 picker 流程无三选直接切;
  **skipPrompt=true 且 IMP_BRANCH_SUMMARY=0(env 仍赢:不问也不摘)**;
  treeFilterMode 喂选择器(拦截 treeSelect 断言 initialFilterMode;
  **project>global 优先**各一例);/settings treeFilterMode 值解析五字面;
  /fork 走 navigateTree;/fork editorText 回填。
- tree-nav.test.ts(+~3):forkSessionAt 与 navigateTree(user 消息,无摘要)
  结果等价(位置、history);**fork 最新未应答消息(leaf 目标)位置移动+
  editorText**(§4 P1 场景);非 user leaf 目标仍 noop。
- 预计 1104 → ~1131(含破改)。

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


## 4. 设计审查记录(2026-02-09,fresh-context reviewer)

判 needs-fixes:1 P1+4 P2+6 P3;§0 十行事实表全部复核无误,D1 就地改/D2 机制/
D4 LIVE 读/D5 正交性/D6 editorText 缺口与计数等价性均验证成立。逐项亲自核实后
全部采纳:

- **P1 D6 noop 映射错误**:navigateTree 的 noop 守卫是 target=leaf(非
  newLeaf=leaf);/fork 主场景(未应答的最新用户消息)恰是 target=leaf,
  合流即死路。修:放宽 navigateTree(user 消息 leaf 目标照常走)、D6 重写、
  等价测试钉死(§2 D6 noop 映射段)。
- **P2 mode 循环硬编码**:kind:"mode" 的 Enter 循环写死 all↔one-at-a-time,
  挂 treeFilterMode 会写非法值被 coerce 静默吞。修:SettingEntry.values 数组
  (pi 先例),parseSettingValue 唯一校验(§2 D4)。
- **P2 forkSessionAt 签名不可能保留**:sync 转发不了 async。修:async+结果
  联合+preview(§2 D6)。
- **P2 测试计划漏破改**:Tab 三循环断言、forked-before note 钉子
  (repl-commands+repl-tui)。修:D7 先列破改(§2 D7)。
- **P2 缺钉子**:L 带搜索激活、label-edit 嵌套吞键、skipPrompt×env=0、
  treeFilterMode project>global。修:D7 补(§2 D7)。
- **P3×6**:settingSource pick() 嵌套分支(§2 D5);appendLabelChange 回调
  try/catch + pi 先改内存后落库时序(§2 D1);状态行帮助串+模式标签映射
  `[labeled]`(§2 D3);pi 四处清折叠(搜索打字/退格/Esc 清)对齐(§2 D2);
  forkSessionAt 前置校验保留(§2 D6);skipPrompt LIVE 读明说(§2 D5)。
