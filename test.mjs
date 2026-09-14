import worker from './worker/src/index.js';
import assert from 'node:assert';

/* ---- KVのモック（expirationTtlも再現） ---- */
class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) {
    const e = this.store.get(k);
    if (!e) return null;
    if (e.exp && Date.now() > e.exp) { this.store.delete(k); return null; }
    return e.v;
  }
  async put(k, v, opts = {}) {
    this.store.set(k, { v, exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null });
  }
  async delete(k) { this.store.delete(k); }
}

const ORIGIN = 'https://tester.github.io';
const env = { PASTES: new MockKV(), ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8000` };

const call = (path, init = {}) =>
  worker.fetch(new Request('https://api.test' + path, {
    ...init,
    headers: { Origin: ORIGIN, ...(init.headers || {}) },
  }), env);

/* ---- ブラウザ側と同じ暗号ロジック ---- */
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

async function encrypt(text) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return { c: b64u(ct), iv: b64u(iv), k: b64u(await crypto.subtle.exportKey('raw', key)) };
}
async function decrypt(c, iv, k) {
  const key = await crypto.subtle.importKey('raw', unb64u(k), { name: 'AES-GCM' }, false, ['decrypt']);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, key, unb64u(c)));
}

let pass = 0;
const ok = (name) => { console.log('  ✓ ' + name); pass++; };

/* ============ 1. 往復 ============ */
{
  const original = 'こんにちは 世界\n<script>alert(1)</script>\ntab\tあり 🍣 emoji';
  const enc = await encrypt(original);
  const res = await call('/api/paste', { method: 'POST', body: JSON.stringify({ ...enc, ttl: 86400 }) });
  assert.strictEqual(res.status, 201);
  const { id, expiresAt } = await res.json();
  assert.match(id, /^[0-9A-Za-z]{8}$/);
  assert.ok(expiresAt > Date.now());
  ok('保存してIDが返る: ' + id);

  const r2 = await call('/api/paste/' + id);
  assert.strictEqual(r2.status, 200);
  const got = await r2.json();
  assert.strictEqual(await decrypt(got.c, got.iv, enc.k), original);
  ok('取得して復号すると元のテキストと一致（日本語・絵文字・記号）');

  // サーバーには平文が一切ない
  const rawStored = await env.PASTES.get(id);
  assert.ok(!rawStored.includes('こんにちは'));
  ok('KVに平文が保存されていない');

  // 鍵が違えば復号できない
  const wrong = b64u(crypto.getRandomValues(new Uint8Array(32)));
  await assert.rejects(() => decrypt(got.c, got.iv, wrong));
  ok('鍵が違うと復号に失敗する');

  // URLの形とQR
  const url = `https://tester.github.io/urlpaste/#${id}.${enc.k}`;
  assert.ok(url.length < 120);
  ok(`生成URLの長さ ${url.length} 文字`);
  const { default: qrcode } = await import('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  assert.ok(qr.createSvgTag({ cellSize: 4, margin: 0 }).startsWith('<svg'));
  ok('QRコード(SVG)が生成できる — バージョン ' + qr.getModuleCount());
}

/* ============ 2. 一回読んだら消える ============ */
{
  const enc = await encrypt('burn after reading');
  const { id } = await (await call('/api/paste', { method: 'POST', body: JSON.stringify({ ...enc, burn: true }) })).json();
  const first = await call('/api/paste/' + id);
  assert.strictEqual(first.status, 200);
  assert.strictEqual((await first.json()).burn, true);
  const second = await call('/api/paste/' + id);
  assert.strictEqual(second.status, 404);
  ok('burn指定は1回目200 / 2回目404');
}

/* ============ 3. 有効期限 ============ */
{
  const enc = await encrypt('expires');
  const { ttl } = await (await call('/api/paste', { method: 'POST', body: JSON.stringify({ ...enc, ttl: 999 }) })).json();
  assert.strictEqual(ttl, 604800);
  ok('不正なttlは既定値(7日)にフォールバックする');

  const r = await (await call('/api/paste', { method: 'POST', body: JSON.stringify({ ...enc, ttl: 3600 }) })).json();
  const entry = env.PASTES.store.get(r.id);
  assert.ok(entry.exp - Date.now() > 3599000 && entry.exp - Date.now() <= 3600000);
  ok('ttl=3600 がKVのTTLに反映される');
}

/* ============ 4. 入力検証・エラー ============ */
{
  assert.strictEqual((await call('/api/paste/存在しないID')).status, 404);
  ok('未知のIDは404');
  assert.strictEqual((await call('/api/paste', { method: 'POST', body: 'not json' })).status, 400);
  ok('壊れたJSONは400');
  assert.strictEqual((await call('/api/paste', { method: 'POST', body: JSON.stringify({ c: 'ok', iv: '' }) })).status, 400);
  ok('ivが空なら400');
  assert.strictEqual((await call('/api/paste', { method: 'POST', body: JSON.stringify({ c: '<script>', iv: 'aaaa' }) })).status, 400);
  ok('base64以外の文字が混ざると400');
  const big = 'A'.repeat(300 * 1024);
  assert.strictEqual((await call('/api/paste', { method: 'POST', body: JSON.stringify({ c: big, iv: 'aaaa' }) })).status, 413);
  ok('256KB超は413');
  assert.strictEqual((await call('/api/paste')).status, 404);
  ok('GET /api/paste（POST用パス）は404');
}

/* ============ 5. CORS ============ */
{
  const pre = await call('/api/paste', { method: 'OPTIONS' });
  assert.strictEqual(pre.status, 204);
  assert.strictEqual(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  ok('許可オリジンのプリフライトにCORSヘッダーが付く');

  const bad = await worker.fetch(
    new Request('https://api.test/api/paste', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env);
  assert.strictEqual(bad.headers.get('Access-Control-Allow-Origin'), null);
  ok('未許可オリジンにはAllow-Originを返さない');

  const h = await call('/health');
  assert.strictEqual((await h.json()).ok, true);
  ok('/health が200を返す');
}

/* ============ 6. ID衝突の扱い ============ */
{
  const realGet = env.PASTES.get.bind(env.PASTES);
  env.PASTES.get = async () => 'occupied';           // 常に衝突する状況を作る
  const enc = await encrypt('x');
  const res = await call('/api/paste', { method: 'POST', body: JSON.stringify(enc) });
  assert.strictEqual(res.status, 503);
  env.PASTES.get = realGet;
  ok('IDが3回とも衝突したら503（無限ループしない）');
}

/* ============ 7. 大きめの本文 ============ */
{
  const long = 'あ'.repeat(30000);                    // UTF-8で約90KB
  const enc = await encrypt(long);
  const res = await call('/api/paste', { method: 'POST', body: JSON.stringify(enc) });
  assert.strictEqual(res.status, 201);
  const { id } = await res.json();
  const got = await (await call('/api/paste/' + id)).json();
  assert.strictEqual(await decrypt(got.c, got.iv, enc.k), long);
  ok('3万文字(約90KB)の往復が通る');
}

console.log(`\n${pass} 件すべて成功\n`);
