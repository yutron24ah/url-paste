/* ブラウザでの実動作確認: ローカルにAPI+静的サーバーを立て、Chromiumで一連の操作を実行する */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { chromium } from 'playwright';
import worker from './worker/src/index.js';

const API_PORT = 8787, SITE_PORT = 8000;
const SITE_ORIGIN = `http://localhost:${SITE_PORT}`;

/* ---- KVモック ---- */
const store = new Map();
const env = {
  ALLOWED_ORIGINS: SITE_ORIGIN,
  PASTES: {
    async get(k) { const e = store.get(k); if (!e) return null; if (e.exp && Date.now() > e.exp) { store.delete(k); return null; } return e.v; },
    async put(k, v, o = {}) { store.set(k, { v, exp: o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : null }); },
    async delete(k) { store.delete(k); },
  },
};

/* ---- WorkerをNodeのhttpサーバーとして動かす ---- */
const apiServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request('http://localhost' + req.url, {
    method: req.method, headers: req.headers, body,
  }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});

/* ---- 静的サーバー（API_BASEをローカルに差し替えて配信） ---- */
const siteServer = http.createServer((req, res) => {
  const name = (req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]).replace(/^\/+/, '');
  const file = path.join('site', path.basename(name));
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('nf'); }
  let body = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.html')) {
    body = body.replace(/var API_BASE = '[^']*'/, `var API_BASE = 'http://localhost:${API_PORT}'`);
  }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript' });
  res.end(body);
});

await new Promise((r) => apiServer.listen(API_PORT, r));
await new Promise((r) => siteServer.listen(SITE_PORT, r));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({
  viewport: { width: 860, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// 404レスポンス自体はアプリが想定して処理しているので、ブラウザのネットワークログは除外する
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
});

const SAMPLE = `# デプロイ手順メモ
1. wrangler kv namespace create PASTES
2. wrangler deploy

const greeting = "こんにちは 🍣";
console.log(greeting);  // tab\tと記号 <>&"' も壊れないこと`;

const ok = (m) => console.log('  ✓ ' + m);

/* ---- 作成 ---- */
await page.goto(SITE_ORIGIN + '/');
await page.fill('#text', SAMPLE);
assert.ok((await page.textContent('#counter')).includes('文字'));
ok('文字数カウンターが動く');

await page.click('#create');
await page.waitForSelector('#result:not(.hidden)', { timeout: 10000 });
const url = await page.inputValue('#resultUrl');
assert.match(url, new RegExp(`^${SITE_ORIGIN}/#[0-9A-Za-z]{8}\\.[A-Za-z0-9_-]{43}$`));
ok('URLが生成された (' + url.length + '文字): ' + url.replace(SITE_ORIGIN, '…'));

assert.ok(await page.locator('#qr svg').count(), 'QRのSVGがない');
ok('QRコードが描画された');
assert.ok((await page.textContent('#resultMeta')).includes('有効期限'));
ok('有効期限が表示されている');

/* ---- コピーボタン ---- */
await page.click('#copyUrl');
await page.waitForTimeout(200);
assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), url);
assert.strictEqual(await page.textContent('#copyUrl'), 'コピーしました');
ok('コピーボタンでURLがクリップボードに入る');

await page.screenshot({ path: 'shot-create.png' });

/* ---- 別ブラウザ（別セッション）で閲覧 ---- */
const ctx2 = await browser.newContext({ viewport: { width: 860, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page2 = await ctx2.newPage();
page2.on('pageerror', (e) => errors.push(String(e)));
await page2.goto(url);
await page2.waitForSelector('#viewer:not(.hidden)', { timeout: 10000 });
assert.strictEqual(await page2.textContent('#viewText'), SAMPLE);
ok('別セッションでURLを開くと本文が完全一致で読める');
await page2.click('#copyText');
await page2.waitForTimeout(200);
assert.strictEqual(await page2.evaluate(() => navigator.clipboard.readText()), SAMPLE);
ok('閲覧側の本文コピーも動く');
await page2.screenshot({ path: 'shot-view.png' });

/* 毎回まっさらなタブで開く（実際にリンクを踏んだときと同じ状態にする） */
async function open(target) {
  const p = await ctx2.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(target);
  return p;
}

/* ---- 鍵が壊れたURL ---- */
{
  const p = await open(url.slice(0, -4) + 'AAAA');
  await p.waitForSelector('#viewerError:not(.hidden)', { timeout: 10000 });
  assert.ok((await p.textContent('#viewerErrorText')).includes('復号'));
  ok('鍵が壊れたURLはエラー表示になる');
  await p.close();
}

/* ---- 存在しないID ---- */
{
  const p = await open(SITE_ORIGIN + '/#zzzzzzzz.' + 'A'.repeat(43));
  await p.waitForSelector('#viewerError:not(.hidden)', { timeout: 10000 });
  assert.ok((await p.textContent('#viewerErrorText')).includes('見つかりません'));
  ok('存在しないIDは「見つかりません」表示');
  await p.close();
}

/* ---- 開いたままハッシュだけ差し替えられた場合 ---- */
{
  const p = await open(SITE_ORIGIN + '/');
  await p.evaluate((u) => { location.hash = u.split('#')[1]; }, url);
  await p.waitForSelector('#viewer:not(.hidden)', { timeout: 10000 });
  assert.strictEqual(await p.textContent('#viewText'), SAMPLE);
  ok('同じタブでハッシュだけ変えても読み直される');
  await p.close();
}

/* ---- 一回読んだら消す ---- */
await page.goto(SITE_ORIGIN + '/');
await page.fill('#text', 'burn test');
await page.check('#burn');
await page.click('#create');
await page.waitForSelector('#result:not(.hidden)');
const burnUrl = await page.inputValue('#resultUrl');
{
  const p = await open(burnUrl);
  await p.waitForSelector('#viewer:not(.hidden)', { timeout: 10000 });
  assert.strictEqual(await p.textContent('#viewText'), 'burn test');
  assert.ok(!(await p.locator('#burnNotice').getAttribute('class')).includes('hidden'));
  ok('burn: 1回目は本文が読めて警告が出る');
  await p.close();
}
{
  const p = await open(burnUrl);
  await p.waitForSelector('#viewerError:not(.hidden)', { timeout: 10000 });
  ok('burn: 2回目は読めない');
  await p.close();
}

/* ---- モバイル幅 ---- */
const mob = await ctx2.newPage();
await mob.setViewportSize({ width: 390, height: 844 });
await mob.goto(url);
await mob.waitForSelector('#viewer:not(.hidden)');
const overflow = await mob.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
assert.strictEqual(overflow, false, '横スクロールが発生している');
ok('スマホ幅(390px)で横スクロールが出ない');
await mob.screenshot({ path: 'shot-mobile.png' });

/* ---- ダークモード ---- */
const dark = await browser.newContext({ colorScheme: 'dark', viewport: { width: 860, height: 760 } });
const pd = await dark.newPage();
await pd.goto(SITE_ORIGIN + '/');
await pd.fill('#text', SAMPLE);
await pd.screenshot({ path: 'shot-dark.png' });
ok('ダークモードで描画できる');

assert.deepStrictEqual(errors, [], 'JSエラー: ' + errors.join(' | '));
ok('コンソールエラー・未捕捉例外なし');

await browser.close();
apiServer.close(); siteServer.close();
console.log('\nブラウザ実機テスト 全項目成功\n');
