#!/usr/bin/env bash
# bump-tag.sh — 自动算下一个 semver tag 并打 + 推
#
# 用法：
#   ./scripts/bump-tag.sh <patch|minor|major> [-m "message"]
#
# 例：
#   ./scripts/bump-tag.sh patch                # v0.0.1 → v0.0.2
#   ./scripts/bump-tag.sh minor                # v0.0.5 → v0.1.0
#   ./scripts/bump-tag.sh major -m "重构 schema" # v0.3.4 → v1.0.0
#
# 规则：
# - tag 命名约定：v<MAJOR>.<MINOR>.<PATCH>
# - patch：bug fix / 文案 / 行为无变化
# - minor：新功能 / 新命令（向后兼容）
# - major：breaking change（index.json schema 改、preference key 改名 etc）
# - 只在 main 上打；不在 main 上时退出
# - 工作区必须干净（无未提交改动）
# - 同 tag 已存在则退出，不覆盖
# - 没有任何历史 tag 时，从 v0.0.1 起步

set -euo pipefail

BUMP="${1:-}"
MSG=""

if [[ "${2:-}" == "-m" && -n "${3:-}" ]]; then
  MSG="$3"
fi

if [[ -z "$BUMP" ]]; then
  echo "用法: $0 <patch|minor|major> [-m \"message\"]" >&2
  echo "现有 tag:" >&2
  git tag -l 'v*' | sort -V | tail -5 | sed 's/^/  /' >&2
  exit 1
fi

case "$BUMP" in
  patch|minor|major) ;;
  *) echo "❌ bump 必须是 patch / minor / major，不是 '$BUMP'" >&2; exit 1 ;;
esac

# 必须在 main 上
BRANCH=$(git symbolic-ref --short HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "❌ 当前分支 $BRANCH，tag 只在 main 上打。先 git checkout main 再试" >&2
  exit 1
fi

# 工作区必须干净
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ 工作区有未提交改动，先 commit / stash 再打 tag" >&2
  exit 1
fi

# 找最新 tag
LATEST=$(git tag -l 'v*' | sort -V | tail -n1)
if [[ -z "$LATEST" ]]; then
  echo "ℹ️  还没有任何 tag，从 v0.0.1 开始（你可以 ctrl-c 取消后手动打另一个起点）" >&2
  NEW="v0.0.1"
else
  VER=${LATEST#v}
  IFS='.' read -r MAJOR MINOR PATCH <<< "$VER"

  case "$BUMP" in
    patch) PATCH=$((PATCH+1)) ;;
    minor) MINOR=$((MINOR+1)); PATCH=0 ;;
    major) MAJOR=$((MAJOR+1)); MINOR=0; PATCH=0 ;;
  esac

  NEW="v${MAJOR}.${MINOR}.${PATCH}"
fi

# 同名 tag 已存在则退出
if git rev-parse "$NEW" >/dev/null 2>&1; then
  echo "❌ tag $NEW 已存在" >&2
  exit 1
fi

# 默认 message：用最近一次 commit subject
if [[ -z "$MSG" ]]; then
  MSG=$(git log -1 --pretty=format:"%s")
fi

HEAD=$(git rev-parse --short HEAD)
echo "→ 在 $HEAD 上打 tag $NEW"
echo "  bump:  ${LATEST:-<none>} → $NEW ($BUMP)"
echo "  msg:   $MSG"
echo

read -r -p "确认? [y/N] " ans
if [[ "$ans" != "y" && "$ans" != "Y" ]]; then
  echo "取消" >&2
  exit 1
fi

git tag -a "$NEW" -m "$MSG"
git push origin "$NEW"

echo
echo "✅ $NEW 已打并推到 origin"
