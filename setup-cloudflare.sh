#!/usr/bin/env bash
# Cloudflare Workers + KV をセットアップして、フロントの API_BASE まで書き換える。
# 使い方: ./setup-cloudflare.sh   （リポジトリのルートで実行）
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$PWD"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

command -v node >/dev/null || die "node が見つかりません。https://nodejs.org から入れてください。"

# GitHub Pages のオリジンを remote から組み立てる
SLUG="$(git remote get-url origin | sed -E 's#.*github\.com[:/]([^/]+)/([^/.]+)(\.git)?$#\1 \2#')"
GH_USER="${SLUG%% *}"
PAGES_ORIGIN="https://${GH_USER}.github.io"
echo "GitHub Pages のオリジン: $PAGES_ORIGIN"

say "1/5  Cloudflare にログイン"
if npx --yes wrangler@latest whoami >/dev/null 2>&1; then
  echo "ログイン済み。スキップします。"
else
  npx --yes wrangler@latest login
fi

say "2/5  KV ネームスペースを作成"
cd "$ROOT/worker"
set +e
OUT="$(npx --yes wrangler@latest kv namespace create PASTES 2>&1)"
set -e
echo "$OUT"
KV_ID="$(printf '%s' "$OUT" | grep -Eo '[0-9a-f]{32}' | head -1)"

if [ -z "$KV_ID" ]; then
  echo "作成結果からidを拾えませんでした。既存の一覧から探します。"
  LIST="$(npx --yes wrangler@latest kv namespace list 2>/dev/null)"
  KV_ID="$(printf '%s' "$LIST" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{ const a=JSON.parse(s.slice(s.indexOf("[")));
        const m=a.find(n=>/PASTES/.test(n.title||""));
        if(m) console.log(m.id);
      }catch(e){}
    })')"
fi
[ -n "$KV_ID" ] || die "KVのidを取得できませんでした。手動で wrangler.toml に貼ってください。"
echo "KV id: $KV_ID"

say "3/5  wrangler.toml を更新"
perl -i -pe "s{^id = \".*\"}{id = \"$KV_ID\"}" wrangler.toml
perl -i -pe "s{^ALLOWED_ORIGINS = \".*\"}{ALLOWED_ORIGINS = \"$PAGES_ORIGIN\"}" wrangler.toml
grep -E '^(id|ALLOWED_ORIGINS)' wrangler.toml

say "4/5  Worker をデプロイ"
OUT="$(npx --yes wrangler@latest deploy 2>&1)"
echo "$OUT"
API_URL="$(printf '%s' "$OUT" | grep -Eo 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)"
[ -n "$API_URL" ] || die "デプロイ結果からURLを拾えませんでした。手動で site/index.html の API_BASE を書いてください。"
echo "API: $API_URL"

echo "疎通確認:"
curl -fsS "$API_URL/health" && echo

say "5/5  フロントの API_BASE を書き換え"
cd "$ROOT"
perl -i -pe "s{var API_BASE = '.*'}{var API_BASE = '$API_URL'}" site/index.html
grep -n "var API_BASE" site/index.html

printf '\n以上が完了しました。GitHub に push すると Pages に反映されます。\n'
read -r -p "いま push しますか? [y/N] " ans
if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
  git add -A
  git commit -m "Configure Cloudflare Worker endpoint and KV namespace"
  git push
  printf '\n完了。数十秒後に %s/%s/ に反映されます。\n' "$PAGES_ORIGIN" "$(basename "$ROOT")"
else
  printf '\n後で push してください: git add -A && git commit -m "Configure Cloudflare endpoint" && git push\n'
fi
