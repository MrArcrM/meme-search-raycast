# meme-search-raycast

本地 AI 打标的表情包搜索 Raycast 扩展，回车复制图片到剪贴板，去微信 `Cmd+V` 直接粘贴。

## 数据契约

扩展依赖 `memeDir` preference 指向的目录，里面必须有：
- `index.json` —— 元数据清单（schema 见下）
- 一堆图片，文件名对应 `items[].filename`

`index.json` schema（与 [src/search-memes.tsx](src/search-memes.tsx) 的类型对齐）：

```ts
interface IndexFile {
  meta?: Record<string, unknown>;   // 自由元数据，扩展不读
  items: MemeItem[];
}

interface MemeItem {
  filename: string;                 // 相对 memeDir 的路径，可含子目录（一级目录 = "系列"）
  description: string;              // 一句话描述，模糊匹配兜底
  tags: string[];                   // 关键词数组，命中权重最高
  emotion: string;                  // 情绪标签（开心 / 阴阳 / 委屈 ...）
  has_text: boolean;                // 是否有文字
  text_content: string | null;      // 文字内容；命中给最高分（100）
  phash?: string;                   // 8x8 ahash，去重用
}
```

搜索打分（[search-memes.tsx](src/search-memes.tsx)）：text 命中 100 > 完整 tag 90 > 部分 tag 70 > emotion 60 > description 50。

无 query 时：**最近使用排前**（LocalStorage LRU 50 条），其余按 filename 字典序。

## 数据生产：打标流程

```bash
export ANTHROPIC_API_KEY=sk-ant-api03-...   # 可选；不设则走 claude CLI 复用 Max 配额
npm run tag                                  # 增量打标 memes/ 下所有未打标的图
npm run tag -- --force                       # 全量重打
npm run tag -- --file "<系列>/<文件名>"      # 单张重打
npm run tag -- --dedup                       # pHash 重复检测，列出疑似重复对
npm run tag -- --concurrency 4               # 并发数，默认 3
npm run tag -- --limit 10                    # 只跑前 N 张（调试）
npm run tag -- --help
```

**Provider 选择**:
- 有 `ANTHROPIC_API_KEY` → 走 Anthropic SDK（快，按消费计费）。
- 没有 → spawn `claude` CLI（合规复用 Claude Max 配额；25 秒/张，慢但免费）。

**关键设计**:
- Claude 输出**强制 XML 格式**而非 JSON —— 因为模型在 JSON 字符串里嵌引号时常常忘转义，导致 `JSON.parse` 失败。XML 没这个问题。
- 进程内 `pLimit` 控制并发；每 10 张或 5 秒落盘一次；`SIGINT`/`SIGTERM` 也会先落盘再退出。
- 不要并行起多个 `npm run tag`，**会互相覆盖 index.json**。要并发就用 `--concurrency`。

**Prompt 强约束 OCR**：[scripts/tag.ts:buildUserPrompt](scripts/tag.ts) 明确要求逐字识别图上文字，把文字按句拆开后塞进 tags 让搜句子片段也能命中。

## 开发命令

```bash
npm install
npm run dev        # = ray develop，启动后 Raycast 会自动加载本地版
npm run build      # = ray build
npm run lint
npm run fix-lint
```

`ray develop` 期间，Raycast 会把当前目录链接为活动扩展，覆盖掉 `~/.config/raycast/extensions/meme-search/` 的安装版；停掉 dev 后自动回到安装版。

## 发布流程

main 上工作区干净时：

```bash
./scripts/bump-tag.sh patch                 # bugfix / 文案 / 行为无变化
./scripts/bump-tag.sh minor                 # 新功能（向后兼容）
./scripts/bump-tag.sh major -m "schema 改"  # breaking change
```

脚本会自动算下一个 semver tag、打 annotated tag、推 origin。不在 main / 脏工作区 / 重复 tag 都会拒绝。

breaking 的定义：`index.json` schema 改、`preference` key 改名、命令名改。

## 安装副本注意

`~/.config/raycast/extensions/meme-search/` 是 Raycast 编译产物（自动生成的 `search-memes.js`），**不要手改**。源码迭代只在本 repo 进行，`ray build` / Raycast Store 发布会重新生成那份。

## 目录约定

- `memes/` —— 默认 memeDir（已 .gitignore）。结构是 `memes/<系列名>/*.gif`。
- 加新表情包：直接把整个文件夹放进 `memes/`（或软链），跑 `npm run tag` 增量打标。
- 删表情包：删文件夹 + 跑 `npm run tag -- --force` 重建 index（force 会跳过已打标但保留索引中没有的会被吃掉；其实更稳妥是手动删 index.json 里对应条目）。

## 不要做

- 不要主动加 README 之外的 `*.md` 文档（设计稿、changelog 等）。
- 不要 commit `raycast-env.d.ts`（已在 .gitignore，是 ray 自动生成的）。
- 不要 commit 表情包图片本身 —— `memes/` 已 .gitignore。资源库是郭大大本地的。
- 不要把 Claude Max OAuth token 拿出来打外部 API —— Anthropic 2026-01 起明令禁止。脚本里走 `claude` CLI（spawn binary）是合规的；要直连 API 必须用 `ANTHROPIC_API_KEY`。
