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

    if (!shopid || !itemid) {
      return json({
        ok: false,
        error: 'Missing shopid or itemid',
        usage: '/?shopid=50216086&itemid=845052410&modelid=1567087028'
      }, 400);
    }

    const target = `${SHOPEE_ITEM_API}?shopid=${encodeURIComponent(shopid)}&itemid=${encodeURIComponent(itemid)}`;

    try {
      const response = await fetch(target, {
        headers: {
          accept: 'application/json,text/plain,*/*',
          'accept-language': 'th-TH,th;q=0.9,en;q=0.8',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36'
        }
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
        ok: false,
        request: { shopid, itemid, modelid: modelid ?? null },
        error: String(error)
      }, 500);
    }
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
