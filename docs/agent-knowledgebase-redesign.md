# 智能体与知识库重构设计文档

更新时间：2026-06-13

## 1. 文档目标

本文档用于定义下一阶段的智能体与知识库重构方案，解决当前系统中以下问题：

- 知识库是全局临时选择，未与会话和角色稳定绑定
- 用户心智偏向“我在和某个助手聊天”，而不是“我在临时勾选几个库”
- 普通聊天、Agent、RAG 已经存在运行时差异，但产品层表达还不清晰
- 持久化知识库具备长期资产属性，但尚未成为智能体配置的一部分

本文档回答三个核心问题：

1. 智能体应该如何建模
2. 知识库应该如何纳入智能体体系
3. 是否需要区分“智能体聊天”和“普通聊天”

## 2. 现状问题

结合当前代码，现状可概括为：

- 会话元数据 `ConvMeta` 仅保存标题和时间，不保存会话归属的智能体
- 知识库为独立资源，聊天时通过 `kbIds` 临时传入
- 知识库 UI 状态通过全局设置持久化，而不是绑定到会话或角色
- 聊天路由已区分 `chat`、`agent`、`rag` 三类模型，但产品层仍以“是否开启 Agent / 是否勾选知识库”驱动

当前方案可以工作，但会带来以下问题：

- 状态漂移：同一会话今天和明天可能命中不同知识库
- 用户心智不稳定：用户无法明确知道“自己正在和谁对话”
- 配置难复用：一组知识库、工具和提示词很难沉淀成一个可复用助手
- 会话不可追溯：无法准确回放当时用了哪个角色、哪些知识库、何种规则

## 3. 设计原则

重构建议遵循以下原则：

- 角色优先：用户首先选择“和谁聊”，其次才是“要不要临时加资源”
- 知识与角色解耦：知识库是资源，智能体是资源编排者
- 会话绑定智能体：会话从创建时就知道自己属于哪个智能体
- 运行时统一：普通聊天和智能体聊天可以有不同策略，但尽量共享一套运行时
- 可追溯：每轮回答都应记录模型、知识库、工具和策略
- 可复用：一个知识库可被多个智能体使用，一个智能体可绑定多个知识库

## 4. 总体设计

### 4.1 结论

推荐采用以下分层：

- `KnowledgeBase`：长期知识资源
- `AgentProfile`：智能体配置模板
- `Conversation`：某个智能体的一次会话实例
- `AgentRuntime`：根据会话和输入动态装配模型、知识、工具与记忆

关系如下：

```text
KnowledgeBase <---- many-to-many ----> AgentProfile ---- one-to-many ----> Conversation
                                                     \
                                                      \---- runtime assembly ----> AgentRuntime
```

### 4.2 核心思想

智能体不应被设计成一个“无所不包的大类”，而应被设计成一个可持久化的配置对象。

换句话说：

`智能体 = 角色定义 + 知识策略 + 工具权限 + 模型策略 + 记忆策略`

## 5. 核心对象设计

### 5.1 KnowledgeBase

知识库负责长期文档资产管理，不承载角色信息。

建议职责：

- 文档导入、去重、切片、向量化、重建索引
- 检索配置默认值
- 文档状态与索引状态管理
- 检索结果引用信息输出

建议新增字段：

```ts
type KnowledgeBase = {
  id: string
  name: string
  description: string
  category?: string
  embeddingModel: string
  chunkSize: number
  chunkOverlap: number
  retrievalMode: 'hybrid' | 'vector' | 'keyword'
  defaultMinScore: number
  defaultTopK: number
  docCount: number
  chunkCount: number
  createdAt: number
  updatedAt: number
}
```

说明：

- `retrievalMode` 让知识库能声明默认检索方式
- `defaultMinScore` 和 `defaultTopK` 作为智能体未覆盖时的默认策略
- `category` 便于后续做资源组织和筛选

### 5.2 AgentProfile

智能体是产品核心实体，表示一个可被用户直接选择的助手。

建议结构：

```ts
type AgentProfile = {
  id: string
  name: string
  description: string
  avatar?: string
  systemPrompt: string

  mode: 'general' | 'domain' | 'workflow'

  knowledge: {
    defaultKbIds: string[]
    ragOnly: boolean
    minScore: number
    topK: number
    fallbackToChat: boolean
    citationRequired: boolean
  }

  tools: {
    enabledToolNames: string[]
    allowNetwork: boolean
    allowWrite: boolean
    allowDelete: boolean
    requireConfirmationForRisky: boolean
  }

  models: {
    chat: { provider: 'ollama' | 'openai-compatible'; model: string }
    agent: { provider: 'ollama' | 'openai-compatible'; model: string }
    rag: { provider: 'ollama' | 'openai-compatible'; model: string }
  }

  memory: {
    enableConversationSummary: boolean
    enableUserPreferenceMemory: boolean
  }

  skills: string[]
  isDefault?: boolean
  createdAt: number
  updatedAt: number
}
```

