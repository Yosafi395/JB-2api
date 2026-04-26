# CHANGELOG_AGENT

变更记录，按时间倒序追加。

---

## 2026-04-26T22:06 — 修复流 "terminated" 错误导致未完成 SSE

### 修改文件
- `src/converter/jb-to-openai.js` — for-await 循环包裹 try-catch
- `src/converter/jb-to-anthropic.js` — for-await 循环包裹 try-catch

### 关键改动
1. 上游连接中断（TypeError: terminated）不再冒泡到路由 catch
2. 中断后 fallthrough 到已有的 `!receivedFinish` 处理：发送 finish_reason=length 并正常关闭 SSE（[DONE] / message_stop）
3. 客户端不再收到不完整的 SSE 流

### 验证
- `node -c` 语法检查通过
- `require()` 模块加载通过
- Git commit 6b7096e

---

## 2026-04-26 — 全面修复工具调用兼容性

### 修改文件
- `src/converter/tools.js` — 新增 buildCommonParams / buildToolChoiceHint / 修改 buildParametersData
- `src/converter/openai-to-jb.js` — 转发所有参数 + tool_choice 注入
- `src/converter/anthropic-to-jb.js` — 转发所有参数 + tool_choice 注入
- `src/converter/jb-to-openai.js` — finish_reason 映射修复 + 流中断检测 + usage 估算
- `src/converter/jb-to-anthropic.js` — stop_reason 映射修复 + 流中断检测 + usage 估算
- `server.js` — cleanBody 不再删除 null
- `src/jb-client.js` — chatStream 添加 5 分钟超时
- `src/routes/openai.js` — 传递 promptCharCount
- `src/routes/anthropic.js` — 传递 promptCharCount

### 关键改动
1. tool_choice 通过 system prompt 注入（D001）
2. 工具调用时自动 max_tokens=16384（D002）
3. finish_reason length 正确映射（D004）
4. 流异常中断时发送 finish_reason=length 告知客户端
5. cleanBody 保留 null（D003）
6. chatStream 添加 AbortController 超时（D005）

### 验证
- `node -c` 语法检查：全部通过
- `require()` 模块加载：全部通过
- 推送至 GitHub：Yosafi395/JB-Shu（私有）
