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

/* ---- ブラウザ側と同じ暗号ロジック（合言葉 → PBKDF2 → AES-GCM） ---- */
const ITER = 600000;
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

async function deriveKey(pass, salt, usage) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, usage);
}
async function encrypt(text, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return { c: b64u(ct), iv: b64u(iv), s: b64u(salt) };
}
async function decrypt(c, iv, s, pass) {
  const key = await deriveKey(pass, unb64u(s), ['decrypt']);
  return new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, key, unb64u(c)));
}

let pass = 0;
const ok = (name) => { console.log('  ✓ ' + name); pass++; };
const PASS = 'k7mq-t3xv-9bnd';

/* ============ 1. 往復 ============ */
{
  const original = 'こんにちは 世界\n<script>alert(1)</script>\ntab\tあり 🍣 emoji';
  const enc = await encrypt(original, PASS);
  const res = await call('/api/paste', { method: 'POST', body: JSON.stringify({ ...enc, ttl: 86400 }) });
  assert.strictEqual(res.status, 201);
  const { id, expiresAt } = await res.json();
  assert.match(id, /^[0-9A-Za-z]{5}$/);
  assert.ok(expiresAt > Date.now());
  ok('保存してIDが返る（5文字）: ' + id);

  const r2 = await call('/api/paste/' + id);
  assert.strictEqual(r2.status, 200);
  const got = await r2.json();
  assert.ok(got.s, 'saltが返らない');
  assert.strictEqual(await decrypt(got.c, got.iv, got.s, PASS), original);
  ok('取得して復号すると元のテキストと一致（日本語・絵文字・記号）');

  const rawStored = await env.PASTES.get(id);
  assert.ok(!rawStored.includes('こんにちは'));
  assert.ok(!rawStored.includes(PASS), '合言葉がサーバーに保存されている');
  ok('KVに平文も合言葉も保存されていない');

  await assert.rejects(() => decrypt(got.c, got.iv, got.s, 'k7mq-t3xv-9bne'));
  ok('合言葉が1文字違うだけで復号に失敗する');

  const url = `https://tester.github.io/url-paste/#${id}`;
  ok(`生成URLの長さ ${url.length} 文字（ハッシュ部は ${id.length} 文字）`);

  const { default: qrcode } = await import('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  assert.ok(qr.createSvgTag({ cellSize: 4, margin: 0 }).startsWith('<svg'));
  ok('QRコード(SVG)が生成できる — ' + qr.getModuleCount() + '×' + qr.getModuleCount() + ' モジュール');
}

/* ============ 2. saltが毎回変わる ============ */
{
  const a = await encrypt('same text', PASS);
  const b = await encrypt('same text', PASS);
  assert.notStrictEqual(a.s, b.s);
  assert.notStrictEqual(a.c, b.c);
  ok('同じ本文・同じ合言葉でも毎回saltと暗号文が変わる');
}

/* ============ 3. 一回読んだら消える ============ */
{
  const enc = await encrypt('burn after reading', PASS);
  const { id } = await (await call('/api/paste', { method: 'POST', body: JSON.stringify({ ...enc, burn: true }) })).json();
  const first = await call('/api/paste/' + id);
  assert.strictEqual(first.status, 200);
  assert.strictEqual((await first.json()).burn, true);
  assert.strictEqual((await call('/api/paste/' + id)).status, 404);
  ok('burn指定は1回目200 / 2回目404');
}

/* ============ 4. 有効期限 ============ */
{
  const enc = await encrypt('expires', PASS);
  const { ttl } = await (await call('/api/paste', { method: 'POST', body: JSON.stringify({ ...enc, ttl: 999 }) })).json();
  assert.strictEqual(ttl, 604800);
  ok('不正なttlは既定値(7日)にフォールバックする');

  const r = await (await call('/api/paste', { method: 'POST', body: JSON.stringify({ ...enc, ttl: 3600 }) })).json();
  const entry = env.PASTES.store.get(r.id);
  assert.ok(entry.exp - Date.now() > 3599000 && entry.exp - Date.now() <= 3600000);
  ok('ttl=3600 がKVのTTLに反映される');
}

/* ============ 5. 入力検証・エラー ============ */
{
  const enc = await encrypt('x', PASS);
  assert.strictEqual((await call('/api/paste/存在しないID')).status, 404);
  ok('未知のIDは404');
  assert.strictEqual((await call('/api/paste', { method: 'POST', body: 'not json' })).status, 400);
  ok('壊れたJSONは400');
  assert.strictEqual((await call('/api/paste', { method: 'POST', body: JSON.stringify({ c: enc.c, iv: enc.iv }) })).status, 400);
  ok('saltが無いと400');
  assert.strictEqual((await call('/api/paste', { method: 'POST', body: JSON.stringify({ ...enc, iv: '' }) })).status, 400);
  ok('ivが空なら400');
  assert.strictEqual((await call('/api/paste', { method: 'POST', body: JSON.stringify({ ...enc, c: '<script>' }) })).status, 400);
  ok('base64以外の文字が混ざると400');
  const big = 'A'.repeat(300 * 1024);
  assert.strictEqual((await call('/api/paste', { method: 'POST', body: JSON.stringify({ ...enc, c: big }) })).status, 413);
  ok('256KB超は413');
  assert.strictEqual((await call('/api/paste')).status, 404);
  ok('GET /api/paste（POST用パス）は404');
}

/* ============ 6. CORS ============ */
{
  const pre = await call('/api/paste', { method: 'OPTIONS' });
  assert.strictEqual(pre.status, 204);
  assert.strictEqual(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  ok('許可オリジンのプリフライトにCORSヘッダーが付く');

  const bad = await worker.fetch(
    new Request('https://api.test/api/paste', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env);
  assert.strictEqual(bad.headers.get('Access-Control-Allow-Origin'), null);
  ok('未許可オリジンにはAllow-Originを返さない');

  assert.strictEqual((await (await call('/health')).json()).ok, true);
  ok('/health が200を返す');
}

/* ============ 7. ID衝突の扱い ============ */
{
  const realGet = env.PASTES.get.bind(env.PASTES);
  env.PASTES.get = async () => 'occupied';
  const enc = await encrypt('x', PASS);
  assert.strictEqual((await call('/api/paste', { method: 'POST', body: JSON.stringify(enc) })).status, 503);
  env.PASTES.get = realGet;
  ok('IDが3回とも衝突したら503（無限ループしない）');
}

/* ============ 8. 大きめの本文 ============ */
{
  const long = 'あ'.repeat(30000);
  const enc = await encrypt(long, PASS);
  const res = await call('/api/paste', { method: 'POST', body: JSON.stringify(enc) });
  assert.strictEqual(res.status, 201);
  const { id } = await res.json();
  const got = await (await call('/api/paste/' + id)).json();
  assert.strictEqual(await decrypt(got.c, got.iv, got.s, PASS), long);
  ok('3万文字(約90KB)の往復が通る');
}

/* ============ 9. 鍵導出のコスト ============ */
{
  const t = Date.now();
  await encrypt('timing', PASS);
  const ms = Date.now() - t;
  console.log(`  ✓ PBKDF2 ${ITER.toLocaleString()}回の導出に ${ms}ms（総当たり耐性のためのコスト）`);
  pass++;
}

console.log(`\n${pass} 件すべて成功\n`);
