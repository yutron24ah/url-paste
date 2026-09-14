/**
 * URL Paste — Cloudflare Worker API
 *
 * POST /api/paste      本文を保存して短いIDを返す
 * GET  /api/paste/:id  IDから本文を取得する
 * GET  /health         疎通確認
 *
 * サーバーは暗号化済みの不透明なデータしか受け取らない。
 * 復号鍵は合言葉から利用者のブラウザ内で導出される。合言葉はサーバーに届かない。
 * saltは秘密ではないのでレコードと一緒に保存する。
 */

const ID_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'; // 紛らわしい文字(0,1,I,O,l,o)を除外
const ID_LENGTH = 5; // 56^5 ≈ 5.5億通り
const MAX_BODY_BYTES = 256 * 1024; // 256KB
const ALLOWED_TTL = new Set([3600, 86400, 604800, 2592000]); // 1時間 / 1日 / 7日 / 30日
const DEFAULT_TTL = 604800;

function makeId() {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowList = (env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let allow = '';
  if (allowList.includes('*')) allow = '*';
  else if (allowList.includes(origin)) allow = origin;

  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
    },
  });
}

function isB64(s, maxLen) {
  return typeof s === 'string' && s.length > 0 && s.length <= maxLen && /^[A-Za-z0-9+/=_-]+$/.test(s);
}

async function handleCreate(request, env) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: 'too_large', message: 'テキストが大きすぎます（上限256KB）' }, 413, request, env);
  }

  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return json({ error: 'too_large', message: 'テキストが大きすぎます（上限256KB）' }, 413, request, env);
    }
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'bad_json' }, 400, request, env);
  }

  const { c, iv, s, burn } = body || {};
  if (!isB64(c, MAX_BODY_BYTES) || !isB64(iv, 64) || !isB64(s, 64)) {
    return json({ error: 'bad_request', message: 'c / iv / s が不正です' }, 400, request, env);
  }

  let ttl = Number(body.ttl);
  if (!ALLOWED_TTL.has(ttl)) ttl = DEFAULT_TTL;

  // ID衝突をチェック（実質起こらないが念のため3回まで）
  let id = null;
  for (let i = 0; i < 3; i++) {
    const candidate = makeId();
    const existing = await env.PASTES.get(candidate);
    if (existing === null) {
      id = candidate;
      break;
    }
  }
  if (!id) return json({ error: 'id_conflict' }, 503, request, env);

  const record = JSON.stringify({ c, iv, s, burn: burn === true, createdAt: Date.now() });
  await env.PASTES.put(id, record, { expirationTtl: ttl });

  return json({ id, ttl, expiresAt: Date.now() + ttl * 1000 }, 201, request, env);
}

async function handleRead(id, request, env) {
  if (!/^[0-9A-Za-z]{4,32}$/.test(id)) {
    return json({ error: 'not_found' }, 404, request, env);
  }

  const raw = await env.PASTES.get(id);
  if (raw === null) {
    return json({ error: 'not_found', message: '見つかりません（期限切れか削除済み）' }, 404, request, env);
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return json({ error: 'corrupt' }, 500, request, env);
  }

  // 一回読んだら消す設定なら削除
  if (record.burn) {
    await env.PASTES.delete(id);
  }

  return json({ c: record.c, iv: record.iv, s: record.s, burn: !!record.burn }, 200, request, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (path === '/health') {
      return json({ ok: true }, 200, request, env);
    }

    if (path === '/api/paste' && request.method === 'POST') {
      return handleCreate(request, env);
    }

    const m = path.match(/^\/api\/paste\/([^/]+)$/);
    if (m && request.method === 'GET') {
      return handleRead(decodeURIComponent(m[1]), request, env);
    }

    return json({ error: 'not_found' }, 404, request, env);
  },
};
