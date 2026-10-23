---
title: Ry Markdown Reader 预览样例
description: 用于验证 Markdown 渲染、代码高亮与 Mermaid 图表。
---

# Ry Markdown Reader 预览样例

这是一个只读的 **Markdown** 预览页面。中文使用 MiSans Medium，英文与代码使用 JetBrains Mono。

> 地址栏输入 `.md` 链接会自动打开这里；当前页面也可以用来检查排版、表格、任务列表与 Mermaid。

## 基础排版

普通段落里可以有 `inline code`、[链接](https://example.com)、**加粗**、*斜体*、~~删除线~~，以及键盘按键 <kbd>Ctrl</kbd> + <kbd>K</kbd>。

- 无序列表
- 第二项
  - 嵌套项
  - 另一个嵌套项
- 第三项

1. 有序列表
2. 第二步
3. 第三步

- [x] 已完成的任务
- [ ] 未完成的任务
- [ ] 另一个待办

### 引用

> 配色参考 Sapgir：品牌蓝 `#4D6BFE`，浅色与深色两套 token。
>
> 这是引用的第二段。

### 表格

| 功能 | 状态 | 说明 |
| --- | :---: | --- |
| Markdown 渲染 | 完成 | marked + DOMPurify |
| 代码高亮 | 完成 | highlight.js |
| Mermaid | 完成 | 支持 flowchart / sequence / gantt |
| 明暗主题 | 完成 | 右上角切换，自动保存 |

---

## 代码高亮

```js
import { createReader } from './reader.js';

const reader = createReader({
  theme: 'light',
  readonly: true,
  mermaid: true,
});

await reader.open('https://example.com/README.md');
console.log('Rendered in', reader.elapsed, 'ms');
```

```python
from dataclasses import dataclass

@dataclass
class Document:
    title: str
    source: str
    readonly: bool = True

    def summary(self) -> str:
        return f"{self.title} — {len(self.source)} chars"
```

```bash
# 本地预览
python3 -m http.server 8080
open http://localhost:8080/viewer.html?src=/test/sample.md
```

```json
{
  "name": "ry-md-reader",
  "version": "1.0.0",
  "features": ["markdown", "mermaid", "light/dark"],
  "readonly": true
}
```

## Mermaid

### 流程图

```mermaid
flowchart LR
  A[地址栏输入 .md] --> B{是否 Markdown?}
  B -- 是 --> C[打开查看器]
  B -- 否 --> D[正常浏览]
  C --> E[拉取原文]
  E --> F[marked 渲染]
  F --> G{有 mermaid 块?}
  G -- 是 --> H[渲染 Mermaid SVG]
  G -- 否 --> I[完成]
  H --> I
```

### 时序图

```mermaid
sequenceDiagram
  autonumber
  actor User as 用户
  participant Browser as 浏览器
  participant Viewer as Markdown Reader
  participant Server as 源站

  User->>Browser: 输入 README.md 地址
  Browser->>Viewer: 自动跳转到查看器
  Viewer->>Server: fetch(原文)
  Server-->>Viewer: text/markdown
  Viewer->>Viewer: 渲染 Markdown + Mermaid
  Viewer-->>User: 只读预览
```

### 甘特图

```mermaid
gantt
  title 插件开发计划
  dateFormat  YYYY-MM-DD
  axisFormat  %m-%d
  section 核心
  查看器与路由        :done,    a1, 2026-10-01, 3d
  Markdown 渲染       :done,    a2, after a1, 3d
  Mermaid 集成        :active,  a3, after a2, 2d
  section 打磨
  双主题与字体        :         a4, after a3, 2d
  测试与文档          :         a5, after a4, 2d
```

## 图片

相对路径图片会根据 Markdown 地址解析：

![应用图标](../assets/icon48.png)

## 长内容测试

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus posuere velit aliquet. Cras mattis consectetur purus sit amet fermentum. Donec ullamcorper nulla non metus auctor fringilla.

中文段落用于检查 MiSans Medium 的字重与行高。字体回退顺序为 JetBrains Mono → MiSans → 系统等宽字体：英文与数字由 JetBrains Mono 渲染，中文由 MiSans 渲染。

```text
纯文本代码块
第二行：The quick brown fox jumps over the lazy dog.
第三行：0123456789
```

---

<p align="right"><sub>只读预览 · Ry Markdown Reader</sub></p>
