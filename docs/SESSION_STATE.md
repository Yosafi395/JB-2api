# SESSION_STATE

## Goal
修复 JB-Shu 反向代理中所有影响 Kilo Code / Cursor 工具调用的问题，使 write 等工具能正常工作。

## InProgress
无（所有已知问题已修复）

## Done
- [x] tool_choice 支持（通过 system prompt 注入）
- [x] 转发 max_tokens / temperature / top_p / stop 到 JB parameters.data
- [x] 工具调用时自动设置 max_tokens=16384 防止截断
- [x] finish_reason 映射修复（length 不再错误映射为 stop）
- [x] 流异常中断检测（缺少 FinishMetadata 时报 length/max_tokens）
- [x] cleanBody 不再删除 null 值
- [x] usage token 估算（不再始终返回 0）
- [x] chatStream fetch 添加 5 分钟超时
- [x] 项目推送到 GitHub（Yosafi395/JB-Shu，私有）

## NextStep
部署后实际测试 Kilo Code 的 write 工具是否能正常完成写入。如果仍有截断，需检查 JB API 是否对 `llm.parameters.length` 有上限限制，以及是否需要更大的默认值。

## Verification
- 所有修改文件通过 `node -c` 语法检查
- 所有模块通过 `require()` 加载验证
- 已推送至 GitHub

## LastUpdated
2026-04-26T21:58+08:00
