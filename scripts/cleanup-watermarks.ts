#!/usr/bin/env tsx
/**
 * 自动清洗 index.json 里的系列水印污染。
 *
 * 背景：很多表情包系列在角落带固定水印（如印尼小胖 tantan 的 "月巴" / "Na" / "ANG"），
 * 这些不是字幕，进 text_content / tags 会让搜索"月巴"错误命中、搜"Na" 命中噪音。
 *
 * 用法：
 *   npm run cleanup-watermarks                          # 默认 ./memes/index.json，dry-run（只报数不写）
 *   npm run cleanup-watermarks -- --dir <path>          # 指定 memeDir
 *   npm run cleanup-watermarks -- --write               # 实际写回（自动备份 index.json.bak.<时间戳>）
 *   npm run cleanup-watermarks -- --add "<水印>"         # 临时追加要清的水印（可重复）
 *
 * 已知水印词来自 5 张样本 benchmark + 715 张 index 扫描（详见 docs/decision-log/...）。
 */

import fs from "node:fs";
import path from "node:path";

// 已知水印词。按需扩充。
// 规则：必须是「系列固定水印」（短小、出现位置固定、非字幕语义），不能是「碰巧很短的真字幕」。
const KNOWN_WATERMARKS = ["月巴", "Na", "ANG"];

interface MemeItem {
  filename: string;
  description: string;
  tags: string[];
  emotion: string;
  has_text: boolean;
  text_content: string | null;
  phash?: string;
}
interface IndexFile {
  meta?: Record<string, unknown>;
  items: MemeItem[];
}

function parseArgs(argv: string[]) {
  const opts = {
    dir: "memes",
    write: false,
    extraWatermarks: [] as string[],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") opts.dir = argv[++i];
    else if (a === "--write") opts.write = true;
    else if (a === "--add") opts.extraWatermarks.push(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        `用法：
  npm run cleanup-watermarks                  # dry-run（默认）
  npm run cleanup-watermarks -- --write       # 实际写回
  npm run cleanup-watermarks -- --dir <path>  # 指定 memeDir
  npm run cleanup-watermarks -- --add "新水印"  # 追加要清的词

已知水印: ${KNOWN_WATERMARKS.join(", ")}
`,
      );
      process.exit(0);
    }
  }
  return opts;
}

/** 从一段 text_content 里剔除水印词（作为独立 token，前后空格或边界）。 */
function stripFromText(text: string, watermarks: string[]): string {
  let result = text;
  for (const w of watermarks) {
    // 转义正则元字符
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 三种位置：开头、中间（空格隔开）、结尾
    const re = new RegExp(`(^|\\s)${esc}(?=\\s|$)`, "g");
    result = result.replace(re, "");
  }
  // 折叠多重空格，trim
  return result.replace(/\s+/g, " ").trim();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const watermarks = [...KNOWN_WATERMARKS, ...opts.extraWatermarks];
  const memeDir = path.resolve(opts.dir);
  const indexPath = path.join(memeDir, "index.json");
  if (!fs.existsSync(indexPath)) {
    console.error(`找不到 ${indexPath}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as IndexFile;
  const stats = {
    total: data.items.length,
    textModified: 0,
    textClearedToNull: 0, // 清完后整条 text 变空
    hasTextFlipped: 0, // has_text 从 true 翻成 false
    tagsModified: 0,
    tagsRemovedTotal: 0,
    descriptionModified: 0,
  };
  const samples: { filename: string; before: string; after: string }[] = [];

  for (const item of data.items) {
    // text_content
    if (item.text_content && item.text_content.trim()) {
      const before = item.text_content;
      const after = stripFromText(before, watermarks);
      if (after !== before.trim()) {
        stats.textModified++;
        if (samples.length < 10) {
          samples.push({
            filename: item.filename,
            before: `text=「${before}」`,
            after: after ? `text=「${after}」` : "text=null + has_text=false",
          });
        }
        if (after === "") {
          item.text_content = null;
          stats.textClearedToNull++;
          if (item.has_text === true) {
            item.has_text = false;
            stats.hasTextFlipped++;
          }
        } else {
          item.text_content = after;
        }
      }
    }

    // tags
    const beforeTagCount = item.tags.length;
    item.tags = item.tags.filter((t) => !watermarks.includes(t));
    const removed = beforeTagCount - item.tags.length;
    if (removed > 0) {
      stats.tagsModified++;
      stats.tagsRemovedTotal += removed;
    }

    // description（防御性，水印偶尔会出现在 desc）
    if (item.description) {
      const before = item.description;
      const after = stripFromText(before, watermarks);
      if (after !== before.trim()) {
        item.description = after;
        stats.descriptionModified++;
      }
    }
  }

  console.log("\n=== 清洗统计 ===");
  console.log(`memeDir: ${memeDir}`);
  console.log(`水印列表: ${watermarks.join(", ")}`);
  console.log(`总条目数: ${stats.total}`);
  console.log(`text_content 被修改: ${stats.textModified}`);
  console.log(`text_content 被清空（→ null）: ${stats.textClearedToNull}`);
  console.log(`has_text true → false: ${stats.hasTextFlipped}`);
  console.log(`tags 被修改条目数: ${stats.tagsModified}`);
  console.log(`tags 数组里移除水印总次数: ${stats.tagsRemovedTotal}`);
  console.log(`description 被修改: ${stats.descriptionModified}`);

  if (samples.length > 0) {
    console.log("\n=== 修改样本（前 10 条）===");
    for (const s of samples) {
      console.log(`  ${s.filename}`);
      console.log(`    before: ${s.before}`);
      console.log(`    after : ${s.after}`);
    }
  }

  if (!opts.write) {
    console.log("\n(dry-run 模式，未写入。加 --write 实际写回，会自动备份)");
    return;
  }

  // 备份 + 写入
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${indexPath}.bak.${ts}`;
  fs.copyFileSync(indexPath, backupPath);
  fs.writeFileSync(indexPath, JSON.stringify(data, null, 2), "utf-8");
  console.log(`\n✓ 已写入 ${indexPath}`);
  console.log(`✓ 备份: ${backupPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
