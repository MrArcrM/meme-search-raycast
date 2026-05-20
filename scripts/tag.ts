#!/usr/bin/env tsx
/**
 * 表情包打标 CLI
 *
 * 用法：
 *   npm run tag                      # 增量打标 memes/ 下所有图片
 *   npm run tag -- --force           # 全量重打
 *   npm run tag -- --file <name>     # 单张重打（相对 memes/ 的路径）
 *   npm run tag -- --dedup           # 仅扫描 pHash 重复对，不打标
 *   npm run tag -- --dir <path>      # 指定 memeDir，默认 ./memes
 *   npm run tag -- --concurrency 4   # 并发数，默认 3
 *   npm run tag -- --model <id>      # 模型，默认 claude-sonnet-4-6
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import Anthropic from "@anthropic-ai/sdk";
import pLimit from "p-limit";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

// ---------------- 类型 ----------------

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

interface CliOpts {
  dir: string;
  force: boolean;
  file: string | null;
  dedup: boolean;
  concurrency: number;
  model: string;
  dedupThreshold: number;
  limit: number | null;
  batchSize: number;
  provider: string;
}

// ---------------- argv 解析 ----------------

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    dir: "memes",
    force: false,
    file: null,
    dedup: false,
    concurrency: 3,
    model: "claude-sonnet-4-6",
    dedupThreshold: 6,
    limit: null,
    batchSize: 1,
    provider: "claude",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") opts.force = true;
    else if (a === "--dedup") opts.dedup = true;
    else if (a === "--file") opts.file = argv[++i];
    else if (a === "--dir") opts.dir = argv[++i];
    else if (a === "--concurrency") opts.concurrency = parseInt(argv[++i], 10);
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--dedup-threshold") opts.dedupThreshold = parseInt(argv[++i], 10);
    else if (a === "--limit") opts.limit = parseInt(argv[++i], 10);
    else if (a === "--batch-size") opts.batchSize = parseInt(argv[++i], 10);
    else if (a === "--provider") opts.provider = argv[++i];
    else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else throw new Error(`未知参数: ${a}`);
  }
  return opts;
}

function printHelp() {
  console.log(`
表情包打标 CLI

用法:
  npm run tag                          # 增量打标
  npm run tag -- --force               # 全量重打
  npm run tag -- --file <相对路径>     # 单张重打
  npm run tag -- --dedup               # 仅扫描 pHash 重复对
  npm run tag -- --dir <path>          # 指定 memeDir，默认 ./memes
  npm run tag -- --concurrency 4       # 并发数，默认 3
  npm run tag -- --model <id>          # 模型，默认 claude-sonnet-4-6
  npm run tag -- --dedup-threshold N   # pHash 汉明距离阈值，默认 6
  npm run tag -- --limit N             # 只处理前 N 张（调试/分批用）
  npm run tag -- --batch-size N        # 一个 claude session 处理 N 张（省 init 开销，默认 1）
  npm run tag -- --provider gemini     # 用 Gemini CLI 打标（看完整 GIF 多帧，OCR 更好）

Provider 选择:
  默认走 'claude' CLI（合规复用 Claude Max 配额，spawn 子进程）。
  设置 ANTHROPIC_API_KEY 则切到 Anthropic SDK（更快，按消费计费）。
`);
}

// ---------------- 扫描 ----------------

const IMG_EXTS = new Set([".gif", ".png", ".jpg", ".jpeg", ".webp"]);

async function scanImages(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string, rel: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      // 处理软链
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = await fs.stat(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        await walk(abs, relPath);
      } else if (isFile && IMG_EXTS.has(path.extname(e.name).toLowerCase())) {
        result.push(relPath);
      }
    }
  }
  await walk(root, "");
  result.sort();
  return result;
}

// ---------------- 抽帧 + pHash ----------------

function makeTmpPath(suffix: string): string {
  return path.join(
    os.tmpdir(),
    `meme-tag-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${suffix}`,
  );
}

/**
 * GIF → 抽 9 帧拼 3x3 宫格 PNG（每帧 500x500，输出 1500x1500）。
 * 单帧无法解决"字幕在中间帧"问题，宫格保证字幕帧基本都被覆盖。
 * 非 GIF 直接转 PNG。
 * 返回临时 PNG 路径 + cleanup 函数。
 */
