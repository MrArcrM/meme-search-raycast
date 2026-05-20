# meme-search-raycast

本地 AI 打标的表情包搜索 Raycast 扩展。按 **标签 / 文字 / 情绪** 模糊搜索本地表情包，回车复制到剪贴板，直接 `Cmd+V` 粘到微信 / Slack / 任意 IM。

## 工作方式

不依赖任何云端服务。表情包目录里放一份 `index.json` 元数据清单（AI 预打标），扩展加载这份清单做本地搜索。

```
~/Documents/memes/
├── index.json                # 元数据
├── 印尼小胖-说得好.png
├── 印尼小胖-阴阳怪气.png
└── ...
```

`index.json` 结构：

```json
{
  "items": [
    {
      "filename": "印尼小胖-说得好.png",
      "description": "一个胖男孩竖大拇指",
      "tags": ["认可", "夸赞", "支持", "说得好"],
      "emotion": "认可",
      "has_text": true,
      "text_content": "说得好"
    }
  ]
}
```

字段含义：
- `filename` — 图片相对 `memeDir` 的路径
- `tags` — 关键词数组（搜索命中权重最高）
- `text_content` — 图片上的文字（完整命中给满分）
- `description` / `emotion` — 模糊匹配兜底

## 搜索打分

| 命中位置 | 分数 |
|---|---|
| `text_content` 包含 query | 100 |
| `tags` 中有 query 完全相等 | 90 |
| `tags` 中有 query 部分包含 | 70 |
| `description` 包含 query | 50 |

## 安装

目前还没提交 Raycast Store，需要本地构建：

```bash
git clone https://github.com/MrArcrM/meme-search-raycast.git
cd meme-search-raycast
npm install
npm run dev          # ray develop，Raycast 会自动加载
```

在 Raycast 偏好里配置：
- **表情包目录** — 包含 `index.json` 的文件夹绝对路径
- **Grid 列数** — 一行显示几张（3-8，默认 5）

## 操作

| 快捷键 | 动作 |
|---|---|
| `Enter` | 复制图片到剪贴板（粘到微信） |
| `Shift+Enter` | 直接粘到前台应用 |
| `Cmd+O` | 用默认应用打开 |
| `Cmd+Shift+F` | 在 Finder 里显示 |
| `Cmd+Shift+C` | 复制文件路径（调试用） |

## License

MIT
