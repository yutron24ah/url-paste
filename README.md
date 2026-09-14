# URL Paste

テキストを貼ると短いURLができて、そのURLを開くと読める。
フロントは GitHub Pages、保存は Cloudflare Workers + KV。

```
https://<ユーザー名>.github.io/url-paste/#n64bQ5sn.XGaRzsAVjpSkbFhfPjgh0ULz4wNA3DG7nDXOLGkC5I8
                                        ~~~~~~~~ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
                                        保存ID    復号鍵（サーバーには送られない）
```

本文はブラウザ内で AES-GCM 256bit で暗号化してから送信する。鍵はURLの `#` より後ろにだけ入り、
ブラウザはハッシュ部分をサーバーに送らないので、Cloudflare 側には**復号できない暗号文しか残らない**。
URLを知っている人だけが読める、という状態になる。

---

## 構成

```
site/            GitHub Pages に置くもの
  index.html       画面とロジック全部（1ファイル）
  qrcode.min.js    QRコード生成 (MIT / kazuhikoarase)
worker/          Cloudflare Workers に置くもの
  src/index.js     API本体
  wrangler.toml    設定
test.mjs         APIのユニットテスト（20項目）
e2e.mjs          Chromiumでの実動作テスト（15項目）
```

## 機能

- テキスト → 短いURL生成
- URLのコピーボタン / QRコード（スマホへの受け渡し用）
- 有効期限: 1時間 / 1日 / 7日 / 30日（KVのTTLで自動削除）
- 「一回読んだら消す」オプション
- ダークモード対応、スマホ幅対応
- 上限: 10万文字（暗号化後256KBまで）

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
| POST | `/api/paste` | `{c, iv, ttl, burn}` を保存し `{id, ttl, expiresAt}` を返す |
| GET | `/api/paste/:id` | `{c, iv, burn}` を返す。burn指定なら同時に削除 |
| GET | `/health` | `{ok:true}` |

`c` は暗号文、`iv` は初期化ベクトル（どちらもbase64url）。サーバーは中身を解釈しない。

---

## 無料枠について

Cloudflare の無料枠は Workers 10万リクエスト/日、KV 読み取り10万・書き込み1000/日。
個人やチームでの利用ならまず超えない。書き込み（＝URL作成）が1日1000回が実質の上限。

## 注意点

- URLを知っている人は誰でも読める。パスワード保護はしていない。
- ブラウザの履歴には鍵を含むURLが残る。機密度が高いものは「一回読んだら消す」を使う。
- 作成側にレート制限をかけていないので、URLを公開範囲に置くなら Cloudflare の
  Rate Limiting か Turnstile を足すのが無難。

## ライセンス

`site/qrcode.min.js` は MIT (c) 2009 Kazuhiko Arase。それ以外は好きに使ってよい。
