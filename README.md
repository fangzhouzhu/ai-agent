# AI Agent

基于 **Electron + React + LangChain + Ollama** 构建的本地桌面 AI 助手，支持本地模型与在线模型混用、智能工具调用、持久化知识库 RAG（向量引擎由 **LanceDB** 驱动）、自定义 Skills 等功能。所有数据保存在本机，不依赖任何云服务。

---

## 功能一览

### 智能模型路由

根据问题类型自动选择处理方式，无需手动切换：

| 场景       | 触发条件               | 处理模式   |
| ---------- | ---------------------- | ---------- |
| 普通对话   | 日常闲聊、简单问答     | Chat 模型  |
| 复杂任务   | 代码、分析、长文本     | Agent 模型 |
| 工具调用   | 文件操作、天气、搜索等 | Agent 模型 |
| 文档问答   | 上传文件后提问         | RAG 模式   |
| 知识库问答 | 勾选知识库后提问       | RAG 模式   |

### Agent 工具调用

| 分类     | 工具                                         |
| -------- | -------------------------------------------- |
| 文件系统 | 读文件、写文件、删除文件、列出目录、搜索文件 |
| 系统     | 获取当前时间、计算器、单位换算、剪贴板写入   |
| 网络     | 网页搜索、天气查询、汇率转换、抓取网页内容   |

### 文档即时问答（RAG）

- 支持上传 **PDF、Word（docx）、TXT、Markdown、JSON、代码文件**等
- 文档上传后自动切片 + 向量化，立即可提问
- 仅在当次会话内有效（内存级，无需保存）

### 知识库（持久化 RAG）

- 创建多个命名知识库，文档永久保存在本机 `userData` 目录
- 向量数据由 **LanceDB** 存储，每个知识库对应一张独立表
- 文档入库流水线：解析 → 切片 → 向量化（`nomic-embed-text`），异步执行并展示进度
- SHA-256 文件去重，同一文档不重复入库
- 混合检索：向量相似度（70%）+ 关键词匹配（30%）
- 在侧边栏勾选知识库后，聊天时自动调用
- 支持单文档重建索引、移除文档

### 本地 Skills（自定义提示词）

- 创建多个 Skill，每个 Skill 包含：名称、描述、关键词、系统提示词、优先级、适用场景
- 根据用户消息自动匹配 Skill，将系统提示词注入当轮对话
- 适合角色扮演、格式约束、专业领域增强等固定场景

### 在线模型支持

- 兼容 **OpenAI Chat Completions API** 协议的第三方服务
- 内置预设：OpenAI、DeepSeek、Moonshot、SiliconFlow、智谱 AI、OpenRouter
- 支持保存多个预设，一键切换；API Test 可自动获取模型列表、测量延迟
- Chat / Agent / RAG 场景可独立选择本地或在线模型

### 多会话管理

- 新建、切换、删除会话，自动持久化到本地 JSON 文件
- 支持编辑、删除、重新生成单条消息

---

## 技术栈

| 层         | 技术                                               |
| ---------- | -------------------------------------------------- |
| 桌面框架   | Electron 33                                        |
| 构建工具   | electron-vite + Vite 5                             |
| 前端       | React 18 + TypeScript + CSS Modules                |
| LLM 框架   | LangChain (`@langchain/ollama`, `@langchain/core`) |
| 本地模型   | Ollama（对话模型 + `nomic-embed-text` 嵌入模型）   |
| 向量数据库 | LanceDB (`@lancedb/lancedb`)                       |
| 文档解析   | pdf-parse、mammoth                                 |
| 数据持久化 | 本地 JSON + LanceDB（`%APPDATA%/ai-agent/`）       |

---

## 快速开始

### 1. 环境要求

- **Node.js** 18+
- **Ollama** 已安装并运行（默认：`http://localhost:11434`）
- 拉取所需模型（知识库功能需要嵌入模型）：

```bash
ollama pull qwen2.5:3b
ollama pull nomic-embed-text
```

### 2. 安装依赖

```bash
npm install
```

### 3. 开发模式

```bash
npm run dev
```

### 4. 构建

```bash
npm run build
```

---

## NPM 脚本

| 脚本                  | 说明                     |
| --------------------- | ------------------------ |
| `npm run dev`         | 开发模式（热重载）       |
| `npm run dev:inspect` | 开发模式（主进程可调试） |
| `npm run build`       | 生产构建                 |
| `npm run preview`     | 预览构建产物             |
| `npm run typecheck`   | TypeScript 类型检查      |

---

## 目录结构

```
src/
├── main/                   # Electron 主进程
│   ├── index.ts            # IPC 处理器入口
│   ├── agent.ts            # LLM 路由 / 流式对话
│   ├── rag.ts              # 即时文档 RAG（内存）
│   ├── ragStore.ts         # 向量持久化（LanceDB）
│   ├── ragRepository.ts    # 知识库 & 文档元数据 CRUD
│   ├── ragIndexer.ts       # 入库流水线（解析→切片→向量化）
│   ├── ragRetriever.ts     # 混合检索（向量 + 关键词）
│   ├── skills.ts           # Skill 匹配逻辑
│   ├── storage.ts          # 本地 JSON 持久化工具
│   ├── openaiCompatible.ts # 在线 API 适配器
│   └── tools/              # Agent 工具集
│       ├── fileTools.ts
│       ├── systemTools.ts
│       └── webTools.ts
├── preload/
│   └── index.ts            # contextBridge API 桥接
└── renderer/
    └── src/
        ├── App.tsx
        └── components/
            ├── Sidebar.tsx         # 侧边栏（会话列表 / 知识库）
            ├── ChatArea.tsx        # 消息列表
            ├── MessageBubble.tsx   # 消息气泡（含工具调用展示）
            ├── InputBar.tsx        # 输入框（文件上传、Agent 开关）
            └── KnowledgeBase.tsx   # 知识库管理面板
```

---

## 数据存储位置

所有数据保存在本机，不会上传任何内容：

| 数据         | 路径                                          |
| ------------ | --------------------------------------------- |
| 会话记录     | `%APPDATA%/ai-agent/conversations/`           |
| 模型配置     | `%APPDATA%/ai-agent/settings.json`            |
| 知识库元数据 | `%APPDATA%/ai-agent/rag/knowledge-bases.json` |
| 文档元数据   | `%APPDATA%/ai-agent/rag/documents.json`       |
| 原始文档副本 | `%APPDATA%/ai-agent/rag/files/`               |
| 向量索引     | `%APPDATA%/ai-agent/rag/vectors/`（LanceDB）  |

> macOS 下 `%APPDATA%` 对应 `~/Library/Application Support`，Linux 对应 `~/.config`。

---

## 详细架构

见 [docs/technical-architecture.md](docs/technical-architecture.md)。
