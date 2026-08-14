# dsh-recall

对话撤回（recall）插件：把一条消息**及其之后的所有内容**从对话中移除——界面不再显示，模型也不再见——但**绝不回退任何代码/文件改动**。撤回以追加日志（append-only）中的 `session/recall` 墓碑事件持久化，重启后依然生效。

## 用法

会话空闲时：

- **用户消息**右侧的撤销按钮 → 确认 → 撤回该轮对话及其后的全部内容（你的提问与智能体的回复一并移除），**该条用户消息的文本会恢复到输入框**，可修改后重新发送（与 opencode 的撤回行为一致）。
- 撤回位置显示「已撤回的消息」提示。

智能体运行中撤销按钮禁用（先停止当前回合）。

## 实现

- **宿主端**（`lib/index.js`）：`POST /recall` 路由（`{sessionId, messageId}` 或 `{sessionId, boundary}`），校验后调用 `session.recall(boundary)` 并 flush。错误码：`session-not-found` / `subagent-owned` / `agent-busy` / `message-not-found` / `recall-rejected`。
- **浏览器端**（`lib/client.js`）：以 `priority: -1` 覆盖 `conversation.chat.node` 的 `user` keyed 渲染器，在每条用户消息旁渲染撤销按钮（点击以该用户消息 seq 为边界撤回），并复刻框架的用户气泡外观；「已撤回的消息」提示节点通过 `session/recall` 事件定义注册到 `recall` key。撤回提交成功后，被撤回用户消息的文本经 `conversation.input.for(scope).setDraft()` 写回输入框（仅文本，图片不恢复）。
- **依赖的核心协议**（无插件接缝，需 dsh 运行时内置）：`dsh-session` 的 `session/recall` 事件类型 + surface 折叠召回支持；`dsh-client-runtime` 对已撤回事件的窗口过滤。

## 开发

```bash
node test/smoke-host.mjs    # 宿主路由：成功/拒绝路径
node test/smoke-client.mjs  # 客户端注册、定义、文案、确认门
```
