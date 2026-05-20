import {
  Grid,
  ActionPanel,
  Action,
  Clipboard,
  Icon,
  getPreferenceValues,
  showHUD,
  showToast,
  Toast,
  open,
  LocalStorage,
} from "@raycast/api";
import fs from "fs";
import path from "path";
import { useEffect, useMemo, useState } from "react";

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

interface Preferences {
  memeDir: string;
  columns?: string;
}

const ALL_SERIES = "__all__";
const RECENT_KEY = "recent-memes";
const RECENT_MAX = 50;

function loadIndex(memeDir: string): IndexFile | null {
  const indexPath = path.join(memeDir, "index.json");
  if (!fs.existsSync(indexPath)) return null;
  const raw = fs.readFileSync(indexPath, "utf-8");
  return JSON.parse(raw) as IndexFile;
}

function scoreItem(item: MemeItem, query: string): number {
  if (!query.trim()) return 1;
  const q = query.toLowerCase();
  const text = (item.text_content ?? "").toLowerCase();
  const desc = item.description.toLowerCase();
  const tagsLower = item.tags.map((t) => t.toLowerCase());
  const emotion = item.emotion.toLowerCase();

  if (text.includes(q)) return 100;
  if (tagsLower.some((t) => t === q)) return 90;
  if (tagsLower.some((t) => t.includes(q))) return 70;
  if (emotion.includes(q)) return 60;
  if (desc.includes(q)) return 50;
  return 0;
}

// 一级目录名当系列；没有子目录的归到「未分类」
function seriesOf(filename: string): string {
  const idx = filename.indexOf("/");
  if (idx === -1) return "未分类";
  return filename.slice(0, idx);
}

async function loadRecent(): Promise<string[]> {
  const raw = await LocalStorage.getItem<string>(RECENT_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function pushRecent(filename: string): Promise<void> {
  const cur = await loadRecent();
  const next = [filename, ...cur.filter((x) => x !== filename)].slice(
    0,
    RECENT_MAX,
  );
  await LocalStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

export default function Command() {
  const prefs = getPreferenceValues<Preferences>();
  const columns = Math.max(
    3,
    Math.min(8, parseInt(prefs.columns || "5", 10) || 5),
  );

  const indexData = useMemo(() => loadIndex(prefs.memeDir), [prefs.memeDir]);
  const [searchText, setSearchText] = useState("");
  const [series, setSeries] = useState(ALL_SERIES);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    loadRecent().then(setRecent);
  }, []);

  // 系列计数（按一级目录）
  const seriesCounts = useMemo(() => {
    if (!indexData) return new Map<string, number>();
    const m = new Map<string, number>();
    for (const it of indexData.items) {
      const s = seriesOf(it.filename);
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  }, [indexData]);

  const filtered = useMemo(() => {
    if (!indexData) return [];
    let items = indexData.items;
    if (series !== ALL_SERIES) {
      items = items.filter((it) => seriesOf(it.filename) === series);
    }
    if (!searchText.trim()) {
      // 无 query：最近使用排前，其余按文件名
      const recentOrder = new Map(recent.map((f, i) => [f, i]));
      return [...items].sort((a, b) => {
        const ra = recentOrder.get(a.filename) ?? Infinity;
        const rb = recentOrder.get(b.filename) ?? Infinity;
        if (ra !== rb) return ra - rb;
        return a.filename.localeCompare(b.filename);
      });
    }
    return items
      .map((item) => ({ item, score: scoreItem(item, searchText) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item);
  }, [searchText, indexData, series, recent]);

  if (!indexData) {
    return (
      <Grid>
        <Grid.EmptyView
          title="找不到 index.json"
          description={`请检查目录：${prefs.memeDir}\n里面需要有 index.json 文件。先在 repo 里跑 npm run tag 生成。`}
          icon={Icon.ExclamationMark}
        />
      </Grid>
    );
  }

  const totalCount = indexData.items.length;
  const visibleCount = filtered.length;
  const seriesList = Array.from(seriesCounts.entries()).sort(
    (a, b) => b[1] - a[1],
  );

  return (
    <Grid
      columns={columns}
      inset={Grid.Inset.Small}
      searchBarPlaceholder={`搜 ${visibleCount}/${totalCount} 张（标签/文字/情绪）`}
      onSearchTextChange={setSearchText}
      filtering={false}
      throttle
      searchBarAccessory={
        <Grid.Dropdown
          tooltip="按系列过滤"
          value={series}
          onChange={setSeries}
          storeValue
        >
          <Grid.Dropdown.Item
            title={`全部（${totalCount}）`}
            value={ALL_SERIES}
          />
          {seriesList.length > 0 && (
            <Grid.Dropdown.Section title="按系列">
              {seriesList.map(([s, n]) => (
                <Grid.Dropdown.Item key={s} title={`${s}（${n}）`} value={s} />
              ))}
            </Grid.Dropdown.Section>
          )}
        </Grid.Dropdown>
      }
    >
      {filtered.length === 0 ? (
        <Grid.EmptyView
          title="没找到匹配的表情"
          description="试试换关键词，或者跑 npm run tag 给更多图打标"
          icon={Icon.MagnifyingGlass}
        />
      ) : (
        filtered.map((item) => {
          const fullPath = path.join(prefs.memeDir, item.filename);
          const title = item.text_content || item.description;
          const subtitle = item.tags.slice(0, 4).join(" · ");
          return (
            <Grid.Item
              key={item.filename}
              content={{ source: fullPath }}
              title={title}
              subtitle={subtitle}
              keywords={[
                ...item.tags,
                item.description,
                item.text_content || "",
                item.emotion,
              ]}
              actions={
                <ActionPanel>
                  <Action
                    title="复制到剪贴板（可粘贴到微信）"
                    icon={Icon.Clipboard}
                    onAction={async () => {
                      try {
                        await Clipboard.copy({ file: fullPath });
                        await pushRecent(item.filename);
                        setRecent(await loadRecent());
                        await showHUD("✅ 已复制，去微信 Cmd+V 粘贴");
                      } catch (e) {
                        await showToast({
                          style: Toast.Style.Failure,
                          title: "复制失败",
                          message: String(e),
                        });
                      }
                    }}
                  />
                  <Action.Paste
                    title="直接粘贴到前台应用"
                    content={{ file: fullPath }}
                    icon={Icon.ArrowRight}
                    onPaste={async () => {
                      await pushRecent(item.filename);
                      setRecent(await loadRecent());
                    }}
                  />
                  <Action
                    title="用默认应用打开"
                    icon={Icon.Eye}
                    shortcut={{ modifiers: ["cmd"], key: "o" }}
                    onAction={() => open(fullPath)}
                  />
                  <Action.ShowInFinder
                    path={fullPath}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
                  />
                  <Action.CopyToClipboard
                    title="复制文件路径（调试用）"
                    content={fullPath}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                  />
                  <Action
                    title="从最近使用中移除"
                    icon={Icon.XMarkCircle}
                    shortcut={{ modifiers: ["ctrl"], key: "x" }}
                    onAction={async () => {
                      const cur = await loadRecent();
                      const next = cur.filter((x) => x !== item.filename);
                      await LocalStorage.setItem(
                        RECENT_KEY,
                        JSON.stringify(next),
                      );
                      setRecent(next);
                      await showToast({
                        style: Toast.Style.Success,
                        title: "已从最近使用移除",
                      });
                    }}
                  />
                </ActionPanel>
              }
            />
          );
        })
      )}
    </Grid>
  );
}
