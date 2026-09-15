export async function persistCapture(db, capture) {
  const now = new Date().toISOString();
  const priceMinor = toMinor(capture.price);
  const originalMinor = capture.original_price == null ? null : toMinor(capture.original_price);
  const stockStatus = capture.stock === 0 ? 'OUT_OF_STOCK' : 'ACTIVE';
  const canonicalUrl = `https://shopee.co.th/-i.${capture.shop_id}.${capture.item_id}`;

  await db.prepare(`
    INSERT INTO products (shop_id, item_id, name, canonical_url, status, updated_at)
    VALUES (?, ?, ?, ?, 'ACTIVE', ?)
    ON CONFLICT(shop_id, item_id) DO UPDATE SET
      name = COALESCE(excluded.name, products.name),
      canonical_url = excluded.canonical_url,
      status = 'ACTIVE',
      updated_at = excluded.updated_at
  `).bind(capture.shop_id, capture.item_id, capture.product_name, canonicalUrl, now).run();

  const product = await db.prepare(
    'SELECT id FROM products WHERE shop_id = ? AND item_id = ?'
  ).bind(capture.shop_id, capture.item_id).first();
  if (!product?.id) throw new Error('Failed to resolve product after upsert');

  await db.prepare(`
    INSERT INTO product_variants (
      product_id, model_id, variation_name, current_price_minor,
      original_price_minor, stock_status, stock, first_seen_at, last_checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id, model_id) DO UPDATE SET
      variation_name = COALESCE(excluded.variation_name, product_variants.variation_name),
      current_price_minor = excluded.current_price_minor,
      original_price_minor = COALESCE(excluded.original_price_minor, product_variants.original_price_minor),
      stock_status = excluded.stock_status,
      stock = excluded.stock,
      last_checked_at = excluded.last_checked_at
  `).bind(
    product.id,
    capture.model_id,
    capture.variation_name,
    priceMinor,
    originalMinor,
    stockStatus,
    capture.stock,
    now,
    now
  ).run();

  const variant = await db.prepare(
    'SELECT id FROM product_variants WHERE product_id = ? AND model_id = ?'
  ).bind(product.id, capture.model_id).first();
  if (!variant?.id) throw new Error('Failed to resolve variant after upsert');

  await db.batch([
    db.prepare(`
      INSERT INTO price_history (
        variant_id, price_minor, original_price_minor, stock_status, stock, source, checked_at
      ) VALUES (?, ?, ?, ?, ?, 'browser_capture', ?)
    `).bind(variant.id, priceMinor, originalMinor, stockStatus, capture.stock, now),
    db.prepare(`
      INSERT INTO tracking (variant_id, active, first_requested_at, last_requested_at, created_at)
      VALUES (?, 1, ?, ?, ?)
      ON CONFLICT(variant_id) DO UPDATE SET
        active = 1,
        last_requested_at = excluded.last_requested_at
    `).bind(variant.id, now, now, now)
  ]);

  return { product_id: product.id, variant_id: variant.id, checked_at: now };
}

export async function getVariantHistory(db, shopId, itemId, modelId, limit = 200) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const variant = await db.prepare(`
    SELECT
      p.name AS product_name,
      p.shop_id,
      p.item_id,
      v.id AS variant_id,
      v.model_id,
      v.variation_name,
      v.current_price_minor,
      v.original_price_minor,
      v.stock_status,
      v.stock,
      v.last_checked_at
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    WHERE p.shop_id = ? AND p.item_id = ? AND v.model_id = ?
  `).bind(shopId, itemId, modelId).first();

  if (!variant) return null;

  const history = await db.prepare(`
    SELECT price_minor, original_price_minor, stock_status, stock, source, checked_at
    FROM price_history
    WHERE variant_id = ?
    ORDER BY checked_at DESC
    LIMIT ?
  `).bind(variant.variant_id, safeLimit).all();

  const rows = history?.results || [];
  const prices = rows.map((r) => r.price_minor).filter(Number.isFinite);

  return {
    product_name: variant.product_name,
    shop_id: variant.shop_id,
    item_id: variant.item_id,
    model_id: variant.model_id,
    variation_name: variant.variation_name,
    current_price: fromMinor(variant.current_price_minor),
    original_price: fromMinor(variant.original_price_minor),
    stock_status: variant.stock_status,
    stock: variant.stock,
    last_checked_at: variant.last_checked_at,
    stats: prices.length ? {
      observations: prices.length,
      lowest: fromMinor(Math.min(...prices)),
      highest: fromMinor(Math.max(...prices)),
      average: fromMinor(Math.round(prices.reduce((a, b) => a + b, 0) / prices.length))
    } : { observations: 0, lowest: null, highest: null, average: null },
    history: rows.map((r) => ({
      price: fromMinor(r.price_minor),
      original_price: fromMinor(r.original_price_minor),
      stock_status: r.stock_status,
      stock: r.stock,
      source: r.source,
      checked_at: r.checked_at
    }))
  };
}

function toMinor(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid price');
  return Math.round(n * 100);
}

function fromMinor(value) {
  if (value === null || value === undefined) return null;
  return Number(value) / 100;
}
