# Centibot Agent 产品与架构优化建议

更新时间：2026-06-11

## 1. 结论摘要

Centibot 已经具备本地 AI Agent 的雏形：Electron 桌面端、Ollama 与 OpenAI-compatible 双模型来源、对话持久化、工具调用、任务中心、知识库 RAG、Skills 提示词中心、PDF/PPT 生成工具以及近期完成的浅色工作台 UI。

下一阶段不建议继续堆更多零散工具，而应优先把系统从“规则拼接式 Agent”升级为“可治理的 Agent Runtime”。市面优秀 Agent 产品的核心不是工具数量，而是以下能力的稳定组合：

- 可解释的任务规划、执行轨迹和结果引用。
- 持久任务、可恢复执行、失败重试和断点续跑。
- 人工确认、权限边界、工具沙箱和高风险操作审计。
- 连接器生态，例如 MCP、文件系统、浏览器、办公套件、代码仓库。
- 长短期记忆、项目上下文、用户偏好和知识库融合。
- 评测体系、回归测试、可观测性和成本/延迟控制。

建议优先级：

1. P0：修复源码中文乱码、工具安全边界、Agent 运行时状态机、RAG 引用与评测。
2. P1：引入 MCP/连接器层、任务断点续跑、人工确认机制、统一 Trace。
3. P2：加入浏览器自动化、工作流模板、长期记忆、团队/项目空间。
4. P3：插件市场、多 Agent 协作、企业权限与同步。

## 2. 市面优秀 Agent 的能力基线

以下基线来自主流 Agent 产品和框架的公开资料与行业实践：

- OpenAI ChatGPT Agent / Operator 类产品强调浏览器、工具、连接器、任务执行和用户可接管的交互式代理体验。
- Anthropic Claude Computer Use 和 Tool Use 体系强调模型可调用外部工具、计算机操作能力、明确工具 schema 和安全边界。
- LangGraph 强调 durable execution、human-in-the-loop、memory、checkpoint，以及长期运行 Agent 的状态恢复。
- Google Agent Development Kit 强调 Agent、Tool、Session、Memory 和多组件协作的应用级开发模型。
- Cursor、Devin 等工程 Agent 强调代码仓库上下文、后台任务、可审查 diff、自动测试、失败修复循环和开发者接管。

可落到 Centibot 的产品标准：

| 能力 | 当前状态 | 建议目标 |
| --- | --- | --- |
| 对话 | 已有流式聊天和多模型配置 | 增加模型性能指标、上下文窗口管理、引用来源 |
| 工具调用 | 已有文件、Web、系统、报告工具 | 增加权限、确认、沙箱、工具注册中心 |
| 长任务 | 已有任务中心 | 改为可恢复任务图，支持断点、重试、重放 |
| RAG | 已有临时 RAG 与持久知识库 | 增加引用、重排、增量索引、质量评测 |
| Skills | 已有本地技能配置 | 升级为可版本化 Skill/Workflow 模板 |
| 连接器 | 暂无标准连接器层 | 支持 MCP，本地/远程工具统一接入 |
| 安全 | 当前偏弱 | 引入危险操作确认和路径权限策略 |
| 可观测性 | UI 有工具过程展示 | 增加统一 Trace、日志、导出和错误诊断 |
| 评测 | 暂无 | 建立 Agent/RAG/工具回归集 |

## 3. 当前项目现状

### 3.1 架构概览

核心模块：

- `src/main/index.ts`：Electron 主进程、IPC、模型路由、RAG 路由、任务/知识库 API。
- `src/main/agent.ts`：聊天、Agent 工具调用、RAG 对话、模型配置。
- `src/main/taskRunner.ts`：后台任务中心、任务状态、计划、工具调用、输出文件。
- `src/main/tools/*`：文件、Web、系统、报告生成工具。
- `src/main/rag*.ts`：临时 RAG、持久知识库、索引、检索、向量存储。
- `src/main/storage.ts`：对话、设置、Skills、知识库 UI 状态本地存储。
- `src/preload/index.ts`：Renderer 可用的 Electron API。
- `src/renderer/src/*`：React UI、聊天、知识库、任务、设置。