async function prepareGridImage(
  absPath: string,
): Promise<{ tmpPath: string; cleanup: () => Promise<void> }> {
  const ext = path.extname(absPath).toLowerCase();
  const tmpPath = makeTmpPath("png");
  const cleanup = async () => {
    await fs.unlink(tmpPath).catch(() => {});
  };
  if (ext === ".gif") {
    // 抽帧 + 拼图：每隔 3 帧选一帧，缩到 500x500（letterbox），拼 3x3
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      absPath,
      "-vf",
      "select='not(mod(n,3))',scale=500:500:force_original_aspect_ratio=decrease,pad=500:500:(ow-iw)/2:(oh-ih)/2,tile=3x3",
      "-frames:v",
      "1",
      tmpPath,
    ]);
  } else {
    // 非 GIF：sharp 转 PNG，限 1024px
    const buf = await fs.readFile(absPath);
    await sharp(buf).resize(1024, 1024, { fit: "inside" }).png().toFile(tmpPath);
  }
  return { tmpPath, cleanup };
}

// 兼容老代码（Anthropic SDK provider 在用）
async function loadImageForVLM(absPath: string): Promise<{ data: string; media_type: "image/png" }> {
  const { tmpPath, cleanup } = await prepareGridImage(absPath);
  try {
    const buf = await fs.readFile(tmpPath);
    return { data: buf.toString("base64"), media_type: "image/png" };
  } finally {
    await cleanup();
  }
}

