(() => {
  const WORKER_ENDPOINT = 'https://sptracking-fetcher-probe.ekqtjl.workers.dev/api/browser-capture';
  const EVENT_TYPE = 'SPTRACKING_SHOPEE_ITEM';
  let lastKey = null;
  let domTimer = null;

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

    await submitCapture({
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
    });
  });

  function scheduleDomCapture(delay = 1200) {
    clearTimeout(domTimer);
    domTimer = setTimeout(captureFromDom, delay);
  }

  async function captureFromDom() {
    const ids = parseShopeeUrl(location.href);
    if (!ids.shopId || !ids.itemId || !ids.modelId) return;

    const productName = firstText([
      'h1',
      '[data-testid="pdp-product-title"]',
      '[class*="product-title"]'
    ]);

    const priceText = findPriceText();
    const variationName = findSelectedVariationText();
    const price = parseDisplayedPrice(priceText);

    if (!productName || !variationName || price === null) {
      await chrome.storage.local.set({
        latest_capture_status: {
          state: 'waiting_dom',
          error: `DOM fallback ยังหาไม่ครบ: name=${!!productName}, variation=${!!variationName}, price=${price !== null}`,
          at: new Date().toISOString()
        }
      });
      return;
    }

    await submitCapture({
      shop_id: ids.shopId,
      item_id: ids.itemId,
      model_id: ids.modelId,
      product_name: productName,
      variation_name: variationName,
      price,
      original_price: null,
      stock: null,
      source_url: location.href,
      transport: 'dom',
      captured_at_client: new Date().toISOString()
    });
  }

  async function submitCapture(capture) {
    if (!capture || capture.price === null || !capture.model_id) return;

    const dedupeKey = `${capture.shop_id}:${capture.item_id}:${capture.model_id}:${capture.price}:${capture.variation_name ?? ''}`;
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
  }

  function parseShopeeUrl(rawUrl) {
    const url = new URL(rawUrl);
    const match = url.pathname.match(/-i\.(\d+)\.(\d+)/);
    const shopId = match?.[1] || null;
    const itemId = match?.[2] || null;
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

  function firstText(selectors) {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = el?.textContent?.trim();
      if (text) return text;
    }
    return null;
  }

  function findPriceText() {
    const selectors = [
      '[data-testid="pdp-product-price"]',
      '[class*="product-price"]',
      '[class*="price"]'
    ];
    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)];
      for (const node of nodes) {
        const text = node.textContent?.trim() || '';
        if (/฿\s*[\d,.]+/.test(text)) return text;
      }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue?.trim() || '';
      if (/^฿\s*[\d,.]+$/.test(text)) return text;
    }
    return null;
  }

  function findSelectedVariationText() {
    const candidates = [...document.querySelectorAll('button, [role="button"], div')];
    const scored = [];

    for (const el of candidates) {
      const text = compactText(el.textContent);
      if (!text || text.length > 100) continue;
      if (/^฿\s*[\d,.]+$/.test(text) || /\bprice\b/i.test(text)) continue;
      if (/^(add to cart|buy now|variation|quantity)$/i.test(text)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 20 || rect.width > 500 || rect.height > 100) continue;

      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) continue;

      let score = 0;
      const ariaPressed = el.getAttribute('aria-pressed');
      const ariaChecked = el.getAttribute('aria-checked');
      const cls = String(el.className || '').toLowerCase();
      const borderColor = style.borderColor || '';
      const color = style.color || '';

      if (ariaPressed === 'true' || ariaChecked === 'true') score += 12;
      if (/selected|active|chosen|choosed/.test(cls)) score += 8;
      if (/rgb\(238,\s*77,\s*45\)/.test(borderColor) || /rgb\(255,\s*87,\s*34\)/.test(borderColor)) score += 7;
      if (/rgb\(238,\s*77,\s*45\)/.test(color) || /rgb\(255,\s*87,\s*34\)/.test(color)) score += 2;
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') score += 3;
      if (el.querySelector('img')) score += 2;
      if (/\d/.test(text)) score += 1;
      if (text.includes('x4') || text.includes('ชิ้น') || text.includes('ชาย') || text.includes('หญิง')) score += 3;

      if (score >= 7) scored.push({ text, score, area: rect.width * rect.height });
    }

    scored.sort((a, b) => b.score - a.score || a.area - b.area || a.text.length - b.text.length);
    return scored[0]?.text || null;
  }

  function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function parseDisplayedPrice(value) {
    if (!value) return null;
    const match = String(value).replace(/\s+/g, ' ').match(/฿\s*([\d,.]+)/);
    if (!match) return null;
    const n = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
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

  scheduleDomCapture(1800);
  addEventListener('load', () => scheduleDomCapture(1200), { once: true });
  const observer = new MutationObserver(() => scheduleDomCapture(800));
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
})();
