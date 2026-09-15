import { chromium } from 'playwright';

const SHOP_ID = '50216086';
const ITEM_ID = '845052410';
const MODEL_ID = '1567087028';
const extraParams = encodeURIComponent(JSON.stringify({ display_model_id: Number(MODEL_ID) }));
const PRODUCT_URL = `https://shopee.co.th/-i.${SHOP_ID}.${ITEM_ID}?extraParams=${extraParams}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'th-TH',
  timezoneId: 'Asia/Bangkok',
  viewport: { width: 1440, height: 1100 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
});
const page = await context.newPage();

let apiCapture = null;
page.on('response', async (response) => {
  if (!response.url().includes('/api/v4/item/get')) return;
  try {
    const body = await response.json();
    const item = body?.data || body?.item || null;
    if (!item || !Array.isArray(item.models)) return;
    const model = item.models.find((m) => String(m?.modelid ?? m?.model_id ?? '') === MODEL_ID);
    if (!model) return;
    apiCapture = {
      source: 'browser_api',
      product_name: item?.name ?? null,
      variation_name: model?.name ?? null,
      price: normalizeShopeePrice(model?.price ?? item?.price),
      original_price: normalizeShopeePrice(model?.price_before_discount ?? item?.price_before_discount),
      stock: normalizeStock(model?.stock),
      model_id: String(model?.modelid ?? model?.model_id ?? '')
    };
  } catch {}
});

let status = null;
try {
  const nav = await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  status = nav?.status() ?? null;
  await page.waitForTimeout(7000);

  let result = apiCapture;
  if (!result) {
    const productName = await textOf(page, ['h1', '[data-testid="pdp-product-title"]', '[class*="product-title"]']);
    const priceText = await findPriceText(page);
    const variationName = await findSelectedVariation(page);
    const price = parseDisplayedPrice(priceText);
    result = {
      source: 'dom',
      product_name: productName,
      variation_name: variationName,
      price,
      original_price: null,
      stock: null,
      model_id: MODEL_ID
    };
  }

  const out = {
    ok: Boolean(result?.product_name && result?.variation_name && Number.isFinite(result?.price) && result?.model_id === MODEL_ID),
    http_status: status,
    url: page.url(),
    title: await page.title(),
    result
  };

  console.log(JSON.stringify(out, null, 2));
  if (!out.ok) {
    await page.screenshot({ path: 'headless-poc-failure.png', fullPage: true });
    process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error), http_status: status, url: page.url() }, null, 2));
  try { await page.screenshot({ path: 'headless-poc-failure.png', fullPage: true }); } catch {}
  process.exitCode = 1;
} finally {
  await browser.close();
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

async function textOf(page, selectors) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if (await loc.count()) {
      const text = (await loc.textContent().catch(() => null))?.trim();
      if (text) return text;
    }
  }
  return null;
}

async function findPriceText(page) {
  const texts = await page.locator('body').innerText().catch(() => '');
  const matches = [...texts.matchAll(/฿\s*[\d,.]+/g)].map((m) => m[0]);
  return matches[0] ?? null;
}

async function findSelectedVariation(page) {
  const candidates = page.locator('button, [role="button"], div');
  const count = Math.min(await candidates.count(), 1200);
  let best = null;
  let bestScore = -1;
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    const text = ((await el.textContent().catch(() => '')) || '').trim();
    if (!text || text.length > 80 || /^฿/.test(text)) continue;
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;
    const attrs = await el.evaluate((node) => ({
      ariaPressed: node.getAttribute('aria-pressed'),
      ariaChecked: node.getAttribute('aria-checked'),
      cls: String(node.className || '').toLowerCase(),
      style: getComputedStyle(node)
    })).catch(() => null);
    if (!attrs) continue;
    let score = 0;
    if (attrs.ariaPressed === 'true' || attrs.ariaChecked === 'true') score += 8;
    if (/selected|active|choosed/.test(attrs.cls)) score += 5;
    if (/rgb\(238,\s*77,\s*45\)/.test(attrs.style.borderColor || '')) score += 4;
    if (/rgb\(238,\s*77,\s*45\)/.test(attrs.style.color || '')) score += 2;
    if (/\b(XXL|34|x4|ชาย)\b/i.test(text)) score += 3;
    if (score > bestScore) {
      best = text;
      bestScore = score;
    }
  }
  return bestScore >= 4 ? best : null;
}

function parseDisplayedPrice(value) {
  if (!value) return null;
  const m = String(value).match(/฿\s*([\d,.]+)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
