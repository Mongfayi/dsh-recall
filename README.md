# dsh-recall（作者没有余额了，暂时停止更新）

对话撤回（recall）插件：把一条消息**及其之后的所有内容**从对话中移除——界面不再显示，模型也不再见——但**绝不回退任何代码/文件改动**。撤回以追加日志（append-only）中的一条持久墓碑事件（空内容 `assistant/message` 的 surface 替换）实现，重启后依然生效。

## 用法

会话空闲时：

- **用户消息**右侧的撤销按钮 → 确认 → 撤回该轮对话及其后的全部内容（你的提问与智能体的回复一并移除），**该条用户消息的文本会恢复到输入框**，可修改后重新发送（与 opencode 的撤回行为一致）。
- 撤回位置显示「已撤回的消息」提示。

智能体运行中撤销按钮禁用（先停止当前回合）。

## 实现

- **宿主端**（`lib/index.js`）：`POST /recall` 路由（`{sessionId, messageId}` 或 `{sessionId, boundary}`），校验后**完全用既有会话协议**完成撤回（rc.8 核心没有 `Session.recall`）：
  1. 边界必须是当前 surface 上的活跃消息节点（已撤回或被遮蔽 → `recall-rejected`）；
  2. 追加**一条**持久墓碑：空内容的 `assistant/message`，`surfaceOp` 为 `{op:'replace', start: boundary, end}` 且 `sourceEventSeqs` 覆盖全部被遮蔽节点——空内容 assistant 消息不派生任何消息，`deriveMessages()` 收缩到 boundary 之前（模型不再见到被撤回内容），日志记录一个不删；
  3. `data.recall = {boundary, end}` 标记墓碑（客户端提示节点），随常规 flush 持久化，重启后依然生效。
  错误码：`session-not-found` / `subagent-owned` / `agent-busy` / `message-not-found` / `recall-rejected`。
- **浏览器端**（`lib/client.js`）：以 `priority: -1` 覆盖 `conversation.chat.node` 的 `user` keyed 渲染器，在每条用户消息旁渲染撤销按钮（点击以该用户消息 seq 为边界撤回）。覆盖项**委托给框架自己的用户渲染器**（从席位注册中解析原组件；框架渲染器是 `react.memo` 对象而非普通函数，二者都接受）：气泡、复制按键、引用标签与图片画廊全部保持框架原样——撤销按钮定位在框架操作行的**同一行、复制按键左侧**（悬停时钟被抑制使操作行只剩复制键；`right:38px` = 复制键 28px + 10px 行间距，绝无遮挡）；图片也始终经框架的图片槽（`renderMessageImages`）渲染，绝不会因插件自带画廊加载器缺失 `loadImage` 而看不到图片。若框架渲染器无法解析（实际不会发生），回退到插件自带气泡，但图片仍走框架图片槽。「已撤回的消息」提示节点匹配墓碑事件（`assistant/message` + `data.recall`）注册到 `recall` key。被撤回区间（boundary..end，含端点）内的**每一种**对话节点都在装配期被隐藏——这是长上下文下能整轮撤回的关键：rc.8 的 slot core 禁止被遮蔽的条目重新声明已被框架条目声明的子槽位（否则启动即报 `slot "..." is already declared`），因此无法为每一种节点都套一个渲染器过滤器；改为在 `conversationEvents` 上**统一包装每一个框架对话定义**的 `buildViewNode`：调用原构建器后，只要该行的锚点 seq（`anchorSeq` 或 `data.seq` / `data.finalNode.seq` / `data.closing.finalNode.seq`）落在已撤回区间内就返回 `null`，其余行与框架输出完全一致。这样 steering / context / assistant-step / command / manual-compaction / compaction / model-retry / turn-error / turn-max-tokens / turn-tail / unknown / command-input / tool-call / workflow-run 等全部节点种类一视同仁，长对话里的子智能体指令、压缩、重试、工作流等都会被一并撤回，而不是只撤回首轮的部分内容。被撤回区间由本插件的 `recall` 定义在匹配墓碑事件（`data.recall = {boundary, end}`）时记录（墓碑与本批被撤回事件在同一装配轮次，视图节点只在轮次结束后构建，因此区间表在构建时总是完整的）；实时会话收到墓碑后，会通过重新注册本插件的 `recall` 定义触发一次会话装配重建，使被撤回行立即消失（无需刷新页面）。本插件的 `recall` 定义与 `user` 渲染器不参与包装。
  撤回提交成功后，被撤回用户消息会**整体恢复到输入框**：文本经 `conversation.input.for(scope).setDraft()` 写回；图片附件经 `conversation.resolveImage()`（会话授权 URL）→ `fetch` → `conversation.createDraftImages()` 注册为草稿图片，`addImages()` 挂到图片轨道（被撤回附件仍保留在 append-only 日志中，恢复有真实数据源；单张失败不影响其余恢复，也绝不回滚已完成的撤回）。
- **不依赖任何核心撤回协议**：不需要 `session/recall` 事件类型、`Session.recall` 或客户端窗口过滤——全部基于 rc.8 既有的 surface 替换协议与 keyed Chat Node 席位。

## 开发

```bash
node test/smoke-host.mjs    # 宿主路由：成功/拒绝路径
node test/smoke-client.mjs  # 客户端注册、定义、文案、确认门
```
