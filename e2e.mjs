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
  viewport: { width: 860, height: 980 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await ctx.newPage();
const errors = [];
const watch = (p) => {
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
};
watch(page);

const SAMPLE = `# デプロイ手順メモ
1. wrangler kv namespace create PASTES
2. wrangler deploy

const greeting = "こんにちは 🍣";
console.log(greeting);  // tab\tと記号 <>&"' も壊れないこと`;

const ok = (m) => console.log('  ✓ ' + m);

const open = async (target, context = ctx) => {
  const p = await context.newPage();
  watch(p);
  await p.goto(target);
  return p;
};

/* ---- 合言葉 ---- */
await page.goto(SITE_ORIGIN + '/');
const pass1 = await page.inputValue('#pass');
assert.match(pass1, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
ok('合言葉が自動生成される: ' + pass1);
await page.click('#regen');
const pass2 = await page.inputValue('#pass');
assert.notStrictEqual(pass1, pass2);
ok('「生成」で別の合言葉になる');

assert.strictEqual(await page.isDisabled('#create'), true);
ok('本文が空のうちは作成ボタンが押せない');

/* ---- 作成 ---- */
await page.fill('#text', SAMPLE);
await page.click('#create');
await page.waitForSelector('#result:not(.hidden)', { timeout: 15000 });
const url = await page.inputValue('#resultUrl');
const PASS = await page.inputValue('#resultPass');
assert.strictEqual(PASS, pass2);
assert.match(url, new RegExp(`^${SITE_ORIGIN}/#[0-9A-Za-z]{5}$`));
ok(`URLが生成された（ハッシュ部5文字・全${url.length}文字）: ${url.replace(SITE_ORIGIN, '…')}`);
assert.ok(await page.locator('#qr svg').count(), 'QRのSVGがない');
ok('QRコードが描画された');

/* ---- コピー（通常経路） ---- */
await page.click('#copyUrl');
await page.waitForTimeout(250);
assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), url);
ok('URLのコピーボタンが動く');
await page.click('#copyPass');
await page.waitForTimeout(250);
assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), PASS);
ok('合言葉のコピーボタンが動く');
await page.click('#copyBoth');
await page.waitForTimeout(250);
assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), url + '\n合言葉: ' + PASS);
ok('「両方まとめてコピー」が動く');
await page.screenshot({ path: 'shot-create.png' });

/* ---- コピー（クリップボードAPIが使えない環境） ---- */
{
  const blocked = await browser.newContext({ viewport: { width: 860, height: 980 } });
  await blocked.addInitScript(() => {
    // アプリ内ブラウザやiframeで拒否される状況を再現する
    Object.defineProperty(navigator, 'clipboard', {
      get: () => ({ writeText: () => Promise.reject(new Error('NotAllowedError')) }),
    });
  });
  const p = await open(SITE_ORIGIN + '/', blocked);
  await p.fill('#text', 'clipboard fallback test');
  await p.click('#create');
  await p.waitForSelector('#result:not(.hidden)', { timeout: 15000 });
  await p.click('#copyUrl');
  await p.waitForTimeout(300);
  const label = await p.textContent('#copyUrl');
  assert.notStrictEqual(label, 'コピーできません');
  assert.ok(label === 'コピーしました' || label === '選択しました→⌘C', '予期しない表示: ' + label);
  ok('クリップボードAPIが拒否されてもフォールバックする（表示: ' + label + '）');
  const selected = await p.evaluate(() => {
    const el = document.getElementById('resultUrl');
    return el.selectionStart === 0 && el.selectionEnd === el.value.length;
  });
  assert.ok(selected, 'フォールバック後にURLが選択状態になっていない');
  ok('フォールバック時はURLが選択状態になり手動コピーできる');
  await p.screenshot({ path: 'shot-fallback.png' });
  await blocked.close();
}

