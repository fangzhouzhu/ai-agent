# AI Agent

基于 Electron + React + LangChain + Ollama 的本地桌面 AI 助手。

项目特点：

- 本地模型对话（Ollama）
- 支持流式输出
- 支持 Agent 工具调用（文件读写、搜索、删除、目录浏览）
- 多会话管理与本地持久化
- 桌面端体验（Electron）

## 功能概览

- 普通对话模式
  - 仅进行 LLM 对话，不调用工具
- Agent 模式
  - 模型可按需调用文件工具：
    - `read_file`
    - `write_file`
    - `list_directory`
    - `delete_file`
    - `search_files`
- 会话管理
  - 新建、切换、删除会话
  - 自动保存会话记录
- 模型管理
  - 获取本地 Ollama 模型列表
  - 切换当前使用模型
- 流式交互
  - token 级别实时返回
  - UI 可展示工具调用输入/结果

## 技术栈

- Electron 33
- electron-vite + Vite 5
- React 18 + TypeScript
- LangChain (`@langchain/ollama`, `@langchain/core`)
- Zod（工具入参校验）

## 快速开始

## 1. 环境要求

- Node.js 18+
- npm 9+
- 本地 Ollama 服务可用（默认地址：`http://localhost:11434`）

建议先确认 Ollama 已启动，并已拉取至少一个模型。

## 2. 安装依赖

```bash
npm install
```

## 3. 启动开发

```bash
npm run dev
```

## 4. 类型检查

```bash
npm run typecheck
```

## 5. 构建

```bash
npm run build
```

## 核心脚本

- `npm run dev`：开发模式
- `npm run dev:inspect`：开发模式（可调试主进程）
- `npm run build`：构建
- `npm run preview`：预览
- `npm run typecheck`：TypeScript 类型检查

## 目录结构

```text
src/
  main/                 # Electron 主进程
    index.ts            # 主进程入口 + IPC 注册
    agent.ts            # 对话与 Agent 编排
    storage.ts          # 会话持久化
    tools/
      fileTools.ts      # 文件工具实现
  preload/
    index.ts            # contextBridge 暴露 API
  renderer/
    src/
      App.tsx           # 前端状态与页面主逻辑
      components/       # 组件（侧边栏、输入栏、消息气泡等）
      types/            # 前端类型定义
```

## 架构说明

详细技术架构文档见：

- [docs/technical-architecture.md](docs/technical-architecture.md)

## 数据存储

会话数据存储在 Electron `userData` 目录下（不同系统路径不同），主要文件：

- `index.json`：会话元数据索引
- `active.json`：当前活跃会话 ID
- `conversations/<id>.json`：会话消息

## 开发说明

- 主进程与预加载改动由 electron-vite 开发链路处理重建/重启。
- 当前配置在 `electron.vite.config.ts` 中对 main/preload watch 做了约束，避免 renderer 变更干扰主进程重启链路。

## 注意事项

- Agent 工具具备本地文件读写/删除能力，请谨慎在生产环境开放。
- 如遇模型列表为空：
  - 检查 Ollama 是否运行
  - 检查模型是否已拉取
  - 检查端口 `11434` 可访问

## License

暂未声明（如需开源，请补充 LICENSE 文件）。
