import probe from './index.js';
import { persistCapture, getVariantHistory } from './storage.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/browser-capture' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === '/api/browser-capture' && request.method === 'POST') {
      return handleBrowserCapture(request, env);
    }

    const historyMatch = url.pathname.match(/^\/api\/history\/(\d+)\/(\d+)\/(\d+)$/);
    if (historyMatch && request.method === 'GET') {
      if (!env?.DB) {
        return jsonCors({ ok: false, error: 'D1 binding DB is not configured yet' }, 503);
      }
      const [, shopId, itemId, modelId] = historyMatch;
      try {
        const result = await getVariantHistory(env.DB, shopId, itemId, modelId, url.searchParams.get('limit'));
        if (!result) return jsonCors({ ok: false, error: 'Tracked variant not found' }, 404);
        return jsonCors({ ok: true, ...result });
      } catch (error) {
        return jsonCors({ ok: false, error: 'History query failed', detail: String(error) }, 500);
      }
    }

    return probe.fetch(request, env, ctx);
  }
};

async function handleBrowserCapture(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonCors({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const capture = normalizeCapture(body);
  if (!capture.ok) return jsonCors({ ok: false, error: capture.error }, 400);

  const accepted = {
    ...capture.value,
    captured_at: new Date().toISOString()
  };

  if (!env?.DB) {
    return jsonCors({
      ok: true,
      accepted: true,
      persisted: false,
      storage_status: 'D1_NOT_CONFIGURED',
      capture: accepted
    });
  }

  try {
    const stored = await persistCapture(env.DB, accepted);
    return jsonCors({
      ok: true,
      accepted: true,
      persisted: true,
      storage_status: 'SAVED',
      capture: { ...accepted, ...stored }
    });
  } catch (error) {
    return jsonCors({
      ok: false,
      accepted: true,
      persisted: false,
      storage_status: 'SAVE_FAILED',
      error: String(error),
      capture: accepted
    }, 500);
  }
}

function normalizeCapture(body) {
  const shopId = id(body?.shop_id ?? body?.shopid);
  const itemId = id(body?.item_id ?? body?.itemid);
  const modelId = id(body?.model_id ?? body?.modelid);
  const price = priceNumber(body?.price);
  if (!shopId || !itemId || !modelId) {
    return { ok: false, error: 'shop_id, item_id and model_id are required' };
  }
  if (price === null) return { ok: false, error: 'price is required and must be numeric' };

  return {
    ok: true,
    value: {
      shop_id: shopId,
      item_id: itemId,
      model_id: modelId,
      product_name: text(body?.product_name, 500),
      variation_name: text(body?.variation_name, 300),
      price,
      original_price: priceNumber(body?.original_price, true),
      stock: stockNumber(body?.stock),
      source_url: text(body?.source_url, 2000),
      transport: text(body?.transport, 50),
      captured_at_client: text(body?.captured_at_client, 100)
    }
  };
}

function id(value) {
  const s = value == null ? '' : String(value).trim();
  return /^\d+$/.test(s) ? s : null;
}

function priceNumber(value, optional = false) {
  if (value === null || value === undefined || value === '') return optional ? null : null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function stockNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function text(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store'
  };
}

function jsonCors(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() }
  });
}
