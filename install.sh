#!/usr/bin/env bash
# 一键在当前 Ollama 里创建「知夏」模型
#
# 用法:
#   ./install.sh                  # 默认创建模型 zhixia（显示名仍是「知夏」）
#   ./install.sh senpai           # 自定义模型名（只能用 ASCII）
#   BASE=qwen3:14b ./install.sh   # 换底座模型
#
# 注意：Ollama 的模型名不允许非 ASCII 字符，所以模型 id 用 zhixia，
# 角色自称仍然是「知夏」。
set -euo pipefail

NAME="${1:-zhixia}"
BASE="${BASE:-gemma3:12b}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELFILE="$DIR/configs/Modelfile"
TMP="$(mktemp)"

cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

command -v ollama >/dev/null 2>&1 || {
  echo "❌ 找不到 ollama 命令。" >&2
  echo "   安装见 https://ollama.com/download ；若已装但不在 PATH，先 export PATH。" >&2
  exit 1
}

if ! ollama list >/dev/null 2>&1; then
  echo "❌ Ollama 服务没在跑。先执行：ollama serve" >&2
  exit 1
fi

# 检查底座模型是否已拉取
if ! ollama list | awk '{print $1}' | grep -qx "$BASE"; then
  echo "⚠️  本地没有 $BASE，先拉取（约几 GB）..."
  ollama pull "$BASE"
fi

# 按选择替换 FROM 行
sed "s|^FROM .*|FROM $BASE|" "$MODELFILE" > "$TMP"

if ! printf '%s' "$NAME" | grep -qE '^[a-zA-Z0-9._:-]+$'; then
  echo "❌ 模型名只能用 ASCII（字母数字 . _ : -）。\n   Ollama 不接受中文名，建议用 zhixia，角色自称仍是「知夏」。" >&2
  exit 1
fi

echo "🔧 正在创建模型「$NAME」（底座 $BASE）..."
ollama create "$NAME" -f "$TMP"

echo
echo "✅ 完成。试试看："
echo "   ollama run $NAME"
echo
echo "   或者走 API："
echo "   curl http://127.0.0.1:11434/v1/chat/completions \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"model\":\"$NAME\",\"messages\":[{\"role\":\"user\",\"content\":\"在干嘛\"}]}'"
