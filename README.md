# dsh-recall

对话撤回（recall）插件：把一条消息**及其之后的所有内容**从对话中移除——界面不再显示、模型不再可见——但**绝不回退任何代码/文件改动**。撤回通过追加日志（append-only）中的一条持久墓碑事件实现，重启后依然生效。

> **v0.3.0：已适配 DSH 0.2.0-rc.2**（桌面端 / Web 同一套运行时）。0.1.x 时代的实现依赖三处已被移除或收紧的协议（`session.events`、`{op:'replace', start, end}`、空内容 `assistant/message` 墓碑），本版按 0.2.0-rc.2 的现行契约重写，并新增了持久化往返测试。旧版 DSH 请用 `v0.2.0` 标签。

## 功能特性

- **整轮撤回**：点击用户消息旁的撤销按钮（复制键左侧），撤回该轮对话及其后的全部内容——你的提问与智能体的回复一并移除；长对话中的子智能体指令、压缩、重试、工作流等也都会被一并撤回。
- **恢复编辑**：撤回后，被撤回用户消息的**文本与图片整体恢复到输入框**，可修改后重新发送（与 opencode 的撤回行为一致）。
- **不破坏界面**：撤回按钮与框架的复制按钮**同一行、互不遮挡**；消息气泡、复制键、引用标签、图片画廊全部保持框架原样；含图片的消息始终正常显示图片。
- **持久且可追溯**：撤回记录是一条持久墓碑事件，随会话日志 flush 持久化，重启后依然生效；日志记录一个不删。

## 使用

1. 会话空闲时，点击**用户消息**旁的撤销按钮（复制键左侧）；
2. 确认弹窗后，该轮对话及其后的全部内容被撤回；
3. 撤回位置显示「已撤回的消息」提示；
4. 被撤回消息的文本与图片恢复到输入框，可修改后重新发送。

> 智能体运行中撤销按钮会禁用（先停止当前回合再撤回）。

## 工作原理

### 宿主端（`lib/index.js`）

提供 `POST /recall` 路由（`{sessionId, messageId}` 或 `{sessionId, boundary}`），完全基于既有会话协议完成撤回（框架核心没有 `Session.recall`）：

1. **校验边界**：边界必须是当前 surface 上的活跃消息节点（已撤回或被遮蔽 → `recall-rejected`）；
2. **追加墓碑**：追加**一条**持久墓碑——空内容的 `system/message`，`surfaceOp` 为 `{op:'replace', startSeq: boundary, endSeq: end}` 且 `sourceEventSeqs` 覆盖全部被遮蔽节点（`session.surface.nodes.slice(startIdx)`）。空内容 system 消息不派生任何消息，模型可见历史收缩到 boundary 之前；
3. **标记与持久化**：`data.recall = {boundary, end}` 标记墓碑（客户端提示节点），随常规 flush 持久化。

0.2.0-rc.2 的三处硬约束决定了墓碑的确切形状：

- 位置替换现在写作 `startSeq`/`endSeq`（旧的 `start`/`end` 会被判为 `invalid replace surfaceOp`）；
- 替换必须用 `sourceEventSeqs` 覆盖每一个被遮蔽的 surface 节点；
- `assistant/message` **不允许**携带 `sourceEventSeqs`（"embeds its source stream"），因此旧的空 assistant 墓碑在 0.2.x 根本无法表达——而且它还会在会话重载时被 `assertAssistantSettlementShape` 拒绝。`system/message` 是既能在空内容下不派生消息、又能引用来源的消息类型。
- 持久格式 v4 还要求每条 `system/message` 携带**正整数** `turn`/`step`：墓碑沿用被撤回消息自身的坐标（缺失时回退到其所属回合与该回合第 1 步）。墓碑不携带任何工具调用，不带独立 step 语义。

宿主端只调用 `session.surface` / `session.log` / `session.append` / `sessions.flush`，**不再 `import '@deepseek-ai/dsh-session'`**（`isAppendSurfaceEvent` 与消息投影改为内联/走 `session.surface.deriveEventMessage`），因此插件装进 profile 后不再需要指向 dsh 源码的符号链接。

错误码：`session-not-found` / `subagent-owned` / `agent-busy` / `message-not-found` / `recall-rejected`。

### 浏览器端（`lib/client.js`）