### 3.2 已有优势

- 本地优先：支持 Ollama，本地文件和知识库能力符合桌面 Agent 的使用场景。
- OpenAI-compatible：已支持第三方模型配置和 API 测试，扩展性基础较好。
- 工具范围实用：文件、搜索、网页抓取、天气、汇率、报告生成覆盖常见办公场景。
- 后台任务中心：已经有任务状态、暂停、恢复、取消、重跑和进度展示。
- 知识库体系：持久 KB、文档复制、去重、向量索引、混合检索和 UI 阈值调节已经成形。
- UI 方向正确：新 UI 更接近现代 Agent 工作台，有侧栏、任务中心、知识库和设置中心。

### 3.3 主要短板

1. 源码中文乱码严重。

当前大量中文提示词、注释、状态文案在源码读取中呈乱码。即使运行时可能正常，这也会影响后续维护、提示词迭代、错误排查和团队协作。Agent 产品高度依赖提示词质量，这属于基础工程风险。

2. Agent Runtime 缺少统一状态机。

当前 `agent.ts`、`index.ts`、`taskRunner.ts` 都有路由、工具循环、提示词和错误兜底逻辑。规则分散后会导致行为不一致，例如普通聊天、工具聊天、RAG 和任务中心的工具策略并不完全统一。

3. 工具安全边界不足。

`fileTools.ts` 支持读、写、删任意解析后的路径。对桌面 Agent 来说，这需要权限策略、工作区白名单、用户确认和审计记录。尤其是删除文件、写入文件、剪贴板、打开路径、网络抓取，都应分级治理。

4. 长任务不是 durable execution。

`taskRunner.ts` 可以持久化任务，但应用重启后运行中任务直接标记失败，不能断点恢复。任务执行也不是图结构，不能清晰重放某一步、替换失败工具结果或从中间继续。

5. RAG 缺少可验证引用。

检索结果会注入上下文，但最终回答没有强制引用 chunk 编号、文档名、分数和片段边界。用户很难判断答案来源，RAG 幻觉也不易定位。

6. Web 工具偏脆弱。

搜索依赖 DuckDuckGo HTML 和 Bing RSS，网页正文提取使用正则清理 HTML，面对 SPA、反爬、复杂网页、编码和正文抽取质量会不稳定。缺少来源质量排序、时间过滤和引用规范。

7. 缺少评测体系。

目前没有单元测试、集成测试、Agent 任务回归集或 RAG 检索评测。Agent 行为高度非确定，没有评测就很难持续优化提示词和路由规则。

8. IPC/API 过宽。

`preload` 暴露了较多能力，缺少权限分层、参数验证、调用审计和错误标准化。对 Electron 桌面应用，这是安全和可维护性重点。

## 4. 优化方向

### 4.1 P0：基础可靠性与安全

#### 4.1.1 修复编码与提示词可维护性

目标：

- 所有源码、提示词、注释、UI 文案统一为 UTF-8。
- 将大段系统提示词从业务代码中抽离到 `src/main/prompts/*.ts` 或 `resources/prompts/*.md`。
- 为提示词添加版本号和变更记录。

建议实现：

- 新建 `src/main/prompts/chat.ts`、`agent.ts`、`rag.ts`、`task.ts`。
- 每个 prompt 导出结构化配置：

```ts
export const agentPrompt = {
  version: "2026-06-11",
  locale: "zh-CN",
  content: `...`,
};
```

验收标准：

- `rg "�|鈥|锛|绛|鐭"` 不再命中业务提示词。
- 所有模型路由场景显示为正常中文。

#### 4.1.2 引入工具权限策略

建议新增 `src/main/tools/policy.ts`：

```ts
export type ToolRisk = "read" | "write" | "delete" | "network" | "system";

export type ToolPolicy = {
  name: string;
  risk: ToolRisk[];
  requiresConfirmation: boolean;
  allowedRoots?: string[];
};
```

规则：