说明：

- `mode` 区分通用助手、领域助手、流程助手
- `knowledge.defaultKbIds` 是智能体默认挂载的知识库集合
- `fallbackToChat` 用于控制无命中时是否退回普通回答
- `citationRequired` 用于控制是否强制引用证据

### 5.3 Conversation

会话应明确绑定一个智能体。

建议结构：

```ts
type ConvMeta = {
  id: string
  title: string
  agentProfileId: string
  createdAt: number
  updatedAt: number
}
```

可选增强：

```ts
type ConversationRuntimeSnapshot = {
  agentVersionAtStart?: number
  kbIds?: string[]
  ragOnly?: boolean
  minScore?: number
}
```

说明：

- `agentProfileId` 是最关键字段
- 如果担心智能体后续配置变化影响老会话，可在创建会话时保存运行快照

### 5.4 Turn Trace

建议为每轮消息记录真实运行信息，便于诊断与回放。

```ts
type MessageExecutionTrace = {
  route: 'chat' | 'agent' | 'rag'
  model: string
  provider: string
  agentProfileId?: string
  usedKbIds?: string[]
  usedChunkRefs?: Array<{
    kbId: string
    kbName: string
    docId?: string
    docName: string
    chunkIndex?: number
    score?: number
  }>
  usedTools?: string[]
}
```

## 6. 智能体与知识库关系

### 6.1 推荐关系

推荐采用多对多：

- 一个智能体可以绑定多个知识库
- 一个知识库可以被多个智能体复用

例如：

- 产品助手：产品文档库 + FAQ 库
- 售后助手：FAQ 库 + 工单规范库
- 法务助手：制度库 + 合同模板库

### 6.2 不推荐关系

不建议采用以下两种：

1. 全局选择知识库，所有会话共用
2. 一个智能体只能绑定一个知识库

原因：

- 前者会导致上下文漂移
- 后者会导致知识复用能力差，后续扩展成本高

## 7. 是否需要区分“智能体聊天”和“普通聊天”

### 7.1 结论

需要区分，但建议区分为“产品模式”和“运行策略”，不建议做成两套完全独立系统。

### 7.2 为什么需要区分

普通聊天和智能体聊天的目标不同：

- 普通聊天强调轻量、低延迟、少约束
- 智能体聊天强调角色稳定、知识约束、工具能力和结果可追溯

如果完全不区分，会出现两个问题：

- 通用对话被过度复杂化，体验变重
- 领域助手缺少稳定配置，回答边界不清晰

### 7.3 推荐区分方式

建议保留两个产品入口：

1. 普通聊天
2. 智能体聊天

两者共享同一套底层运行时，但默认策略不同：

| 项目 | 普通聊天 | 智能体聊天 |
| --- | --- | --- |
| 默认智能体 | 系统默认通用助手 | 用户选择的 AgentProfile |
| 知识库 | 默认不绑定或弱绑定 | 默认绑定一组知识库 |
| 工具 | 默认少量或关闭 | 按智能体策略启用 |
| 回答约束 | 弱 | 强 |
| 证据引用 | 通常不强制 | 知识型助手建议强制 |
| 结果追踪 | 基础 | 完整 |

### 7.4 工程建议

不建议维护两套实现，例如：

- 不要单独再写一个完全独立的“普通聊天引擎”
- 不要单独再写一个完全独立的“智能体聊天引擎”

建议统一为：

```text
chat request -> resolve conversation agent -> build runtime policy -> route(chat/agent/rag) -> execute
```

普通聊天可以理解为：

- 使用一个内置的 `GeneralAssistant` 智能体
- 默认无知识库或仅弱知识增强
- 默认工具权限更小

这样产品上有区分，工程上仍统一。

## 8. 运行流程设计

### 8.1 会话创建

新建会话时：

1. 用户选择“普通聊天”或某个智能体
2. 系统确定 `agentProfileId`
3. 创建会话并保存该绑定关系

若选择普通聊天，则实际绑定到内置默认智能体，例如：

- `general-assistant`

### 8.2 单轮消息执行

每轮消息推荐流程：

1. 根据会话读取 `agentProfileId`
2. 加载 `AgentProfile`
3. 判断是否需要知识检索
4. 在 `AgentProfile.knowledge.defaultKbIds` 中检索
5. 按策略判断是否允许回退为普通对话
6. 判断是否允许调用工具
7. 选择 `chat / agent / rag` 路由和对应模型
8. 生成回答并记录引用与 trace

### 8.3 策略示例

普通聊天：