async function aHash(absPath: string): Promise<string> {
  const ext = path.extname(absPath).toLowerCase();
  let buf: Buffer;
  if (ext === ".gif") {
    // 拿中间帧算 hash
    const tmp = path.join(
      os.tmpdir(),
      `meme-phash-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
    );
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-i",
        absPath,
        "-vf",
        "thumbnail",
        "-frames:v",
        "1",
        tmp,
      ]);
      buf = await fs.readFile(tmp);
    } finally {
      fs.unlink(tmp).catch(() => {});
    }
  } else {
    buf = await fs.readFile(absPath);
  }
  const data = await sharp(buf).resize(8, 8, { fit: "fill" }).grayscale().raw().toBuffer();
  const avg = data.reduce((s, v) => s + v, 0) / data.length;
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    let nibble = 0;
    for (let j = 0; j < 4; j++) {
      if (data[i + j] >= avg) nibble |= 1 << (3 - j);
    }
    hex += nibble.toString(16);
  }
  return hex;
}

function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

// ---------------- Claude 调用 ----------------

const SYSTEM_PROMPT = `你是一个表情包打标助手。用户会给你一张表情包图片（如果原图是 GIF，已抽取最有代表性的一帧）。

严格按以下 JSON schema 输出（只输出 JSON 本体，不要 markdown 代码块、不要前言、不要解释）：

{
  "description": string,          // 一句话客观描述图片内容（人物、动作、场景），不超过 30 字
  "tags": string[],               // 8-20 个搜索关键词，中文，多角度覆盖
  "emotion": string,              // 主要情绪，中文单词，例如：开心 / 阴阳 / 委屈 / 愤怒 / 无奈 / 鼓励 / 中性 / 困惑 / 害羞
  "has_text": boolean,            // 图片上是否有可见文字
  "text_content": string | null   // 图片上所有可见文字，逐字识别；多句之间用空格分隔；无文字则 null
}

要求（极其重要）:
1. text_content 必须把图片上能看到的每一个汉字都识别进去，包括字幕、对话框、表情包标语、台词等。一字不漏。即使文字很小或不清晰，也要尽力识别。
2. 如果有文字，把文字按句拆开后也加进 tags（例如文字是"我等你回来"，则 tags 应包含"我等你回来"、"等你回来"、"等你"、"等待"等），让用户搜句子片段也能命中。
3. tags 要覆盖：场景、情绪、动作、人物特征、可能的使用场景、角色名（如果认识）。每个 tag 是单独的中文短语，不要带标点。
4. emotion 必须是中文词，不要用英文 joy/sad/anger。
5. 输出必须是合法 JSON，仅 JSON，无其他字符。`;

interface TagResult {
  description: string;
  tags: string[];
  emotion: string;
  has_text: boolean;
  text_content: string | null;
}

interface TagProvider {
  name: string;
  tag(absPath: string): Promise<TagResult>;
}

function extractJson(text: string): string {
  // 兼容 ```json fence（可能没闭合）+ 前后多余文字
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, "");
  t = t.replace(/\s*```\s*$/, "");
  t = t.trim();
  if (t.startsWith("{")) return t;
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return t.slice(first, last + 1);
  return t;
}

function parseXmlTagResult(text: string): TagResult {
  // 从 XML 包裹的输出里提取字段
  const grab = (tag: string): string | null => {
    const re = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, "i");
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  const description = grab("description") ?? "";
  const emotion = grab("emotion") ?? "中性";
  const hasTextRaw = (grab("has_text") ?? "").toLowerCase();
  const has_text = hasTextRaw === "true" || hasTextRaw === "1" || hasTextRaw === "yes";
  let text_content: string | null = grab("text_content");
  if (text_content === null || /^(none|null|无|没有|无文字)$/i.test(text_content.trim())) {
    text_content = null;
  }
  const tagsBlock = grab("tags") ?? "";
  const tags = tagsBlock
    .split(/\n/)
    .map((l) => l.replace(/^\s*[-*•·]\s*/, "").trim())
    .filter((l) => l.length > 0);

  if (!description && tags.length === 0) {
    throw new Error(`XML parse 失败，没找到任何字段: ${text.slice(0, 200)}`);
  }
  return { description, tags, emotion, has_text, text_content };
}

function normalizeTag(raw: unknown): TagResult {
  const p = (raw ?? {}) as Partial<TagResult>;
  return {
    description: String(p.description ?? ""),
    tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
    emotion: String(p.emotion ?? "中性"),
    has_text: Boolean(p.has_text),
    text_content: p.text_content ? String(p.text_content) : null,
  };
}

function buildUserPrompt(gridPath: string, isGifGrid: boolean): string {
  const intro = isGifGrid
    ? `请用 Read 工具读取图片：${gridPath}

注意：这是一张 GIF 动图按时间顺序抽 9 帧拼成的 3×3 宫格（左上→右下是时间序列）。请把它当作"同一个表情包的不同时刻"来理解，**不是 9 个不同的表情包**。字幕可能只在中间某几格出现。`
    : `请用 Read 工具读取图片：${gridPath}`;

  return `${intro}

严格按以下 XML 格式输出 5 个字段（每个标签必须出现），不要输出标签之外的任何文字：

<description>一句话描述图片（人物/动作/场景），不超过 30 字</description>
<emotion>中文情绪词：开心 / 阴阳 / 委屈 / 愤怒 / 无奈 / 鼓励 / 中性 / 困惑 / 害羞 / 难过 等</emotion>
<has_text>true 或 false（小写）</has_text>
<text_content>图上所有文字逐字识别，多句用空格分隔；无文字时写 NONE</text_content>
<tags>
- tag1
- tag2
（共 8-20 个，每行一个，前面带 "- "）
</tags>

要求（极其重要）:
1. text_content 必须把图上能看到的每一个汉字都识别进去（字幕/对话框/标语/台词），一字不漏。${isGifGrid ? "宫格里 9 个时刻出现过的所有文字都要识别。" : ""}
2. 如果有文字，按句拆开后也加进 tags（例如"我等你回来" → tags 含"我等你回来"、"等你回来"、"等你"、"等待"）。
3. tags 覆盖：场景、情绪、动作、人物特征、可能的使用场景、角色名。每个 tag 是中文短语，不带标点。
4. emotion 必须是中文词，不要用英文。
5. ${isGifGrid ? "description 是描述整个表情包（一个时刻或动作），不要写成 9 张图各自描述。" : ""}`;
}

function makeAnthropicSdkProvider(model: string, apiKey: string): TagProvider {
  const client = new Anthropic({ apiKey });
  return {
    name: `anthropic SDK (${model})`,
    async tag(absPath: string): Promise<TagResult> {
      const { data, media_type } = await loadImageForVLM(absPath);
      const resp = await client.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type, data } },
              { type: "text", text: "打标这张表情包。" },
            ],
          },
        ],
      });
      const text = resp.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("");
      return normalizeTag(parseXmlTagResult(text));
    },
  };
}

function runClaudeWithStdin(
  prompt: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude 退出码 ${code}: ${stderr.slice(0, 400)}`));
    });
    child.stdin.end(prompt);
  });
}

