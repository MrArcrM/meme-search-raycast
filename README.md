# meme-search-raycast

本地 AI 打标的表情包搜索 Raycast 扩展。按 **标签 / 文字 / 情绪** 模糊搜索本地表情包，回车复制到剪贴板，直接 `Cmd+V` 粘到微信 / Slack / 任意 IM。

## 工作方式

不依赖任何云端服务（运行时）。表情包目录里放一份 `index.json` 元数据清单，扩展加载这份清单做本地搜索。

```
memes/                            # 默认 memeDir（项目下，已 gitignore）
├── index.json                    # 元数据
├── 印尼小胖tantan/                # 系列子目录
│   ├── ytxmlx (1).GIF
│   └── ...
└── 熊猫头/
    └── ...
```

一级目录被视为「系列」，Raycast 里有下拉框可以按系列过滤。

## 安装

```bash
git clone https://github.com/MrArcrM/meme-search-raycast.git
cd meme-search-raycast
npm install
npm run dev          # ray develop，Raycast 会自动加载
```

在 Raycast 偏好里配置：
- **表情包目录** —— 包含 `index.json` 的文件夹绝对路径（推荐填这个 repo 下的 `memes/` 绝对路径）
- **Grid 列数** —— 一行显示几张（3-8，默认 5）

## 打标（生成 index.json）

```bash
npm run tag                        # 增量打标 memes/ 下所有未打标的图
npm run tag -- --force             # 全量重打
npm run tag -- --file "印尼小胖tantan/ytxmlx (1).GIF"   # 单张重打
npm run tag -- --dedup             # pHash 重复检测，列出疑似重复
npm run tag -- --concurrency 4     # 并发数（默认 3）
npm run tag -- --limit 10          # 只跑前 N 张（调试）
npm run tag -- --help
```

**两种认证模式：**

1. **默认：复用 Claude Max 配额** —— spawn 本地 `claude` CLI，不花 API 钱。约 25 秒/张。
2. **设置 `ANTHROPIC_API_KEY`** —— 走 Anthropic SDK，更快，按消费计费（约 $0.005/张）。

> ⚠️ Anthropic 2026-01 起禁止 Claude Max OAuth token 用于第三方脚本。本工具通过 `claude` CLI 间接调用是合规的（让官方客户端自己处理认证），不会把你的 token 拿来打 messages API。

打标输出字段：

```json
{
  "filename": "印尼小胖tantan/ytxmlx (200).GIF",
  "description": "胖乎乎的婴儿正面表情严肃，画面写着「有完没完」",
  "tags": ["有完没完", "完没完", "没完", "印尼小胖", "tantan", "愤怒宝宝", "..."],
  "emotion": "愤怒",
  "has_text": true,
  "text_content": "月巴 有完没完",
  "phash": "d181819181c3e7ff"
}
```

OCR 是强约束的 —— prompt 明确要求把图上文字逐字识别进 `text_content`，并把按句子拆开后的片段也塞进 `tags`，所以搜「等你回来」能命中「我等你回来」的图。

## 搜索打分

| 命中位置 | 分数 |
|---|---|
| `text_content` 包含 query | 100 |
| `tags` 中有 query 完全相等 | 90 |
| `tags` 中有 query 部分包含 | 70 |
| `emotion` 包含 query | 60 |
| `description` 包含 query | 50 |

无 query 时：**最近使用排前**（LocalStorage LRU，最多 50 条），其余按 filename 字典序。

## 操作

| 快捷键 | 动作 |
|---|---|
| `Enter` | 复制图片到剪贴板（粘到微信） |
| `Shift+Enter` | 直接粘到前台应用 |
| `Cmd+O` | 用默认应用打开 |
| `Cmd+Shift+F` | 在 Finder 里显示 |
| `Cmd+Shift+C` | 复制文件路径（调试用） |
| `Ctrl+X` | 从最近使用中移除 |

## License

MIT
