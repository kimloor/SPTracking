# SPTracking

Shopee price-tracking web app project.

## Current phase

Technical probe: verify that a Cloudflare Worker can fetch Shopee product data and resolve exact variation/model pricing.

## Local run

```bash
npm install
npm run dev
```

Health check:

```text
http://localhost:8787/health
```

Probe example:

```text
http://localhost:8787/?shopid=50216086&itemid=845052410&modelid=1567087028
```

## Deploy

```bash
npx wrangler login
npm run deploy
```

After deployment, run the same query against the generated `*.workers.dev` URL.

## Probe success criteria

- Cloudflare Worker can reach Shopee without CAPTCHA / block.
- Product response is valid JSON or otherwise parseable.
- `model_id` can be mapped to the exact variation.
- Exact variation price and stock can be extracted.
- Fetch failures never become fake price records.
