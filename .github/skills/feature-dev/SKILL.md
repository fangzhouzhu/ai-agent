---
name: feature-dev
description: "开发新功能时确保逻辑一致、配色统一。Use when: adding new features, creating new components, adding new pages, implementing new IPC channels, extending the UI. 确保新代码遵循现有架构模式和视觉风格。"
argument-hint: "描述要开发的新功能"
---

# 新功能开发 — 一致性保障流程

开发新功能时，必须参考现有功能的实现模式，确保逻辑通顺、页面配色与风格一致。

## When to Use

- 新增 React 组件或页面
- 新增 IPC 通道和主进程处理逻辑
- 扩展已有功能模块
- 添加新的 CSS 样式

## Procedure

### 第一步：探索现有功能

在动手写代码之前，先理解相关的现有实现：

1. **找到最相似的现有功能**：在 `src/renderer/src/components/` 中找到与新功能最接近的组件，通读其完整实现
2. **理解数据流**：从 renderer → preload → main 跟踪完整的调用链路
3. **检查类型定义**：阅读 `src/renderer/src/types/conversation.ts` 和 `src/preload/index.ts` 中的类型
4. **查看样式模式**：阅读相似组件的 `.module.css` 文件，记录它使用的颜色和布局模式

### 第二步：遵循组件结构模板

新 React 组件必须遵循以下结构：

```tsx
import React, { useState, useCallback, useRef, useEffect } from "react";
import styles from "./ComponentName.module.css";
// 类型导入
import type { SomeType } from "../types/conversation";

// Props 接口在组件之前定义
interface Props {
  // 回调用 on 前缀：onSend, onDelete, onCopyMessage
  // 布尔值用 is 前缀：isLoading, isActive
}

const ComponentName: React.FC<Props> = (
  {
    /* 解构 props */
  },
) => {
  // 1. State 声明
  const [value, setValue] = useState("");

  // 2. Ref 声明（后缀 Ref）
  const scrollRef = useRef<HTMLDivElement>(null);

  // 3. 派生状态
  const isBusy = isLoading || isProcessing;

  // 4. useCallback 包裹的事件处理（handle 前缀）
  const handleAction = useCallback(() => {
    // 实现
  }, [dependencies]);

  // 5. useEffect 副作用
  useEffect(() => {
    // 初始化逻辑
    return () => {
      /* 清理 */
    };
  }, [dependencies]);

  // 6. JSX
  return <div className={styles.container}>{/* 组件内容 */}</div>;
};

export default ComponentName;
```

### 第三步：遵循配色规范

**严格使用以下颜色体系，不要引入新颜色：**

详见 [配色规范](./references/color-palette.md)。

核心原则：

- **背景**：`#f0f4ff`（主背景）、`#ffffff`（卡片/面板）、`#e8f0ff` / `#eef3ff`（浅蓝高亮）
- **文字**：`#1a2650`（主文本）、`#4a5a88`（次要）、`#6a7890`（辅助）、`#8a9ab8`（弱化）
- **主色调**：`#3b82f6`（主蓝）、`#1f42d1`（深蓝）、`#7c3aed`（紫色）
- **边框**：`#d0deff`（标准）、`#dce8ff`（浅）、`#b0c8f5`（输入框/卡片）
- **状态色**：`#7dff99` / `#27ae60`（成功）、`#ff7070` / `#e74c3c`（错误）、`#f0a500`（警告）
- **渐变**：`linear-gradient(135deg, #7c3aed, #2563eb)`（紫→蓝）、`linear-gradient(135deg, #4a7cf0, #00c8ff)`（蓝→青）
- **阴影**：`rgba(45, 78, 170, 0.1~0.12)` 蓝色调阴影

### 第四步：遵循样式模式

新增 CSS Module 文件时：

1. **文件命名**：`ComponentName.module.css`
2. **类名 camelCase**：`.container`、`.scrollArea`、`.toolbarInner`
3. **布局统一用 Flexbox**，间距使用标准尺度：`4/6/8/10/12/14/16/20/24px`
4. **圆角标准**：`4px`（小按钮）→ `8px`（按钮）→ `12px`（气泡）→ `14px`（卡片/弹窗）
5. **焦点态**：`:focus-within` 配合 `box-shadow: 0 0 0 3px rgba(74, 124, 240, 0.12)`
6. **渐变边框技巧**：

```css
.card {
  background:
    linear-gradient(#ffffff, #ffffff) padding-box,
    linear-gradient(135deg, #4a7cf0, #7c3aed, #00c8ff) border-box;
  border: 1px solid transparent;
  border-radius: 14px;
}
```

7. **过渡动画**：统一 `transition: all 0.2s` 或 `0.25s`

### 第五步：遵循 IPC 通信模式

新增后端交互时：

1. **频道命名**：`"namespace:action"` 格式，如 `"chat:send"`、`"kb:list"`
2. **主进程注册**（`src/main/index.ts`）：

```typescript
ipcMain.handle("namespace:action", async (event, params) => {
  // 实现
});
```

3. **Preload 暴露**（`src/preload/index.ts`）：

```typescript
// 在 api 对象中，按命名空间分组
namespace: {
  action: (params) => ipcRenderer.invoke("namespace:action", params),
  onEvent: (callback) => {
    const handler = (_, data) => callback(data)
    ipcRenderer.on("namespace:event", handler)
    return () => ipcRenderer.removeListener("namespace:event", handler)
  }
}
```

4. **流式输出模式**：`invoke` 发起 → `on` 接收 token → `on` 接收 done/error

### 第六步：命名规范

| 类别       | 约定                  | 示例                       |
| ---------- | --------------------- | -------------------------- |
| 组件文件   | PascalCase.tsx        | `KnowledgeBase.tsx`        |
| 样式文件   | PascalCase.module.css | `KnowledgeBase.module.css` |
| 类型文件   | camelCase.ts          | `conversation.ts`          |
| 工具文件   | camelCase.ts          | `fileTools.ts`             |
| CSS 类名   | camelCase             | `.scrollArea`              |
| 事件处理   | handle + 动作         | `handleSend`               |
| 回调 Props | on + 动作             | `onCopyMessage`            |
| 布尔状态   | is + 形容词           | `isLoading`                |
| Ref 变量   | 名词 + Ref            | `scrollRef`                |
| 工厂函数   | create + 实体         | `createConversation`       |
| IPC 频道   | 命名空间:动作         | `"storage:save"`           |

### 第七步：验证清单

功能开发完成后，逐项检查：

- [ ] 新组件结构与现有组件一致（Props 接口 → state → ref → callback → effect → JSX）
- [ ] 所有颜色值都来自上述配色规范，没有引入新颜色
- [ ] CSS 类名使用 camelCase
- [ ] 间距/圆角/字号在标准尺度范围内
- [ ] IPC 频道遵循 `namespace:action` 命名
- [ ] Preload 层正确暴露了新 API 并有类型
- [ ] 事件处理函数使用 `useCallback` 包裹
- [ ] 新类型/接口导出并在 renderer 和 main 之间保持一致
- [ ] 没有硬编码的 magic numbers，间距和颜色可追溯
