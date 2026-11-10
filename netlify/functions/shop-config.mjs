// GET /api/shop-config
// Ger hemsidan aktuella priser (hämtade från Stripe) och frakt, så att det som visas
// alltid stämmer med det kunden faktiskt betalar. Innehåller inga hemligheter.

import { MAX_PER_SIZE, MAX_TOTAL, errorResponse, json, loadPrices, readConfig } from './_shared/shop.mjs';

export default async (req) => {
  if (req.method !== 'GET') return json(405, { error: 'Metoden stöds inte.' }, { Allow: 'GET' });
  const cfg = readConfig();
  if (!cfg.ok) {
    console.error('[shop-config] Saknad eller felaktig konfiguration:', cfg.problem);
    return json(503, { error: 'Webbshopen är inte öppnad än.' });
  }
  try {
    const prices = await loadPrices(cfg);
    return json(200, {
      currency: 'SEK',
      prices, // öre per storlek, t.ex. { S: 16000, M: 16000, L: 16000 }
      shipping: cfg.shippingFeeSek * 100, // öre
      maxPerSize: MAX_PER_SIZE,
      maxTotal: MAX_TOTAL,
    });
  } catch (e) {
    return errorResponse(e, 'shop-config');
  }
};

export const config = { path: '/api/shop-config' };