function makeClaudeCliProvider(model: string): TagProvider {
  // 不继承 ANTHROPIC_API_KEY，强制 claude 走 OAuth（Max 配额）
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "ANTHROPIC_API_KEY"),
  ) as NodeJS.ProcessEnv;
  return {
    name: `claude CLI (${model})`,
    async tag(absPath: string): Promise<TagResult> {
      const isGif = path.extname(absPath).toLowerCase() === ".gif";
      const { tmpPath, cleanup } = await prepareGridImage(absPath);
      try {
        const prompt = buildUserPrompt(tmpPath, isGif);
        const stdout = await runClaudeWithStdin(
          prompt,
          [
            "-p",
            "--model",
            model,
            "--output-format",
            "json",
            "--allowedTools",
            "Read",
            "--add-dir",
            os.tmpdir(),
          ],
          env,
        );
        let result: { is_error?: boolean; result?: string };
        try {
          result = JSON.parse(stdout);
        } catch {
          throw new Error(`claude 返回非 JSON: ${stdout.slice(0, 200)}`);
        }
        if (result.is_error) {
          throw new Error(`claude error: ${result.result ?? "unknown"}`);
        }
        const text = String(result.result ?? "");
        return normalizeTag(parseXmlTagResult(text));
      } finally {
        await cleanup();
      }
    },
  };
}

function buildGeminiPrompt(absPath: string): string {
  return `请分析这张表情包图片：${absPath}

**关键**：如果是 GIF 动图，请看完所有帧（字幕可能在不同帧出现）。

严格按以下 XML 格式输出 5 个字段（每个标签必须出现），不要输出标签之外的任何文字：

<description>一句话描述图片（人物/动作/场景），不超过 30 字</description>
<emotion>中文情绪词：开心 / 阴阳 / 委屈 / 愤怒 / 无奈 / 鼓励 / 中性 / 困惑 / 害羞 / 难过 等</emotion>
<has_text>true 或 false（小写）</has_text>
<text_content>图上所有文字逐字识别，多句用空格分隔；无文字时写 NONE</text_content>
<tags>
- tag1
- tag2
（共 8-20 个，每行一个，前面带 "- "）
</tags>

要求（极其重要）:
1. text_content 必须把图上能看到的每一个汉字都识别进去（字幕/对话框/标语/台词），一字不漏。GIF 动图里所有帧出现过的文字都要识别。
2. 如果有文字，按句拆开后也加进 tags（例如"我等你回来" → tags 含"我等你回来"、"等你回来"、"等你"、"等待"）。
3. tags 覆盖：场景、情绪、动作、人物特征、可能的使用场景、角色名。每个 tag 是中文短语，不带标点。
4. emotion 必须是中文词，不要用英文。
5. 标签内可以自由使用中文符号，无需转义任何字符。`;
}

function makeGeminiCliProvider(model: string | null): TagProvider {
  return {
    name: `gemini CLI${model ? ` (${model})` : " (default)"}`,
    async tag(absPath: string): Promise<TagResult> {
      const prompt = buildGeminiPrompt(absPath);
      const args = ["-p", prompt, "--output-format", "json", "--yolo"];
      if (model) args.push("--model", model);
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn("gemini", args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (err += d.toString()));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve(out);
          else reject(new Error(`gemini 退出码 ${code}: ${err.slice(0, 400)}`));
        });
        child.stdin.end();
      });
      // Gemini 输出含 warnings + 末尾 JSON envelope；找最后一个完整 JSON 对象
      const jsonStart = stdout.lastIndexOf('{\n  "session_id"');
      const candidate = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
      let envelope: { response?: string; error?: { message?: string } };
      try {
        envelope = JSON.parse(candidate);
      } catch {
        throw new Error(`gemini 输出找不到合法 JSON envelope: ${stdout.slice(-300)}`);
      }
      if (envelope.error) throw new Error(`gemini error: ${envelope.error.message}`);
      const text = String(envelope.response ?? "");
      return normalizeTag(parseXmlTagResult(text));
    },
  };
}