- 默认 `ragOnly = false`
- 默认 `defaultKbIds = []`
- 默认 `citationRequired = false`
- 默认只开低风险工具

领域知识助手：

- 默认 `ragOnly = true`
- 默认 `defaultKbIds = ['kb-product', 'kb-faq']`
- 默认 `citationRequired = true`
- 无结果时提示用户改写问题或切换模式

## 9. 现有知识库改造方案

### 9.1 改造目标

当前知识库已经具备长期资产属性，因此重点不是重做，而是补齐与智能体的连接能力。

目标如下：

- 让知识库从“全局 UI 选项”升级为“智能体资源”
- 让知识库检索参数支持默认值和被智能体覆盖
- 让知识库检索结果带完整引用结构
- 让知识库能被多个智能体稳定复用

### 9.2 数据层改造

建议新增：

```ts
type AgentKnowledgeBinding = {
  agentProfileId: string
  kbId: string
  priority: number
  enabled: boolean
  minScoreOverride?: number
  topKOverride?: number
}
```

说明：

- 若当前存储偏简单，可先不单独建关联表，直接把 `defaultKbIds` 放进 `AgentProfile`
- 如果后续要支持每个 Agent 对同一 KB 有不同策略，再引入独立绑定表

### 9.3 检索层改造

当前 `retrieveFromKbs` 已支持传入多个 `kbIds`，这是可复用基础。

建议升级：

```text
query -> query rewrite -> retrieveFromKbs -> rerank -> threshold filter -> context pack -> answer
```

改造点：

- 返回结构中包含 `kbId`、`kbName`、`docId`、`docName`、`chunkIndex`
- 支持 `topK` 和 `minScore` 按智能体覆盖
- 支持无结果时根据 `fallbackToChat` 决定回退或拒答
- 支持 `citationRequired` 驱动回答模板

### 9.4 UI 改造

知识库面板应从“聊天前临时开关”转为“资源管理中心”。

建议调整为：

- 知识库页：创建、导入、重建、删除、查看文档和状态
- 智能体页：创建智能体，配置默认知识库、工具、模型和提示词
- 新建会话弹窗：选择普通聊天或某个智能体

知识库面板中仍可保留“临时挂载”能力，但建议降级为高级选项，而不是主流程。

## 10. 对现有代码的最小改造路径

### 阶段 1：引入智能体数据模型

目标：先建立“会话绑定智能体”的主干。

建议改造：

- 在 `src/main/storage.ts` 中为 `ConvMeta` 增加 `agentProfileId`
- 新增 `AgentProfile` 的本地存储接口
- 内置一个默认智能体 `general-assistant`

### 阶段 2：把全局 KB 选择迁到智能体

目标：减少全局漂移。

建议改造：

- 逐步废弃 `kbSelectedIds`、`kbRagOnly`、`kbMinScore` 的全局主导地位
- 在 `AgentProfile.knowledge` 中持久化默认知识策略
- `chat:send` 时从会话对应智能体读取知识策略

### 阶段 3：会话创建时选择智能体

目标：让产品心智稳定。

建议改造：

- 新建会话时支持选择智能体
- 侧边栏显示当前会话归属智能体
- 普通聊天实际绑定内置通用智能体

### 阶段 4：补齐引用和追踪

目标：让知识型回答可验证。

建议改造：

- 为消息增加检索引用记录
- 在消息中显示知识库来源
- 在 trace 中记录实际使用的知识库和 chunk

## 11. 兼容策略

为避免一次性重构风险过大，建议采用兼容迁移：

- 老会话自动绑定 `general-assistant`
- 保留现有 `kbIds` 透传接口一段时间，作为兼容层
- 当前知识库数据结构尽量延续，仅新增默认字段
- 现有 `chat / agent / rag` 路由函数先复用，不立即大拆

## 12. 关键决策摘要

本方案的关键决策如下：

1. 智能体是核心产品对象，会话必须绑定智能体
2. 知识库是长期资源，不直接等同于智能体
3. 智能体与知识库采用多对多关系
4. 需要区分“普通聊天”和“智能体聊天”
5. 区分应体现在产品入口和运行策略上，而不是维护两套独立引擎
6. 普通聊天本质上也是一个默认通用智能体

## 13. 推荐的下一步实施顺序

推荐按以下顺序落地：

1. 新增 `AgentProfile` 存储与默认通用智能体
2. 为会话 `ConvMeta` 增加 `agentProfileId`
3. 新建会话时支持选择智能体
4. 把知识库默认选择迁移到 `AgentProfile`
5. 消息执行时从会话智能体读取知识策略
6. 为知识型回答增加引用与 trace

如果只做一件最重要的事，优先做：

`会话绑定智能体`

这是整个重构的分水岭。一旦这一步成立，知识库、工具、模型和记忆都能自然归位。
