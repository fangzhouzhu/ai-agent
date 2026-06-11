# Centibot Agent Runtime 落地文档

更新时间：2026-06-11

## 1. 本次实现范围

本次按优先级完成了 Agent 可靠性、安全与可观测性基础改造，重点覆盖：

- 工具安全策略与文件路径保护。
- 模型流式调用和工具调用 Trace。
- RAG 回答引用规则。
- 主系统提示词抽离。
- 诊断与工具策略只读 IPC。
- 最小评测样本。

已通过：

```bash
npm run typecheck
npm run build
```

## 2. 工具安全策略

新增文件：

- `src/main/tools/policy.ts`

核心能力：

- 定义 `ToolRisk` 与 `ToolPolicy`。
- 为文件、剪贴板、联网工具声明风险等级和确认需求。
- 阻止工具直接访问 Windows 系统保护目录。
- 限制 `read_file` 单文件读取大小为 1 MB。
- `delete_file` 改为移入回收站。
- 报告生成默认输出到应用数据目录下的 `ai-agent/artifacts`。

当前策略接口：

```ts
listToolPolicies(): ToolPolicy[]
summarizeToolPolicies(): string
resolveToolPath(inputPath: string): string
assertReadableFile(resolvedPath: string): void
ensureWritableTarget(resolvedPath: string): void
```

后续应接入 UI 确认卡片，处理 `requiresConfirmation` 为 `true` 的工具调用。

## 3. Trace 与错误模型

新增文件：

- `src/main/runtime/errors.ts`
- `src/main/runtime/trace.ts`

错误结构：

```ts
type AppError = {
  code: string;
  message: string;
  detail?: string;
  retryable?: boolean;
  source: "model" | "tool" | "rag" | "storage" | "network" | "unknown";
};
```

Trace 事件覆盖：

- `model_start`
- `model_end`
- `tool_start`
- `tool_end`
- `error`

已接入位置：

- `streamFromOllama`
- OpenAI-compatible 工具调用
- Ollama 工具调用
- URL 和天气预调用工具

新增 IPC：

```ts
tools:list-policies
diagnostics:list-traces
diagnostics:get-trace
```

Renderer 可通过 `window.electronAPI.listToolPolicies()` 和 `window.electronAPI.diagnostics.*` 调用。

## 4. Prompt 抽离

新增文件：

- `src/main/prompts/agentPrompts.ts`

导出：

```ts
BASE_CHAT_SYSTEM_PROMPT
TOOL_SYSTEM_PROMPT
RAG_CITATION_PROMPT
buildRuntimeContextPrompt(enableTools)
```

收益：

- 主流程 `agent.ts` 不再内嵌大段提示词。
- 工具调用规则、实时信息规则、RAG 引用规则统一维护。
- 后续可继续拆分为 `chat.ts`、`agent.ts`、`rag.ts`、`task.ts` 并加入版本号。

## 5. RAG 引用

已更新：

- 临时文件 RAG：检索上下文使用 `[chunk.index] Source: fileName` 格式。
- 持久知识库 RAG：检索上下文包含来源、知识库名称、相关度。
- 回答规则要求正文引用 `[1]` 形式编号，并在末尾输出“依据”小节。

后续建议：

- 将引用结果结构化返回给 UI。
- 在消息侧边栏展示 chunk 预览、分数和知识库名称。
- 增加 rerank 与 answerability check。

## 6. 最小评测集

新增文件：

- `evals/agent-routing.json`
- `evals/rag-citations.json`

覆盖方向：

- 普通聊天不误入工具模式。
- URL 必须触发 `fetch_url`。
- 明确算式应触发 `calculator`。
- RAG 回答必须包含引用和依据。

后续可增加 `scripts/run-evals.ts`，把这些样本接入真实模型和工具回归。

## 7. 下一阶段建议

优先继续做三件事：

1. 工具确认 UI：展示工具名、参数、风险等级、允许/拒绝。
2. `ToolExecutor`：把聊天、任务中心、预调用工具统一走同一个执行器。
3. `Trace` 面板：设置中心新增“日志与诊断”，支持查看和导出最近 Trace。

这三项完成后，再推进 MCP 连接器、任务 checkpoint 和浏览器 Agent 会更稳。

## 8. P1 追加实现

本轮继续补齐了 P1 的第一层运行时能力：

- 新增 `src/main/runtime/ToolExecutor.ts`，聊天、预调用工具和任务中心均通过统一执行器调用工具。
- 任务状态扩展为 `waiting_for_approval`、`waiting_for_input`、`blocked`。
- 任务增加 `checkpoint` 字段，记录当前节点、轮次、工具调用次数和恢复状态。
- 应用重启后，运行中/等待中的任务不再直接标记失败，而是进入 `blocked`。
- 设置中心新增“工具权限”和“日志诊断”菜单。
- 新增 `npm run evals`，校验 `evals/*.json` 的基础结构。

当前 checkpoint 仍是线性任务循环的断点元数据，不是完整 DAG 恢复。下一步应将任务执行改造为显式节点：

```text
plan -> collect -> analyze -> generate_artifact -> verify -> final
```

完成后 `resumeTask` 才能从失败节点精确继续，而不是在保留历史步骤后重新推进。