function pickProvider(provider: string, model: string): TagProvider {
  if (provider === "gemini") {
    // Gemini default：不传 --model，让 CLI 内部分发（utility + vision 模型组合）
    // 显式指定 model 时（例如 --model gemini-3.1-pro-preview）才传
    const explicitModel = model && model !== "claude-sonnet-4-6" ? model : null;
    return makeGeminiCliProvider(explicitModel);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return makeAnthropicSdkProvider(model, process.env.ANTHROPIC_API_KEY);
  }
  return makeClaudeCliProvider(model);
}

// ---------------- 批量打标（一个 claude session 跑多张图）----------------

function buildBatchPrompt(gridPaths: string[]): string {
  const n = gridPaths.length;
  const list = gridPaths.map((p, i) => `${i + 1}. ${p}`).join("\n");
  return `请用 Read 工具依次读取下列 ${n} 张图片，对每张图输出一个 XML 块。

**关键**：每张图都是一个 GIF 动图按时间顺序抽 9 帧拼成的 3×3 宫格（左上→右下是时间序列）。要把每张拼图当作"同一个表情包的不同时刻"理解，不是 9 个不同表情包。字幕可能只在中间某几格出现，要把所有出现过的文字都识别进 text_content。

图片清单（请严格按编号顺序处理）:
${list}

输出 ${n} 个 <image> 块，每张图一个块，格式严格如下：

<image>
<idx>1</idx>
<description>一句话描述这个表情包（整体动作/场景，不是描述 9 张图），≤30字</description>
<emotion>中文情绪词（开心 / 阴阳 / 委屈 / 愤怒 / 无奈 / 鼓励 / 中性 / 困惑 / 害羞 / 难过 等）</emotion>
<has_text>true 或 false</has_text>
<text_content>图上所有文字逐字识别（宫格 9 格出现过的所有字），多句用空格分隔；无文字写 NONE</text_content>
<tags>
- tag1
- tag2
（8-20 个，每行一个，前面 "- "）
</tags>
</image>

要求（极其重要）:
1. 必须输出 ${n} 个 <image> 块，每张图一个，按编号 1 到 ${n} 顺序，不能漏。
2. <idx> 必须填对应编号（1 到 ${n}）。
3. text_content 把图上每个汉字都识别进去，一字不漏。宫格里 9 个时刻出现过的所有字都要识别（字幕可能只在中间几帧）。
4. 如果有文字，按句拆开后也加进 tags（"我等你回来" → "等你回来"、"等你"、"等待"）。
5. tags 覆盖：场景、情绪、动作、人物、使用场景、角色名。中文短语，不带标点。
6. emotion 用中文词，不要英文。
7. 仅输出 XML 块。不要任何前言、后语、解释、markdown 标记。
8. description 写整张表情包的描述，不要写成"9 张图各自描述"。即使到第 ${n} 张也要认真。`;
}

