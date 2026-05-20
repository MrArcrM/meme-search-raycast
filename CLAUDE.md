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
  filename: string;                 // 图片相对路径（相对 memeDir）
  description: string;              // 一句话描述，模糊匹配兜底
  tags: string[];                   // 关键词数组，命中权重最高
  emotion: string;                  // 情绪标签（开心 / 阴阳 / 委屈 ...）
  has_text: boolean;                // 是否有文字
  text_content: string | null;      // 文字内容；命中给最高分（100）
}
```

搜索打分（[search-memes.tsx:43-55](src/search-memes.tsx#L43-L55)）：text 命中 100 > 完整 tag 90 > 部分 tag 70 > description 50。

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

## 待办（v0.1.0 主线）

- **AI 打标脚本进 repo**：当前 `index.json` 是手动填的，下一步把打标流程（截图 → VLM 出 tags / emotion / text_content → 落 index.json）作为一个子目录或 `scripts/tag.py` 进来。打标脚本进来后这份 CLAUDE.md 要补「数据生产链路」一段。

## 不要做

- 不要主动加 README 之外的 `*.md` 文档（设计稿、changelog 等）。
- 不要 commit `raycast-env.d.ts`（已在 .gitignore，是 ray 自动生成的）。
- 不要 commit 表情包图片本身 —— 这个 repo 是工具，资源库是郭大大本地的 `memeDir`。
