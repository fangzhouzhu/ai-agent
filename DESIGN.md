# DESIGN.md

## Product Surface

Centibot 是桌面端 AI 工作台，设计基准页为当前聊天页。整体风格不是营销页，而是“轻玻璃感 + 桌面工具感”的浅色工作台：干净、专业、轻盈，带少量智能感高光。

## Visual Direction

- 主背景使用浅蓝白渐变大底，允许叠加非常轻的径向高光和点阵纹理。
- 面板使用半透明白底搭配 `backdrop-filter: blur(...)`，营造轻玻璃质感，但透明度必须克制。
- 强调色只来自蓝青系主渐变，不引入新的品牌色族。
- 信息层级依赖边框、字重、留白和轻阴影，而不是夸张色块。

## Core Tokens

### Colors

- `--ui-color-primary`: `#102052`
- `--ui-color-body`: `#162652`
- `--ui-color-secondary`: `#617195`
- `--ui-color-muted`: `#7282a0`
- `--ui-color-subtle`: `#96a6c3`
- `--ui-color-accent`: `#315ff1`
- `--ui-color-accent-strong`: `#4d6bff`
- `--ui-color-success`: `#128160`
- `--ui-color-danger`: `#d33a48`

### Surfaces

- 页面底色：`--ui-bg-page`
- 玻璃面板：`--ui-surface-glass`
- 强玻璃面板：`--ui-surface-glass-strong`
- 卡片底：`--ui-surface-card`
- 浅强调底：`--ui-surface-accent`

### Border

- 默认描边：`--ui-border`
- 卡片描边：`--ui-border-strong`
- 激活描边：`--ui-border-active`

### Radius

- 小控件：`8px / 10px`
- 输入框、按钮、列表项：`12px`
- 卡片：`14px`
- 重要容器：`16px`
- 输入主容器 / 特殊壳层：`22px`
- Pill：`999px`

### Shadow

- 常规卡片：`--ui-shadow-sm`
- Hover / 激活卡片：`--ui-shadow-md`
- 大容器：`--ui-shadow-lg`
- 主操作按钮：`--ui-shadow-primary`

### Gradient

- 默认主渐变：`--ui-gradient-primary`
- 仅“新对话”这类主入口可用更强渐变：`--ui-gradient-primary-alt`

## Typography

- 全局字体沿用 `Segoe UI Variable / SF Pro Display / PingFang SC / Microsoft YaHei`
- 主标题：`18px~20px`，`font-weight: 800~850`
- 次级标题：`15px~16px`，`font-weight: 800~850`
- 正文：`13px~14px`
- 说明文案：`12px`
- 辅助说明 / 元信息：`11px~12px`

## Component Rules

### Buttons

- 主按钮：蓝青渐变、白字、圆角 `12px` 或 pill、带轻投影。
- 次按钮：浅白底、蓝灰字、细边框。
- 危险按钮：只在删除/解绑/停止时使用红色反馈。

### Panels

- 顶部工具栏、侧栏、底部输入区都应使用统一玻璃面板语言。
- 卡片默认 `14px` 圆角，不使用 20px 以上的大圆角卡片。
- Hover 只做轻微提亮、描边增强和轻阴影，不做夸张位移。

### Lists

- 列表项使用浅底 + 细边框或激活底色，不使用厚重实色块。
- 选中态统一为浅蓝底、轻描边和内阴影感，不使用全深色反白。

### Pills / Badges

- 使用浅蓝、浅绿、浅红语义底。
- 仅承载状态、模型、场景等短信息，不用作大面积装饰。

### Inputs

- 输入框、选择器统一 `12px` 圆角、浅蓝白底、聚焦蓝色发光描边。
- 主输入容器使用 `22px` 外壳圆角，仅聊天输入区保留这种更强容器感。

### Modals

- 弹窗保持白底到浅白渐变、轻玻璃遮罩、`18px~24px` 圆角。
- 内容分区依赖顶部标题栏、浅分割线和卡片组，不要堆太多嵌套卡片。

## Page Mapping

- 聊天页：作为风格基准页，不主动改视觉语言，只抽取规范。
- 知识库页：靠拢聊天页的侧栏、顶部工具栏、列表选中态和主按钮样式。
- Skills 页：靠拢聊天页的卡片、弹窗、标签、开关和按钮体系。
- 任务中心：靠拢聊天页的侧栏、新建任务区、详情卡片和状态展示方式。
- 微信 ClawBot 页：沿用聊天消息区风格，顶部状态条与按钮体系和聊天页保持一致。
- 设置弹窗 / 智能体页：使用相同的玻璃面板、表单输入、卡片和次按钮语言。

## Avoid

- 不新增新的主色体系。
- 不把其他页面做得比聊天页更厚重、更暗或更花。
- 不引入更大的圆角、更重的阴影或更强的渐变。
- 不使用与聊天页不一致的开关、菜单、卡片和弹窗样式。