- **撤回按钮**：以 `priority: -1` 覆盖 `conversation.chat.node` 的 `user` keyed 渲染器。覆盖项**委托给框架自己的用户渲染器**（从席位注册中解析原组件；框架渲染器是 `react.memo` 对象而非普通函数，二者都接受），气泡、复制按键、引用标签与图片画廊全部保持框架原样。撤销按钮定位在框架操作行**同一行、复制按键左侧**——悬停时钟被抑制使操作行只剩复制键，`right:38px` 即复制键 28px + 10px 行间距，绝无遮挡。
- **图片渲染**：始终经框架的图片槽 `renderMessageImages` 渲染（会话授权，标签/灯箱框架原样），不依赖插件自带的画廊加载器——原实现里 `loadImage` 并不在渲染器 props 中，必然加载失败导致图片不可见。
- **整轮隐藏**：被撤回区间（boundary..end，含端点）内的**每一种**对话节点都在装配期被隐藏。框架的 slot core 禁止被遮蔽的条目重新声明已被框架条目声明的子槽位，因此不能为每种节点套一个渲染器过滤器；改为在 `uiConversation.events` 上**统一包装每个框架对话定义的 `buildViewNode`**：调用原构建器后，只要该行的锚点 seq（`anchorSeq` / `data.seq` / `data.finalNode.seq` / `data.closing.finalNode.seq`）落在已撤回区间内就把该节点标记 `visibility: "hidden"`（保留 key 与 kind），其余行与框架输出完全一致。这覆盖 steering / context / assistant-step / command / manual-compaction / compaction / model-retry / turn-error / turn-max-tokens / turn-tail / unknown / command-input / tool-call / workflow-run 等全部节点种类。
  0.2.x 把"隐藏"变成了显式契约：视图节点带 `visibility: "visible" | "hidden"`，而**撤回一个已经物化的 target 时返回 `null` 会直接抛错**（"return the same key with hidden visibility instead"），所以这里返回的是同一个节点加上 `visibility: "hidden"`。
- **「已撤回的消息」提示**：`recall` 定义匹配墓碑事件（`system/message` + `data.recall`）注册提示节点。
- **实时更新**：墓碑到达实时会话后，通过重新注册本插件的 `recall` 定义触发一次会话装配重建，被撤回行立即消失（无需刷新页面）。
- **恢复输入框**：文本经 `conversation.input.for(scope).setDraft()` 写回；图片经会话远程 `sessions.binding(sessionId).session.readAttachment()` 取回字节 → `conversation.createDrafts(sessionId, [file])` 注册为浏览器侧草稿附件 → `facade.addAttachments(ids)` 挂到输入框。0.2.x 移除了旧的 `createDraftImages` / `addImages` 组合，改由草稿附件注册表承担；`addAttachments` 拒绝时（输入框正在提交/裁决）会把刚创建的草稿 `releaseDraftAttachments` 掉，不泄漏 object URL。被撤回附件仍保留在 append-only 日志中，恢复有真实数据源；单张失败不影响其余恢复，也绝不回滚已完成的撤回。

## 兼容性

- 不需要 `session/recall` 事件类型、`Session.recall` 或客户端窗口过滤——全部基于框架既有的 surface 替换协议与 keyed Chat Node 席位。
- **已适配并验证于 DSH `0.2.0-rc.2`**（桌面端 `dsh-desktop-runtime 0.2.0-rc.2`）。相对 0.1.x 的适配点：
  - `session.events` 已移除 → 改用 `session.log`，消息投影走 `session.surface.deriveEventMessage`；
  - 替换操作符改为 `{op:'replace', startSeq, endSeq}`；
  - 墓碑类型由 `assistant/message` 改为 `system/message`（上文"工作原理"）；
  - 客户端草稿图片 API 由 `createDraftImages`/`addImages` 改为 `createDrafts`/`addAttachments`；
  - 行隐藏由 `buildViewNode` 返回 `null` 改为 `{...node, visibility:'hidden'}`；
  - 插件不再依赖 `@deepseek-ai/dsh-session`，无需符号链接或声明运行时依赖（宿主进程自带运行时解析）。
- 0.1.x（`0.1.1-rc.1` … `0.1.2-alpha.1`）请使用 `v0.2.0` 标签：那一版走的是旧协议，在 0.2.0-rc.2 上会因上面的三处约束直接失败。

## 开发

```bash
npm install                 # 安装 0.2.0-rc.2 线的框架包（仅测试用）
npm test                    # 三个 smoke 全跑
```

| 测试 | 覆盖 |
|---|---|
| `test/smoke-host.mjs` | 宿主路由的成功/拒绝路径，墓碑形状，以及**把整条日志送回 `Session.create` 种子校验**（`assertAssistantSettlementShape` / surface 折叠） |
| `test/smoke-durable.mjs` | **持久化往返**：`encodeCurrentEvent` → JSON → `assertV4RowAdmission` → `validateStoredEvents` → 重建会话，证明墓碑能挺过重启（v4 要求正整数 `turn`/`step`，这条测试就是抓这个的） |
| `test/smoke-client.mjs` | 客户端注册、定义匹配、文案、确认门、席位委托、`visibility` 隐藏、文本/图片恢复到输入框 |

## 安装

```bash
dsh plugin --profile desktop add <本仓库路径>   # 桌面端
dsh plugin --profile web add <本仓库路径>       # dsh web
```

装完重启 DSH 生效；卸载把 `add` 换成 `remove`。
