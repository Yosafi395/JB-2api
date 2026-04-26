# DECISIONS

项目级别的约束和设计决策。只追加不修改已有条目。

---

### D001 — tool_choice 通过 system prompt 注入实现
- 日期：2026-04-26
- 原因：JB Grazie API 没有原生 tool_choice 参数
- 方案：将 tool_choice 语义转为强指令文本，注入到最后一个 system message 中
- 覆盖：OpenAI 的 required / none / function 指定；Anthropic 的 any / tool 指定

### D002 — 工具调用时默认 max_tokens=16384
- 日期：2026-04-26
- 原因：write 等工具的 tool call 参数可能包含完整文件内容，需要大量输出空间
- 条件：仅当请求包含工具定义且客户端未指定 max_tokens 时生效

### D003 — cleanBody 保留 null 值
- 日期：2026-04-26
- 原因：OpenAI 协议要求 assistant 消息带 tool_calls 时 content 必须为 null
- 改动：cleanBody 只删除 undefined 和字符串 '[undefined]'，不删除 null

### D004 — JB finish reason "length" 正确映射
- 日期：2026-04-26
- OpenAI 路径：length → length
- Anthropic 路径：length → max_tokens
- 原因：之前统一映射为 stop/end_turn，客户端无法识别截断

### D005 — chatStream fetch 超时 300 秒
- 日期：2026-04-26
- 原因：无超时会导致请求永久挂住
- 值：300000ms（5 分钟），覆盖连接 + thinking 等待时间

### D006 — 三文件工作流
- 日期：2026-04-26
- SESSION_STATE.md：当前任务状态
- DECISIONS.md：项目约束和设计决策（只追加）
- CHANGELOG_AGENT.md：变更记录（时间倒序）

### D007 — 流读取异常在 converter 内部捕获
- 日期：2026-04-26
- 原因：for-await 遍历 jbStream 时上游关闭连接会抛 TypeError: terminated，若冒泡到路由 catch，已发送 headers 的流无法回退为 JSON 错误
- 方案：在 convertStreamToOpenAI / convertStreamToAnthropic 的 for-await 外包 try-catch，捕获后 fallthrough 到 !receivedFinish 逻辑，正常关闭 SSE
