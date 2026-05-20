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
} from "@raycast/api";
import fs from "fs";
import path from "path";
import { useMemo, useState } from "react";

interface MemeItem {
  filename: string;
  description: string;
  tags: string[];
  emotion: string;
  has_text: boolean;
  text_content: string | null;
}

interface IndexFile {
  meta?: Record<string, unknown>;
  items: MemeItem[];
}

interface Preferences {
  memeDir: string;
  columns?: string;
}

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

  if (text.includes(q)) return 100;
  if (tagsLower.some((t) => t === q)) return 90;
  if (tagsLower.some((t) => t.includes(q))) return 70;
  if (desc.includes(q)) return 50;
  return 0;
}

export default function Command() {
  const prefs = getPreferenceValues<Preferences>();
  const columns = Math.max(3, Math.min(8, parseInt(prefs.columns || "5", 10) || 5));

  const indexData = useMemo(() => loadIndex(prefs.memeDir), [prefs.memeDir]);
  const [searchText, setSearchText] = useState("");

  const filtered = useMemo(() => {
    if (!indexData) return [];
    const items = indexData.items;
    if (!searchText.trim()) return items;
    return items
      .map((item) => ({ item, score: scoreItem(item, searchText) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item);
  }, [searchText, indexData]);

  if (!indexData) {
    return (
      <Grid>
        <Grid.EmptyView
          title="找不到 index.json"
          description={`请检查目录：${prefs.memeDir}\n里面需要有 index.json 文件`}
          icon={Icon.ExclamationMark}
        />
      </Grid>
    );
  }

  return (
    <Grid
      columns={columns}
      inset={Grid.Inset.Small}
      searchBarPlaceholder="搜标签 / 文字 / 情绪（如：开心、说得好、阴阳怪气）"
      onSearchTextChange={setSearchText}
      filtering={false}
      throttle
    >
      {filtered.length === 0 ? (
        <Grid.EmptyView
          title="没找到匹配的表情"
          description={`试试换个关键词，或检查 index.json 标签是否够全`}
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
              keywords={[...item.tags, item.description, item.text_content || "", item.emotion]}
              actions={
                <ActionPanel>
                  <Action
                    title="复制到剪贴板（可粘贴到微信）"
                    icon={Icon.Clipboard}
                    onAction={async () => {
                      try {
                        await Clipboard.copy({ file: fullPath });
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
                </ActionPanel>
              }
            />
          );
        })
      )}
    </Grid>
  );
}