async function tagBatchViaClaudeCli(
  absPaths: string[],
  model: string,
  env: NodeJS.ProcessEnv,
): Promise<Map<number, TagResult>> {
  // 并行抽帧拼图
  const prepared = await Promise.all(absPaths.map((p) => prepareGridImage(p)));
  const cleanup = async () => {
    await Promise.all(prepared.map((x) => x.cleanup()));
  };
  try {
    const gridPaths = prepared.map((x) => x.tmpPath);
    const prompt = buildBatchPrompt(gridPaths);
    const stdout = await runClaudeWithStdin(
      prompt,
      [
        "-p",
        "--model",
        model,
        "--output-format",
        "json",
        "--allowedTools",
        "Read",
        "--add-dir",
        os.tmpdir(),
        // 每张图至少 1 个 Read turn + 最后 1 个输出 turn，给充足 turn
        "--max-turns",
        String(absPaths.length * 2 + 5),
      ],
      env,
    );
    let result: { is_error?: boolean; result?: string };
    try {
      result = JSON.parse(stdout);
    } catch {
      throw new Error(`claude 返回非 JSON envelope: ${stdout.slice(0, 200)}`);
    }
    if (result.is_error) {
      throw new Error(`claude error: ${result.result ?? "unknown"}`);
    }
    const text = String(result.result ?? "");
    const map = new Map<number, TagResult>();
    for (const m of text.matchAll(/<image>([\s\S]*?)<\/image>/g)) {
      const block = m[1];
      const idxMatch = block.match(/<idx>\s*(\d+)\s*<\/idx>/);
      if (!idxMatch) continue;
      const idx = parseInt(idxMatch[1], 10) - 1;
      if (idx < 0 || idx >= absPaths.length) continue;
      try {
        map.set(idx, normalizeTag(parseXmlTagResult(block)));
      } catch {
        // 单张解析失败，跳过；外层会 fallback 重试
      }
    }
    return map;
  } finally {
    await cleanup();
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 1) return arr.map((x) => [x]);
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

// ---------------- index.json 读写 ----------------

async function loadIndex(indexPath: string): Promise<IndexFile> {
  if (!fsSync.existsSync(indexPath)) return { meta: { schema_version: 2 }, items: [] };
  const raw = await fs.readFile(indexPath, "utf-8");
  const j = JSON.parse(raw) as IndexFile;
  if (!j.items) j.items = [];
  return j;
}

async function saveIndex(indexPath: string, idx: IndexFile): Promise<void> {
  // 原子写
  const tmp = indexPath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(idx, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, indexPath);
}

// ---------------- 主流程：打标 ----------------

async function runTag(opts: CliOpts) {
  const memeDir = path.resolve(opts.dir);
  const indexPath = path.join(memeDir, "index.json");

  if (!fsSync.existsSync(memeDir)) {
    throw new Error(`memeDir 不存在: ${memeDir}`);
  }

  const idx = await loadIndex(indexPath);
  const existing = new Map(idx.items.map((it) => [it.filename, it]));

  const allFiles = await scanImages(memeDir);
  if (allFiles.length === 0) {
    console.log("memeDir 下没找到图片");
    return;
  }

  let targets: string[];
  if (opts.file) {
    targets = [opts.file];
  } else if (opts.force) {
    targets = allFiles;
  } else {
    targets = allFiles.filter((f) => !existing.has(f));
  }
  if (opts.limit !== null && targets.length > opts.limit) {
    targets = targets.slice(0, opts.limit);
  }

  console.log(
    `[scan] 共 ${allFiles.length} 张图，已打标 ${existing.size} 张，本次待打标 ${targets.length} 张`,
  );
  if (targets.length === 0) {
    console.log("[done] 没有需要打标的图，加 --force 全量重打");
    return;
  }

  const provider = pickProvider(opts.provider, opts.model);
  const useBatch = opts.batchSize > 1 && opts.provider === "claude" && !process.env.ANTHROPIC_API_KEY;
  console.log(
    `[provider] ${provider.name}${useBatch ? ` · batch-size=${opts.batchSize}` : ""}`,
  );
  // batch 模式需要的环境（去掉 ANTHROPIC_API_KEY 强制走 claude CLI OAuth）
  const claudeEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "ANTHROPIC_API_KEY"),
  ) as NodeJS.ProcessEnv;

  const limit = pLimit(opts.concurrency);
  let done = 0;
  let failed = 0;
  let savedAt = Date.now();
  const SAVE_EVERY_MS = 5000;
  const SAVE_EVERY_N = 10;

  const persist = async () => {
    // 把 existing map 合并回 idx.items
    idx.items = Array.from(existing.values()).sort((a, b) => a.filename.localeCompare(b.filename));
    await saveIndex(indexPath, idx);
  };

  // 处理 Ctrl+C 时持久化
  let interrupted = false;
  const onSig = async () => {
    if (interrupted) return;
    interrupted = true;
    console.log("\n[interrupt] 中断，落盘后退出...");
    await persist();
    process.exit(130);
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  if (useBatch) {
    const batches = chunkArray(targets, opts.batchSize);
    await Promise.all(
      batches.map((batch, bIdx) =>
        limit(async () => {
          if (interrupted) return;
          const absPaths = batch.map((rel) => path.join(memeDir, rel));
          try {
            const [results, phashes] = await Promise.all([
              tagBatchViaClaudeCli(absPaths, opts.model, claudeEnv),
              Promise.all(absPaths.map((p) => aHash(p).catch(() => undefined))),
            ]);
            for (let i = 0; i < batch.length; i++) {
              const rel = batch[i];
              const tag = results.get(i);
              if (!tag) {
                failed++;
                process.stderr.write(`\n[fail] ${rel}: batch 响应里缺这一张\n`);
                continue;
              }
              const phash = phashes[i];
              existing.set(rel, {
                filename: rel,
                ...tag,
                ...(phash ? { phash } : {}),
              });
              done++;
            }
            process.stdout.write(
              `\r[batch] ${bIdx + 1}/${batches.length} | 累计成功 ${done} 失败 ${failed}            `,
            );
          } catch (e) {
            failed += batch.length;
            process.stderr.write(
              `\n[batch-fail] ${batch[0]}... +${batch.length - 1} 张: ${(e as Error).message}\n`,
            );
          }
          if (Date.now() - savedAt > SAVE_EVERY_MS) {
            await persist();
            savedAt = Date.now();
          }
        }),
      ),
    );
  } else {
    await Promise.all(
      targets.map((rel) =>
        limit(async () => {
          if (interrupted) return;
          const abs = path.join(memeDir, rel);
          try {
            const [tag, phash] = await Promise.all([
              provider.tag(abs),
              aHash(abs).catch(() => undefined),
            ]);
            const item: MemeItem = {
              filename: rel,
              ...tag,
              ...(phash ? { phash } : {}),
            };
            existing.set(rel, item);
            done++;
            process.stdout.write(
              `\r[progress] ${done + failed}/${targets.length} 成功 ${done} 失败 ${failed} | ${rel.slice(-50)}            `,
            );
          } catch (e) {
            failed++;
            process.stderr.write(`\n[fail] ${rel}: ${(e as Error).message}\n`);
          }
          if (done % SAVE_EVERY_N === 0 || Date.now() - savedAt > SAVE_EVERY_MS) {
            await persist();
            savedAt = Date.now();
          }
        }),
      ),
    );
  }

  process.stdout.write("\n");
  await persist();
  console.log(
    `[done] 成功 ${done} / 失败 ${failed} / 总计 ${targets.length}，index.json 已保存`,
  );
}