/* ---- 閲覧（合言葉あり） ---- */
const ctx2 = await browser.newContext({ viewport: { width: 860, height: 980 }, permissions: ['clipboard-read', 'clipboard-write'] });
{
  const p = await open(url, ctx2);
  await p.waitForSelector('#unlock:not(.hidden)', { timeout: 15000 });
  assert.strictEqual(await p.locator('#viewer').getAttribute('class').then((c) => c.includes('hidden')), true);
  ok('URLだけでは本文が出ず、合言葉の入力を求められる');
  await p.screenshot({ path: 'shot-unlock.png' });

  await p.fill('#unlockPass', 'wrong-pass-here');
  await p.click('#unlockBtn');
  await p.waitForSelector('#unlockError:not(.hidden)', { timeout: 15000 });
  assert.ok((await p.textContent('#unlockErrorText')).includes('合言葉が違います'));
  ok('間違った合言葉ではエラーになり、本文は出ない');

  await p.fill('#unlockPass', PASS);
  await p.click('#unlockBtn');
  await p.waitForSelector('#viewer:not(.hidden)', { timeout: 15000 });
  assert.strictEqual(await p.textContent('#viewText'), SAMPLE);
  ok('正しい合言葉で本文が完全一致で読める');

  await p.click('#copyText');
  await p.waitForTimeout(250);
  assert.strictEqual(await p.evaluate(() => navigator.clipboard.readText()), SAMPLE);
  ok('閲覧側の本文コピーも動く');
  await p.screenshot({ path: 'shot-view.png' });
  await p.close();
}

/* ---- Enterキーで開ける ---- */
{
  const p = await open(url, ctx2);
  await p.waitForSelector('#unlock:not(.hidden)', { timeout: 15000 });
  await p.fill('#unlockPass', PASS);
  await p.press('#unlockPass', 'Enter');
  await p.waitForSelector('#viewer:not(.hidden)', { timeout: 15000 });
  ok('合言葉欄でEnterを押しても開ける');
  await p.close();
}

/* ---- 存在しないID ---- */
{
  const p = await open(SITE_ORIGIN + '/#zzzzz', ctx2);
  await p.waitForSelector('#viewerError:not(.hidden)', { timeout: 15000 });
  assert.ok((await p.textContent('#viewerErrorText')).includes('見つかりません'));
  ok('存在しないIDは「見つかりません」表示');
  await p.close();
}

/* ---- 同じタブでハッシュだけ変えた場合 ---- */
{
  const p = await open(SITE_ORIGIN + '/', ctx2);
  await p.evaluate((u) => { location.hash = u.split('#')[1]; }, url);
  await p.waitForSelector('#unlock:not(.hidden)', { timeout: 15000 });
  ok('同じタブでハッシュだけ変えても読み直される');
  await p.close();
}

/* ---- 一回読んだら消す ---- */
await page.goto(SITE_ORIGIN + '/');
await page.fill('#text', 'burn test');
const burnPass = await page.inputValue('#pass');
await page.check('#burn');
await page.click('#create');
await page.waitForSelector('#result:not(.hidden)', { timeout: 15000 });
const burnUrl = await page.inputValue('#resultUrl');
{
  const p = await open(burnUrl, ctx2);
  await p.waitForSelector('#unlock:not(.hidden)', { timeout: 15000 });
  await p.fill('#unlockPass', burnPass);
  await p.click('#unlockBtn');
  await p.waitForSelector('#viewer:not(.hidden)', { timeout: 15000 });
  assert.strictEqual(await p.textContent('#viewText'), 'burn test');
  assert.ok(!(await p.locator('#burnNotice').getAttribute('class')).includes('hidden'));
  ok('burn: 1回目は本文が読めて警告が出る');
  await p.close();
}
{
  const p = await open(burnUrl, ctx2);
  await p.waitForSelector('#viewerError:not(.hidden)', { timeout: 15000 });
  ok('burn: 2回目は読めない');
  await p.close();
}

/* ---- モバイル幅 ---- */
{
  const mob = await ctx2.newPage();
  watch(mob);
  await mob.setViewportSize({ width: 390, height: 844 });
  await mob.goto(SITE_ORIGIN + '/');
  await mob.fill('#text', SAMPLE);
  const overflow = await mob.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.strictEqual(overflow, false, '横スクロールが発生している');
  ok('スマホ幅(390px)で横スクロールが出ない');
  await mob.screenshot({ path: 'shot-mobile.png' });
}

/* ---- ダークモード ---- */
{
  const dark = await browser.newContext({ colorScheme: 'dark', viewport: { width: 860, height: 820 } });
  const pd = await dark.newPage();
  watch(pd);
  await pd.goto(SITE_ORIGIN + '/');
  await pd.fill('#text', SAMPLE);
  await pd.screenshot({ path: 'shot-dark.png' });
  ok('ダークモードで描画できる');
}

assert.deepStrictEqual(errors, [], 'JSエラー: ' + errors.join(' | '));
ok('コンソールエラー・未捕捉例外なし');

await browser.close();
apiServer.close(); siteServer.close();
console.log('\nブラウザ実機テスト 全項目成功\n');