- `read_file`：默认只允许用户选择的工作区或显式授权路径。
- `write_file`：写入项目外路径前确认。
- `delete_file`：始终确认，并进入回收站优先，不直接 `unlinkSync`。
- `clipboard_copy`：确认后执行。
- `web_search` / `fetch_url`：记录 URL 和来源。

UI 调整：

- 当工具需要确认时，聊天区展示确认卡片：工具名、参数、风险、允许/拒绝。
- 任务中心遇到确认时进入 `waiting_for_approval` 状态。

#### 4.1.3 统一错误模型

当前错误大多是字符串拼接。建议定义：

```ts
type AppError = {
  code: string;
  message: string;
  detail?: string;
  retryable?: boolean;
  source: "model" | "tool" | "rag" | "storage" | "network";
};
```

收益：

- UI 可以用统一错误卡片展示。
- 任务中心可以判断是否可重试。
- 日志和评测可归因。

### 4.2 P1：Agent Runtime 重构

#### 4.2.1 建立统一 AgentSession

建议新建 `src/main/runtime/`：

```text
runtime/
  AgentSession.ts
  ModelRouter.ts
  ToolRegistry.ts
  ToolExecutor.ts
  TraceStore.ts
  CheckpointStore.ts
```

核心职责：

- `AgentSession`：管理一次对话或任务的完整生命周期。
- `ModelRouter`：统一 chat / agent / rag / skill 的模型选择。
- `ToolRegistry`：注册工具 schema、风险等级、handler、展示元信息。
- `ToolExecutor`：执行工具，处理超时、确认、取消、错误、审计。
- `TraceStore`：记录模型请求、工具调用、结果、耗时、token、错误。
- `CheckpointStore`：任务图的中间状态持久化。

#### 4.2.2 从循环式任务升级为任务图

当前 `runTaskWithOpenAI` 是最多 20 轮循环。建议改成显式 DAG/状态图：

```text
plan -> collect -> analyze -> generate_artifact -> verify -> final
```

每个节点包含：

- 输入状态。
- 可用工具。
- 最大重试次数。
- 退出条件。
- checkpoint。

这样可以支持：

- 失败节点单独重跑。
- 应用重启后从 checkpoint 恢复。
- UI 展示“当前节点”和“下一步”。
- 用户可以插入反馈修改计划。

#### 4.2.3 Human-in-the-loop

新增任务状态：

- `waiting_for_approval`
- `waiting_for_input`
- `blocked`

典型场景：

- 删除/覆盖文件。
- 访问敏感路径。
- 长时间联网搜索。
- 发送外部请求携带用户文件内容。
- 任务计划不明确，需要用户补充目标。

### 4.3 P1：RAG 质量升级

#### 4.3.1 强制引用与答案证据

最终回答应支持：

```text
结论...

依据：
[1] 文档A.pdf / 第 3 片段 / 相似度 0.82
[2] 文档B.docx / 第 8 片段 / 相似度 0.77
```

UI 可展示：

- 来源文档。
- chunk 预览。
- 相似度。
- 点击定位到文档片段。

#### 4.3.2 检索链路拆分

推荐管线：

```text
query rewrite -> hybrid retrieve -> rerank -> context pack -> answer -> cite
```

新增能力：

- Query rewrite：将“这个文件讲了什么”改写为包含文档名/主题的检索 query。
- Rerank：本地可先用轻量 cross-encoder 或 LLM rerank。
- Context packing：按来源去重，避免同一文档重复片段挤占上下文。
- Answerability check：判断证据是否足够，不足时明确说明。

#### 4.3.3 索引可维护性

建议：

- 文档索引任务进入任务中心，而不是只靠 KB 页面进度。
- 支持重新分块参数后批量重建。
- 支持文件变更检测、hash 去重、增量更新。
- 支持导出/导入知识库。

### 4.4 P1：连接器与 MCP

Centibot 当前工具是内置数组 `allTools`。建议新增连接器层：

```text
connectors/
  mcp/
  local-files/
  browser/
  office/
  git/
```

第一阶段可做：

