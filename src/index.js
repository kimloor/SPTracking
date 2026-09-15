const SHOPEE_ITEM_API = 'https://shopee.co.th/api/v4/item/get';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'sptracking-fetcher-probe' });
    }

    if (url.pathname === '/api/browser-capture' && request.method === 'POST') {
      return handleBrowserCapture(request);
    }

    if (url.pathname === '/api/browser-capture' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const shopid = url.searchParams.get('shopid');
    const itemid = url.searchParams.get('itemid');
    const modelid = url.searchParams.get('modelid');
    const mode = url.searchParams.get('mode') || 'api';

    if (!shopid || !itemid) {
      return json({
        ok: false,
        error: 'Missing shopid or itemid',
        usage: '/?mode=discover&shopid=50216086&itemid=845052410&modelid=1567087028'
      }, 400);
    }

    if (mode === 'page') return probeProductPage({ shopid, itemid, modelid });
    if (mode === 'discover') return discoverDynamicDataSource({ shopid, itemid, modelid });
    return probeItemApi({ shopid, itemid, modelid });
  }
};

async function handleBrowserCapture(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonCors({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const shopid = normalizeId(body?.shop_id ?? body?.shopid);
  const itemid = normalizeId(body?.item_id ?? body?.itemid);
  const modelid = normalizeId(body?.model_id ?? body?.modelid, true);
  const productName = cleanText(body?.product_name, 500);
  const variationName = cleanText(body?.variation_name, 300);
  const price = normalizePrice(body?.price);
  const originalPrice = normalizePrice(body?.original_price, true);
  const stock = normalizeStock(body?.stock);
  const sourceUrl = cleanText(body?.source_url, 2000);

  if (!shopid || !itemid || !modelid) {
    return jsonCors({ ok: false, error: 'shop_id, item_id and model_id are required' }, 400);
  }
  if (price === null) {
    return jsonCors({ ok: false, error: 'price is required and must be numeric' }, 400);
  }

  return jsonCors({
    ok: true,
    accepted: true,
    capture: {
      shop_id: shopid,
      item_id: itemid,
      model_id: modelid,
      product_name: productName,
      variation_name: variationName,
      price,
      original_price: originalPrice,
      stock,
      source_url: sourceUrl,
      captured_at: new Date().toISOString()
    }
  });
}

async function probeItemApi({ shopid, itemid, modelid }) {
  const target = `${SHOPEE_ITEM_API}?shopid=${encodeURIComponent(shopid)}&itemid=${encodeURIComponent(itemid)}`;
  try {
    const response = await fetch(target, { headers: browserHeaders('application/json,text/plain,*/*', false) });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 5000); }
    const models = Array.isArray(body?.data?.models) ? body.data.models : [];
    const selectedModel = modelid
      ? models.find((m) => String(m?.modelid ?? m?.model_id ?? '') === String(modelid)) ?? null
      : null;
    return json({
      probe: 'api', ok: response.ok, upstream_status: response.status,
      upstream_content_type: response.headers.get('content-type'),
      request: { shopid, itemid, modelid: modelid ?? null }, target,
      model_count: models.length, selected_model: selectedModel, body
    }, response.ok ? 200 : 502);
  } catch (error) {
    return json({ probe: 'api', ok: false, request: { shopid, itemid, modelid: modelid ?? null }, error: String(error) }, 500);
  }
}

async function probeProductPage({ shopid, itemid, modelid }) {
  const target = `https://shopee.co.th/-i.${encodeURIComponent(shopid)}.${encodeURIComponent(itemid)}`;
  try {
    const response = await fetch(target, {
      redirect: 'follow',
      headers: browserHeaders('text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', true)
    });
    const html = await response.text();
    const needles = ['modelid','model_id','models','price','stock','__NEXT_DATA__','application/ld+json',String(itemid),String(shopid)];
    if (modelid) needles.push(String(modelid));
    const markerHits = Object.fromEntries(needles.map((needle) => [needle, countOccurrences(html, needle)]));
    const selectedModelIndex = modelid ? html.indexOf(String(modelid)) : -1;
    const itemIndex = html.indexOf(String(itemid));
    const firstUsefulIndex = selectedModelIndex >= 0 ? selectedModelIndex : itemIndex;
    return json({
      probe: 'page', ok: response.ok, upstream_status: response.status,
      upstream_content_type: response.headers.get('content-type'), final_url: response.url,
      request: { shopid, itemid, modelid: modelid ?? null }, target,
      html_length: html.length, marker_hits: markerHits,
      selected_model_found: selectedModelIndex >= 0,
      sample: firstUsefulIndex >= 0 ? html.slice(Math.max(0, firstUsefulIndex - 600), firstUsefulIndex + 1400) : html.slice(0, 2000)
    }, response.ok ? 200 : 502);
  } catch (error) {
    return json({ probe: 'page', ok: false, request: { shopid, itemid, modelid: modelid ?? null }, error: String(error) }, 500);
  }
}

