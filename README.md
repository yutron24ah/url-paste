# URL Paste

テキストを貼ると短いURLと合言葉ができて、その2つが揃うと読める。
フロントは GitHub Pages、保存は Cloudflare Workers + KV。

```
URL:    https://<ユーザー名>.github.io/url-paste/#8nqEd
合言葉:  c3j3-46qx-ue88
```

本文はブラウザ内で AES-GCM 256bit で暗号化してから送信する。
鍵は**合言葉から PBKDF2（SHA-256, 60万回）で導出**するので、合言葉もサーバーには送られない。
Cloudflare 側に残るのは、暗号文・IV・salt だけ。salt は秘密ではないので一緒に保存している。

URLと合言葉を別の経路で渡せば（例: URLはSlack、合言葉は口頭）、
どちらか一方が漏れただけでは本文は読めない。

---

## 構成

```
site/            GitHub Pages に置くもの
  index.html       画面とロジック全部（1ファイル）
  qrcode.min.js    QRコード生成 (MIT / kazuhikoarase)
worker/          Cloudflare Workers に置くもの
  src/index.js     API本体
  wrangler.toml    設定
test.mjs         APIのユニットテスト（23項目）
e2e.mjs          Chromiumでの実動作テスト（22項目）
```

## 機能

- テキスト → 5文字のIDのURL + 合言葉を生成
- 合言葉は自動生成（31文字種から12文字 ≒ 59ビット）。手入力に変えてもよい
- URL / 合言葉 / 両方まとめて、それぞれコピーボタン
- QRコード（スマホへの受け渡し用。URLのみで合言葉は含まない）
- 有効期限: 1時間 / 1日 / 7日 / 30日（KVのTTLで自動削除）
- 「一回読んだら消す」オプション
- ダークモード対応、スマホ幅対応
- 上限: 10万文字（暗号化後256KBまで）

### クリップボードについて

アプリ内ブラウザやiframeでは `navigator.clipboard` が拒否されることがあるため、
コピーは3段階で試す。

1. `navigator.clipboard.writeText()`
2. 対象を選択して `document.execCommand('copy')`
3. どちらも失敗したら選択状態にして「選択しました→⌘C」と表示（手動コピーに逃がす）

---

## セットアップ

### 0. 一括セットアップ（おすすめ）

```bash
./setup-cloudflare.sh
```

Cloudflareへのログイン、KVネームスペース作成、`wrangler.toml` へのid埋め込み、Workerのデプロイ、
`site/index.html` の `API_BASE` 書き換えまでを通しでやる。以下は中身の手動版。

### 1. Cloudflare Workers（API側）

```bash
npm install -g wrangler
wrangler login

cd worker

# KVネームスペースを作る（出力される id をメモ）
wrangler kv namespace create PASTES
```

`wrangler.toml` を2箇所書き換える。

```toml
[vars]
ALLOWED_ORIGINS = "https://<あなたのGitHubユーザー名>.github.io"

[[kv_namespaces]]
binding = "PASTES"
id = "上でメモしたid"
```

デプロイ。

```bash
wrangler deploy
# → https://urlpaste-api.<サブドメイン>.workers.dev が発行される
```

疎通確認:

```bash
curl https://urlpaste-api.<サブドメイン>.workers.dev/health
# {"ok":true}
```

### 2. GitHub Pages（画面側）

`site/index.html` の先頭付近を、発行されたWorkerのURLに書き換える。

```js
var API_BASE = 'https://urlpaste-api.YOUR-SUBDOMAIN.workers.dev';
```

あとは main に push して、**Settings → Pages → Source: GitHub Actions** を選ぶだけ。
`.github/workflows/pages.yml` が `site/` の中身だけを公開する。

（"Deploy from a branch" はルートか `/docs` しか選べないので、このワークフローを使っている。
`site/` を `docs/` にリネームすればブランチ公開でもいける。）

リポジトリ名を `url-paste` にした場合、公開URLは
`https://<ユーザー名>.github.io/url-paste/` になる。
これが `ALLOWED_ORIGINS` のオリジン（`https://<ユーザー名>.github.io`）と一致していないと
CORSで弾かれるので、そこだけ注意。

---

## ローカルで動かす

```bash
npm install                    # playwright と qrcode-generator を入れる
node test.mjs                  # APIのテスト
node e2e.mjs                   # ブラウザでの通しテスト（スクリーンショットも出る）
```

`e2e.mjs` は Worker をNodeのHTTPサーバーとして起動し、`API_BASE` をローカルに差し替えて配信するので、
Cloudflareにデプロイしなくても一連の動作を確認できる。

実際のWorkerをローカルで動かす場合は `cd worker && wrangler dev`。

---

## API

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/paste` | `{c, iv, s, ttl, burn}` を保存し `{id, ttl, expiresAt}` を返す |
| GET | `/api/paste/:id` | `{c, iv, s, burn}` を返す。burn指定なら同時に削除 |
| GET | `/health` | `{ok:true}` |

`c` は暗号文、`iv` は初期化ベクトル、`s` は鍵導出用のsalt（すべてbase64url）。
サーバーは中身を解釈しないし、合言葉も鍵も受け取らない。

IDは5文字。紛らわしい文字（0,1,I,O,l,o）を除いた56文字種なので、約5.5億通り。
衝突時は3回まで引き直す。

---

## 無料枠について

Cloudflare の無料枠は Workers 10万リクエスト/日、KV 読み取り10万・書き込み1000/日。
個人やチームでの利用ならまず超えない。書き込み（＝URL作成）が1日1000回が実質の上限。

より多く捌くなら D1 に差し替える手がある（書き込み10万/日）。ただしD1にはTTLがないので、
有効期限は自前で持ってCron Triggerで掃除する必要がある。

## 注意点

- **合言葉を無くすと復号できない。** サーバーは鍵を持っていないので復旧手段はない。
- 自動生成された合言葉は約59ビットあるので総当たりは現実的でないが、
  自分で短い合言葉に変えると弱くなる。URLを入手した攻撃者は暗号文を持ち帰って
  オフラインで試せるため、サーバー側のレート制限では守れない。
- ブラウザの履歴にはURLが残る。合言葉は残らない。
- 作成側にレート制限をかけていないので、URLを公開範囲に置くなら Cloudflare の
  Rate Limiting か Turnstile を足すのが無難。

## ライセンス

`site/qrcode.min.js` は MIT (c) 2009 Kazuhiko Arase。それ以外は好きに使ってよい。