- MCP client：读取本地 MCP server 配置，加载 tools/resources。
- Tool schema 标准化：所有工具都映射到统一 `ToolDescriptor`。
- UI 设置页增加“连接器”菜单。

收益：

- 不需要每个外部系统都写死到主进程。
- 可以接入数据库、浏览器、GitHub、Notion、飞书、企业内部工具。
- 与 Agent 生态对齐。

### 4.5 P2：浏览器与电脑操作能力

建议不要直接做“任意电脑控制”，先做受控浏览器 Agent：

- Playwright 驱动独立浏览器上下文。
- 页面截图、DOM 摘要、点击、输入、下载。
- 明确禁止自动提交支付、登录、敏感表单。
- 用户可接管浏览器。

产品入口：

- “网页任务”模板：搜索资料、比价、整理表格、下载公开 PDF。
- 任务中心展示浏览器截图和当前动作。

### 4.6 P2：记忆系统

建议分三层：

1. 会话短期记忆：当前对话摘要，控制上下文长度。
2. 用户偏好记忆：语言、格式、常用模型、写作风格、常用路径。
3. 项目记忆：当前项目文件、知识库、任务成果、生成报告。

存储：

- `memory/user.json`
- `memory/projects/{projectId}.json`
- 可选向量化记忆。

需要 UI：

- 设置中查看/删除记忆。
- 每条记忆显示来源和更新时间。

### 4.7 P2：评测与可观测性

建议新增：

```text
evals/
  agent-routing.json
  tool-calls.json
  rag-retrieval.json
  task-workflows.json
```

评测维度：

- 路由是否正确：普通聊天、RAG、工具、复杂任务。
- 工具参数是否正确。
- RAG 是否命中预期文档片段。
- 任务是否生成预期文件。
- 错误是否可读且可恢复。

可观测性：

- 每次请求生成 trace id。
- 记录模型、耗时、工具、错误、输出文件。
- 支持从 UI 导出诊断包。

## 5. 具体功能新增建议

### 5.1 设置中心新增菜单

建议左侧设置菜单扩展为：

- 模型与 API
- Skills
- 连接器
- 工具权限
- 知识库
- 记忆
- 日志与诊断
- 关于与更新

### 5.2 工具市场 / 连接器中心

功能：

- 展示内置工具和 MCP 工具。
- 每个工具可启用/禁用。
- 配置权限等级。
- 测试工具调用。
- 查看最近调用记录。

### 5.3 任务模板

内置模板：

- 研究报告：搜索 -> 抓取 -> 摘要 -> PDF。
- 文档审阅：上传 -> 提取问题 -> 修改建议。
- 数据整理：读取 CSV/Excel -> 分析 -> 图表/报告。
- 网页资料归档：URL 列表 -> 抓取 -> 知识库。
- 代码审查：选择目录 -> 分析 -> 生成报告。

### 5.4 任务计划编辑器

在任务启动前让模型生成计划，用户可编辑：

- 删除步骤。
- 调整顺序。
- 指定输出格式。
- 限制搜索来源。
- 设置最大工具调用次数。

### 5.5 结果资产库

保存任务生成的 PDF/PPT/Markdown/数据文件：

- 按任务聚合。
- 支持打开、复制路径、重新生成。
- 支持加入知识库。

### 5.6 RAG 引用阅读器

回答后侧边栏展示引用：

- 文档名。
- chunk 分数。
- 原文片段。
- 所属知识库。
- “用这个片段继续提问”。

### 5.7 模型质量面板

展示每个模型：

- 最近成功率。
- 平均响应时间。
- 工具调用成功率。
- RAG 回答失败率。
- 用户手动评分。

## 6. 建议实施路线图

### 阶段 1：可靠性修复，1-2 周

目标：让现有能力稳定、可维护、安全。

任务：

- 修复源码中文乱码和提示词抽离。
- 建立 ToolPolicy 和高风险操作确认。
- 统一错误模型。
- 为模型路由、工具调用、RAG 检索写最小测试。
- RAG 回答增加来源引用。

验收：

- 关键中文文案源码可读。
- 删除/写文件必须确认。
- RAG 回答带来源。
- `npm run typecheck`、`npm run build`、基础 eval 通过。