async function discoverDynamicDataSource({ shopid, itemid, modelid }) {
  const pageUrl = `https://shopee.co.th/-i.${encodeURIComponent(shopid)}.${encodeURIComponent(itemid)}`;
  try {
    const pageResponse = await fetch(pageUrl, {
      redirect: 'follow',
      headers: browserHeaders('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', true)
    });
    const html = await pageResponse.text();
    const assets = extractJavaScriptSources(html, pageResponse.url).filter((u) =>
      u.includes('deo.shopeemobile.com/shopee/') || u.includes('shopee.co.th/')
    );

    const prioritized = [...assets].sort((a, b) => scoreBundle(b) - scoreBundle(a));
    const candidates = prioritized.slice(0, 14);
    const needles = [
      '/api/v4/item/get', 'api/v4/item/get', '/api/v4/pdp/', 'pdp/get',
      'item_detail', 'item/get', 'shopid', 'itemid', 'modelid', 'models',
      'price_before_discount', 'price_min', 'price_max', 'stock', 'variation',
      'client_name', 'x-api-source', 'x-csrftoken', 'csrftoken', 'x-requested-with',
      'af-ac-enc-dat', 'SPC_CDS', 'SPC_EC', 'SPC_ST', 'referer', 'apm'
    ];

    const bundleResults = [];
    for (const scriptUrl of candidates) {
      try {
        const r = await fetch(scriptUrl, {
          headers: browserHeaders('application/javascript,text/javascript,*/*;q=0.8', false)
        });
        const text = await r.text();
        const hits = [];
        for (const needle of needles) {
          const idx = text.indexOf(needle);
          if (idx >= 0) {
            hits.push({
              needle,
              count: countOccurrences(text, needle),
              context: text.slice(Math.max(0, idx - 300), Math.min(text.length, idx + needle.length + 650))
            });
          }
        }
        bundleResults.push({
          url: scriptUrl,
          status: r.status,
          content_type: r.headers.get('content-type'),
          length: text.length,
          hits
        });
      } catch (error) {
        bundleResults.push({ url: scriptUrl, error: String(error), hits: [] });
      }
    }

    const interesting = bundleResults.filter((b) => b.hits?.length);
    return json({
      probe: 'discover',
      ok: pageResponse.ok,
      page_status: pageResponse.status,
      page_url: pageResponse.url,
      request: { shopid, itemid, modelid: modelid ?? null },
      asset_count: assets.length,
      scanned_count: candidates.length,
      interesting_count: interesting.length,
      interesting_bundles: interesting.slice(0, 8),
      scanned_urls: candidates
    });
  } catch (error) {
    return json({ probe: 'discover', ok: false, request: { shopid, itemid, modelid: modelid ?? null }, error: String(error) }, 500);
  }
}

function extractJavaScriptSources(html, baseUrl) {
  const out = [];
  const scriptRe = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = scriptRe.exec(html))) addUrl(out, match[1], baseUrl);

  const linkRe = /<link\b[^>]*>/gi;
  while ((match = linkRe.exec(html))) {
    const tag = match[0];
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1]?.toLowerCase() || '';
    const as = tag.match(/\bas=["']([^"']+)["']/i)?.[1]?.toLowerCase() || '';
    const isScriptPreload = rel.includes('modulepreload') || (rel.includes('preload') && as === 'script');
    if (isScriptPreload) addUrl(out, href, baseUrl);
  }
  return [...new Set(out)];
}

function addUrl(out, value, baseUrl) {
  try { out.push(new URL(value, baseUrl).toString()); } catch {}
}

function scoreBundle(url) {
  const s = url.toLowerCase();
  let score = 0;
  if (s.includes('product')) score += 10;
  if (s.includes('item')) score += 9;
  if (s.includes('pdp')) score += 9;
  if (s.includes('bundle')) score += 6;
  if (s.includes('entry')) score += 5;
  if (s.includes('module')) score += 4;
  if (s.includes('runtime')) score += 1;
  if (s.includes('polyfill')) score -= 20;
  return score;
}

function normalizeId(value, optional = false) {
  if (value === null || value === undefined || value === '') return optional ? null : '';
  const s = String(value).trim();
  return /^\d+$/.test(s) ? s : optional ? null : '';
}

function normalizePrice(value, optional = false) {
  if (value === null || value === undefined || value === '') return optional ? null : null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeStock(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function cleanText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function browserHeaders(accept, navigate) {
  const headers = {
    accept,
    'accept-language': 'th-TH,th;q=0.9,en;q=0.8',
    'cache-control': 'no-cache', pragma: 'no-cache',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
  };
  if (navigate) {
    headers['upgrade-insecure-requests'] = '1';
    headers['sec-fetch-dest'] = 'document';
    headers['sec-fetch-mode'] = 'navigate';
    headers['sec-fetch-site'] = 'none';
  }
  return headers;
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0, from = 0;
  while (true) {
    const index = text.indexOf(needle, from);
    if (index < 0) return count;
    count += 1;
    from = index + needle.length;
  }
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST,OPTIONS',
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
