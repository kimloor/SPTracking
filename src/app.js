import probe from './index.js';
import { persistCapture, getVariantHistory } from './storage.js';
import { renderHome } from './ui.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(renderHome(), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store'
        }
      });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonCors({ ok: true, service: 'sptracking', database: !!env?.DB });
    }

    if (url.pathname === '/api/lookup' && request.method === 'POST') {
      return handleLookup(request, env);
    }

    if (url.pathname === '/api/lookup' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

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

async function handleLookup(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonCors({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const parsed = parseShopeeUrl(body?.url);
  if (!parsed.ok) {
    return jsonCors({ ok: false, code: parsed.code, error: parsed.error }, 400);
  }

  if (!parsed.modelId) {
    return jsonCors({
      ok: false,
      code: 'MODEL_REQUIRED',
      error: 'Shopee URL does not include a selected model/variation'
    }, 400);
  }

  if (!env?.DB) {
    return jsonCors({ ok: false, error: 'D1 binding DB is not configured yet' }, 503);
  }

  try {
    const result = await getVariantHistory(env.DB, parsed.shopId, parsed.itemId, parsed.modelId, 500);
    if (!result) {
      return jsonCors({
        ok: false,
        code: 'NOT_TRACKED',
        error: 'This product variation has not been captured yet',
        identity: {
          shop_id: parsed.shopId,
          item_id: parsed.itemId,
          model_id: parsed.modelId
        }
      }, 404);
    }
    return jsonCors({ ok: true, canonical_url: parsed.canonicalUrl, ...result });
  } catch (error) {
    return jsonCors({ ok: false, error: 'Lookup failed', detail: String(error) }, 500);
  }
}

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

function parseShopeeUrl(raw) {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, code: 'INVALID_URL', error: 'Shopee URL is required' };
  }

  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: 'INVALID_URL', error: 'Invalid URL' };
  }

  if (!/(^|\.)shopee\.co\.th$/i.test(url.hostname)) {
    return { ok: false, code: 'INVALID_HOST', error: 'Only shopee.co.th URLs are supported' };
  }

  if (url.hostname.toLowerCase() === 's.shopee.co.th') {
    return {
      ok: false,
      code: 'SHORT_URL_UNSUPPORTED',
      error: 'Short Shopee URLs are not supported yet. Open the link first and copy the full product URL.'
    };
  }

  const match = url.pathname.match(/-i\.(\d+)\.(\d+)/);
  if (!match) {
    return { ok: false, code: 'PRODUCT_ID_NOT_FOUND', error: 'Could not find shop_id and item_id in URL' };
  }

  const shopId = match[1];
  const itemId = match[2];
  let modelId = url.searchParams.get('modelid') || url.searchParams.get('model_id') || null;

  const extraParams = url.searchParams.get('extraParams');
  if (extraParams) {
    try {
      const parsed = JSON.parse(extraParams);
      modelId = String(parsed?.display_model_id ?? parsed?.modelid ?? modelId ?? '') || null;
    } catch {}
  }

  if (modelId && !/^\d+$/.test(modelId)) modelId = null;

  return {
    ok: true,
    shopId,
    itemId,
    modelId,
    canonicalUrl: `https://shopee.co.th/-i.${shopId}.${itemId}`
  };
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