### 阶段 2：Agent Runtime，2-4 周

目标：统一对话、RAG、任务中心的执行内核。

任务：

- 抽象 `AgentSession`、`ToolRegistry`、`ToolExecutor`、`TraceStore`。
- 任务从循环执行改成状态图。
- 支持 checkpoint 和失败节点重跑。
- UI 展示统一 trace。

验收：

- 普通聊天、工具聊天、任务中心共用一套工具执行器。
- 任务中断后可恢复或从失败节点重跑。
- 每次 Agent 执行可导出 trace。

### 阶段 3：连接器生态，2-3 周

目标：接入 MCP 和外部工具生态。

任务：

- 增加 MCP client。
- 设置页增加连接器菜单。
- 工具启用/禁用和权限配置。
- 支持连接器健康检查。

验收：

- 可以接入至少一个本地 MCP server。
- MCP 工具可在聊天和任务中心调用。
- UI 可查看工具 schema 和最近调用。

### 阶段 4：高级 Agent 能力，4-6 周

目标：追近主流 Agent 产品体验。

任务：

- 受控浏览器 Agent。
- 长期记忆。
- 任务模板和计划编辑器。
- RAG rerank 和评测集。
- 结果资产库。

验收：

- 能稳定完成“搜索资料 -> 抓取网页 -> 生成报告 -> 存入资产库”。
- 用户能查看/修改计划。
- 记忆可查看、删除、关闭。

## 7. 推荐代码重构清单

### 7.1 目录调整

建议新增：

```text
src/main/runtime/
src/main/prompts/
src/main/connectors/
src/main/policies/
src/main/trace/
src/main/evals/
```

建议逐步迁移：

- `agent.ts` 中 prompt -> `prompts/`
- `agent.ts` 中模型路由 -> `runtime/ModelRouter.ts`
- `taskRunner.ts` 中工具执行 -> `runtime/ToolExecutor.ts`
- `tools/index.ts` -> `runtime/ToolRegistry.ts`
- `storage.ts` 中设置与业务数据拆分为独立 store。

### 7.2 工具接口标准化

```ts
export type ToolDescriptor = {
  name: string;
  title: string;
  description: string;
  schema: unknown;
  risk: ToolRisk[];
  source: "builtin" | "mcp" | "connector";
  requiresConfirmation: (args: unknown) => boolean;
  invoke: (args: unknown, context: ToolContext) => Promise<ToolResult>;
};
```

### 7.3 Trace 标准化

```ts
export type AgentTraceEvent =
  | { type: "model_start"; model: string; messages: number; at: number }
  | { type: "model_token"; token: string; at: number }
  | { type: "tool_start"; tool: string; args: unknown; at: number }
  | { type: "tool_end"; tool: string; result: unknown; durationMs: number }
  | { type: "approval_required"; tool: string; args: unknown }
  | { type: "error"; error: AppError; at: number };
```

## 8. 风险与注意事项

- 不要过早做完全自主电脑控制。先做受控浏览器和明确权限，避免安全不可控。
- 不要只依赖提示词约束工具调用。高风险动作必须在代码层拦截。
- 不要让 RAG 回答没有引用。没有引用的知识库问答很难建立用户信任。
- 不要继续把提示词散落在业务代码里。Agent 产品的 prompt 是核心资产。
- 不要忽略评测。每次优化路由规则、提示词和工具都会影响 Agent 行为。

## 9. 官方资料参考

- OpenAI ChatGPT Agent：https://openai.com/index/introducing-chatgpt-agent/
- Anthropic Tool Use：https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview
- Anthropic Computer Use：https://docs.anthropic.com/en/docs/agents-and-tools/computer-use
- Model Context Protocol：https://modelcontextprotocol.io/
- LangGraph Durable Execution：https://docs.langchain.com/oss/javascript/langgraph/durable-execution
- LangGraph Human-in-the-loop：https://docs.langchain.com/oss/javascript/langgraph/use-human-in-the-loop
- Google Agent Development Kit：https://google.github.io/adk-docs/

