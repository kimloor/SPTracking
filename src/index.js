const SHOPEE_ITEM_API = 'https://shopee.co.th/api/v4/item/get';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'sptracking-fetcher-probe' });
    }

    const shopid = url.searchParams.get('shopid');
    const itemid = url.searchParams.get('itemid');
    const modelid = url.searchParams.get('modelid');
    const mode = url.searchParams.get('mode') || 'api';

    if (!shopid || !itemid) {
      return json({
        ok: false,
        error: 'Missing shopid or itemid',
        usage: '/?mode=page&shopid=50216086&itemid=845052410&modelid=1567087028'
      }, 400);
    }

    if (mode === 'page') {
      return probeProductPage({ shopid, itemid, modelid });
    }

    return probeItemApi({ shopid, itemid, modelid });
  }
};

async function probeItemApi({ shopid, itemid, modelid }) {
  const target = `${SHOPEE_ITEM_API}?shopid=${encodeURIComponent(shopid)}&itemid=${encodeURIComponent(itemid)}`;

  try {
    const response = await fetch(target, {
      headers: browserHeaders('application/json,text/plain,*/*')
    });

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 5000);
    }

    const models = Array.isArray(body?.data?.models) ? body.data.models : [];
    const selectedModel = modelid
      ? models.find((m) => String(m?.modelid ?? m?.model_id ?? '') === String(modelid)) ?? null
      : null;

    return json({
      probe: 'api',
      ok: response.ok,
      upstream_status: response.status,
      upstream_content_type: response.headers.get('content-type'),
      request: { shopid, itemid, modelid: modelid ?? null },
      target,
      model_count: models.length,
      selected_model: selectedModel,
      body
    }, response.ok ? 200 : 502);
  } catch (error) {
    return json({
      probe: 'api',
      ok: false,
      request: { shopid, itemid, modelid: modelid ?? null },
      error: String(error)
    }, 500);
  }
}

async function probeProductPage({ shopid, itemid, modelid }) {
  // Shopee resolves the compact canonical item path even without a product slug.
  const target = `https://shopee.co.th/-i.${encodeURIComponent(shopid)}.${encodeURIComponent(itemid)}`;

  try {
    const response = await fetch(target, {
      redirect: 'follow',
      headers: browserHeaders('text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8')
    });

    const html = await response.text();
    const needles = [
      'modelid',
      'model_id',
      'models',
      'price',
      'stock',
      '__NEXT_DATA__',
      'application/ld+json',
      String(itemid),
      String(shopid)
    ];
    if (modelid) needles.push(String(modelid));

    const markerHits = {};
    for (const needle of needles) {
      markerHits[needle] = countOccurrences(html, needle);
    }

    const selectedModelIndex = modelid ? html.indexOf(String(modelid)) : -1;
    const itemIndex = html.indexOf(String(itemid));
    const firstUsefulIndex = selectedModelIndex >= 0 ? selectedModelIndex : itemIndex;

    return json({
      probe: 'page',
      ok: response.ok,
      upstream_status: response.status,
      upstream_content_type: response.headers.get('content-type'),
      final_url: response.url,
      request: { shopid, itemid, modelid: modelid ?? null },
      target,
      html_length: html.length,
      marker_hits: markerHits,
      selected_model_found: selectedModelIndex >= 0,
      sample: firstUsefulIndex >= 0
        ? html.slice(Math.max(0, firstUsefulIndex - 600), firstUsefulIndex + 1400)
        : html.slice(0, 2000)
    }, response.ok ? 200 : 502);
  } catch (error) {
    return json({
      probe: 'page',
      ok: false,
      request: { shopid, itemid, modelid: modelid ?? null },
      error: String(error)
    }, 500);
  }
}

function browserHeaders(accept) {
  return {
    accept,
    'accept-language': 'th-TH,th;q=0.9,en;q=0.8',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
  };
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const index = text.indexOf(needle, from);
    if (index < 0) return count;
    count += 1;
    from = index + needle.length;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
