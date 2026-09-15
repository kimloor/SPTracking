(() => {
  const WORKER_ENDPOINT = 'https://sptracking-fetcher-probe.ekqtjl.workers.dev/api/browser-capture';
  const EVENT_TYPE = 'SPTRACKING_SHOPEE_ITEM';
  let lastKey = null;

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== EVENT_TYPE) return;

    const payload = event.data.payload;
    const item = payload?.data || payload?.item || null;
    if (!item || !Array.isArray(item.models)) return;

    const ids = parseShopeeUrl(location.href);
    if (!ids.shopId || !ids.itemId) return;

    const requestedModelId = ids.modelId;
    let model = null;
    if (requestedModelId) {
      model = item.models.find((m) => String(m?.modelid ?? m?.model_id ?? '') === requestedModelId) || null;
    }
    if (!model && item.models.length === 1) model = item.models[0];
    if (!model) return;

    const modelId = String(model?.modelid ?? model?.model_id ?? '');
    if (!modelId) return;

    const capture = {
      shop_id: ids.shopId,
      item_id: ids.itemId,
      model_id: modelId,
      product_name: item?.name ?? null,
      variation_name: model?.name ?? model?.tier_index?.join?.(' / ') ?? null,
      price: normalizeShopeePrice(model?.price ?? item?.price),
      original_price: normalizeShopeePrice(model?.price_before_discount ?? item?.price_before_discount),
      stock: normalizeStock(model?.stock),
      source_url: location.href,
      transport: event.data.transport ?? null,
      captured_at_client: new Date().toISOString()
    };

    if (capture.price === null) return;

    const dedupeKey = `${capture.shop_id}:${capture.item_id}:${capture.model_id}:${capture.price}:${capture.stock ?? ''}`;
    if (dedupeKey === lastKey) return;
    lastKey = dedupeKey;

    await chrome.storage.local.set({
      latest_capture: capture,
      latest_capture_status: { state: 'sending', at: new Date().toISOString() }
    });

    try {
      const response = await fetch(WORKER_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(capture)
      });
      const result = await response.json().catch(() => null);
      await chrome.storage.local.set({
        latest_capture: result?.capture || capture,
        latest_capture_status: {
          state: response.ok && result?.ok ? 'accepted' : 'failed',
          http_status: response.status,
          error: result?.error ?? null,
          at: new Date().toISOString()
        }
      });
    } catch (error) {
      await chrome.storage.local.set({
        latest_capture_status: {
          state: 'failed',
          error: String(error),
          at: new Date().toISOString()
        }
      });
    }
  });

  function parseShopeeUrl(rawUrl) {
    const url = new URL(rawUrl);
    const match = url.pathname.match(/-i\.(\d+)\.(\d+)/);
    let shopId = match?.[1] || null;
    let itemId = match?.[2] || null;
    let modelId = url.searchParams.get('modelid') || url.searchParams.get('model_id') || null;

    const extraParams = url.searchParams.get('extraParams');
    if (extraParams) {
      try {
        const parsed = JSON.parse(extraParams);
        modelId = String(parsed?.display_model_id ?? parsed?.modelid ?? modelId ?? '') || null;
      } catch (_) {}
    }

    return { shopId, itemId, modelId };
  }

  function normalizeShopeePrice(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    if (n >= 100000) return Math.round((n / 100000) * 100) / 100;
    return Math.round(n * 100) / 100;
  }

  function normalizeStock(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }
})();
