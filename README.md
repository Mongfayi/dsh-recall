# dsh-recall（作者有余额了就更新）

对话撤回（recall）插件：把一条消息**及其之后的所有内容**从对话中移除——界面不再显示、模型不再可见——但**绝不回退任何代码/文件改动**。撤回通过追加日志（append-only）中的一条持久墓碑事件实现，重启后依然生效。

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
2. **追加墓碑**：追加**一条**持久墓碑——空内容的 `assistant/message`，`surfaceOp` 为 `{op:'replace', start: boundary, end}` 且 `sourceEventSeqs` 覆盖全部被遮蔽节点。空内容 assistant 消息不派生任何消息，模型可见历史收缩到 boundary 之前；
3. **标记与持久化**：`data.recall = {boundary, end}` 标记墓碑（客户端提示节点），随常规 flush 持久化。

错误码：`session-not-found` / `subagent-owned` / `agent-busy` / `message-not-found` / `recall-rejected`。

### 浏览器端（`lib/client.js`）

- **撤回按钮**：以 `priority: -1` 覆盖 `conversation.chat.node` 的 `user` keyed 渲染器。覆盖项**委托给框架自己的用户渲染器**（从席位注册中解析原组件；框架渲染器是 `react.memo` 对象而非普通函数，二者都接受），气泡、复制按键、引用标签与图片画廊全部保持框架原样。撤销按钮定位在框架操作行**同一行、复制按键左侧**——悬停时钟被抑制使操作行只剩复制键，`right:38px` 即复制键 28px + 10px 行间距，绝无遮挡。
- **图片渲染**：始终经框架的图片槽 `renderMessageImages` 渲染（会话授权，标签/灯箱框架原样），不依赖插件自带的画廊加载器——原实现里 `loadImage` 并不在渲染器 props 中，必然加载失败导致图片不可见。
- **整轮隐藏**：被撤回区间（boundary..end，含端点）内的**每一种**对话节点都在装配期被隐藏。框架的 slot core 禁止被遮蔽的条目重新声明已被框架条目声明的子槽位，因此不能为每种节点套一个渲染器过滤器；改为在 `conversationEvents` 上**统一包装每个框架对话定义的 `buildViewNode`**：调用原构建器后，只要该行的锚点 seq（`anchorSeq` / `data.seq` / `data.finalNode.seq` / `data.closing.finalNode.seq`）落在已撤回区间内就返回 `null`，其余行与框架输出完全一致。这覆盖 steering / context / assistant-step / command / manual-compaction / compaction / model-retry / turn-error / turn-max-tokens / turn-tail / unknown / command-input / tool-call / workflow-run 等全部节点种类。
- **「已撤回的消息」提示**：`recall` 定义匹配墓碑事件（`assistant/message` + `data.recall`）注册提示节点。
- **实时更新**：墓碑到达实时会话后，通过重新注册本插件的 `recall` 定义触发一次会话装配重建，被撤回行立即消失（无需刷新页面）。
- **恢复输入框**：文本经 `conversation.input.for(scope).setDraft()` 写回；图片经 `conversation.resolveImage()`（会话授权 URL）→ `fetch` → `conversation.createDraftImages()` 注册为草稿图片，`addImages()` 挂到图片轨道。被撤回附件仍保留在 append-only 日志中，恢复有真实数据源；单张失败不影响其余恢复，也绝不回滚已完成的撤回。

## 兼容性

- 不需要 `session/recall` 事件类型、`Session.recall` 或客户端窗口过滤——全部基于框架既有的 surface 替换协议与 keyed Chat Node 席位。
- 已适配并验证于 DSH `0.1.1-rc.1` 与 `0.1.1-rc.2`（相关 API 无破坏性变化）。

## 开发

```bash
node test/smoke-host.mjs    # 宿主路由：成功/拒绝路径
node test/smoke-client.mjs  # 客户端注册、定义、文案、确认门、委托/图片/恢复
```
