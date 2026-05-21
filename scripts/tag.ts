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

import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  buildBatchPrompt,
  buildGeminiPrompt,
} from "./prompts";

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
 * 从 ffmpeg 的 stderr 里解析出 gif 时长（秒）。失败 fallback 到 2.5。
 * 用 `ffmpeg -i input.gif` 即可（无 ffprobe 依赖）；ffmpeg 会因为没有 output 报错退出，
 * 但 stderr 里有 "Duration: HH:MM:SS.MS"。
 */
async function getGifDuration(absPath: string): Promise<number> {
  try {
    await execFileAsync("ffmpeg", ["-i", absPath]);
  } catch (e: unknown) {
    const stderr = String((e as { stderr?: Buffer }).stderr ?? "");
    const m = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (m) {
      return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
    }
  }
  return 2.5; // fallback
}

/**
 * GIF → 抽 16 帧拼 4x4 宫格 PNG（每帧 400x400，输出 1600x1600）。
 *
 * 设计要点（2026-05-21 benchmark 之后调整）：
 * - 4x4 vs 3x3：多看 7 帧让 Claude 抓到更完整时序，#3 这种"前几帧像愤怒、整段是无奈"
 *   的 case 能改对（详见 docs/decision-log/2026-05-21-meme-tagging-pipeline.md）。
 * - 均匀采样：用 ffmpeg 的 fps 滤镜 = 16/duration，覆盖整段时间线（旧版 mod(n,3) 偏前）。
 *
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
    const duration = await getGifDuration(absPath);
    // 16 / duration = 目标采样 fps。clamp 到 [1, 30] 防极端值。
    const targetFps = Math.max(1, Math.min(30, 16 / Math.max(duration, 0.4)));
    const fpsStr = targetFps.toFixed(4);
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      absPath,
      "-vf",
      `fps=${fpsStr},scale=400:400:force_original_aspect_ratio=decrease,pad=400:400:(ow-iw)/2:(oh-ih)/2,tile=4x4`,
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
// Prompts 在 ./prompts.ts，import 在文件顶部。

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