// ---------------- 主流程：dedup ----------------

async function runDedup(opts: CliOpts) {
  const memeDir = path.resolve(opts.dir);
  const indexPath = path.join(memeDir, "index.json");
  const idx = await loadIndex(indexPath);

  // 给没有 phash 的补算
  const missing = idx.items.filter((it) => !it.phash);
  if (missing.length > 0) {
    console.log(`[dedup] 有 ${missing.length} 张图没有 phash，先补算...`);
    const limit = pLimit(opts.concurrency);
    let done = 0;
    await Promise.all(
      missing.map((it) =>
        limit(async () => {
          try {
            it.phash = await aHash(path.join(memeDir, it.filename));
          } catch (e) {
            process.stderr.write(`\n[phash-fail] ${it.filename}: ${(e as Error).message}\n`);
          }
          done++;
          process.stdout.write(`\r[phash] ${done}/${missing.length}            `);
        }),
      ),
    );
    process.stdout.write("\n");
    await saveIndex(indexPath, idx);
  }

  const items = idx.items.filter((it) => it.phash);
  const pairs: Array<{ a: string; b: string; d: number }> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const d = hamming(items[i].phash!, items[j].phash!);
      if (d <= opts.dedupThreshold) {
        pairs.push({ a: items[i].filename, b: items[j].filename, d });
      }
    }
  }

  if (pairs.length === 0) {
    console.log(`[dedup] 没找到 phash 距离 ≤ ${opts.dedupThreshold} 的图片对`);
    return;
  }
  pairs.sort((x, y) => x.d - y.d);
  console.log(`[dedup] 找到 ${pairs.length} 对疑似重复（距离 ≤ ${opts.dedupThreshold}）：\n`);
  for (const p of pairs) {
    console.log(`  d=${p.d}\t${p.a}\n        ${p.b}`);
  }
  console.log(
    `\n提示：阈值 0 = 完全相同；越大越宽松。脚本不会自动删除，请手动检查后用 rm 处理。`,
  );
}

// ---------------- 入口 ----------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.dedup) {
    await runDedup(opts);
  } else {
    await runTag(opts);
  }
}

main().catch((e) => {
  process.stderr.write(`\n[error] ${(e as Error).message}\n`);
  process.exit(1);
});
