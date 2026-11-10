// POST /api/create-checkout
// Tar emot { items: [{ size: "S"|"M"|"L", quantity: heltal }] } och skapar en Stripe Checkout Session.
// Priset kommer alltid från Stripe Price ID:n på servern, aldrig från webbläsaren.

import {
  PRODUCT_LABEL,
  SOURCE,
  describeOrder,
  errorResponse,
  idempotencyKey,
  json,
  loadPrices,
  orderString,
  originAllowed,
  parseCart,
  readConfig,
  returnBase,
  stripe,
} from './_shared/shop.mjs';

export function buildSessionParams({ cfg, items, base, prices }) {
  const order = orderString(items);
  const count = items.reduce((n, i) => n + i.quantity, 0);
  const subtotalOre = items.reduce((sum, i) => sum + prices[i.size] * i.quantity, 0);
  const metadata = {
    source: SOURCE,
    order, // t.ex. "S:1,M:2"
    items_total: String(count),
    subtotal_sek: String(subtotalOre / 100),
    shipping_sek: String(cfg.shippingFeeSek),
  };

  return {
    mode: 'payment',
    locale: 'sv',
    line_items: items.map((i) => ({ price: cfg.priceIds[i.size], quantity: i.quantity })),
    // Namn och e-post samlas alltid in av Stripe. Här lägger vi till leveransadress (Sverige).
    shipping_address_collection: { allowed_countries: cfg.countries },
    shipping_options:
      cfg.shippingFeeSek > 0
        ? [
            {
              shipping_rate_data: {
                type: 'fixed_amount',
                display_name: 'Frakt (Sverige)',
                fixed_amount: { amount: cfg.shippingFeeSek * 100, currency: 'sek' },
              },
            },
          ]
        : undefined,
    success_url: `${base}/armband-tack.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/#armband`,
    metadata,
    payment_intent_data: {
      description: `${PRODUCT_LABEL}: ${describeOrder(items)}`,
      metadata,
    },
  };
}

export default async (req, context) => {
  if (req.method !== 'POST') return json(405, { error: 'Metoden stöds inte.' }, { Allow: 'POST' });
  if (!originAllowed(req)) return json(403, { error: 'Begäran nekades.' });

  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) return json(415, { error: 'Ogiltig begäran.' });

  const raw = await req.text();
  if (raw.length > 2000) return json(413, { error: 'Begäran är för stor.' });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'Ogiltig begäran.' });
  }

  const parsed = parseCart(body);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const cfg = readConfig();
  if (!cfg.ok) {
    console.error('[create-checkout] Saknad eller felaktig konfiguration:', cfg.problem);
    return json(503, { error: 'Webbshopen är inte öppnad än. Kontakta oss så hjälper vi dig.' });
  }

  const base = returnBase(req);
  if (!base) {
    console.error('[create-checkout] Varken SITE_URL eller URL är satt.');
    return json(503, { error: 'Webbshopen är inte öppnad än. Kontakta oss så hjälper vi dig.' });
  }

  try {
    const prices = await loadPrices(cfg); // kontrollerar SEK/aktiv/engångs direkt mot Stripe
    const params = buildSessionParams({ cfg, items: parsed.items, base, prices });
    const ip =
      context?.ip ||
      req.headers.get('x-nf-client-connection-ip') ||
      (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
      'okand';
    const session = await stripe(cfg.secret, 'POST', '/checkout/sessions', {
      form: params,
      headers: { 'Idempotency-Key': idempotencyKey(orderString(parsed.items), ip, base) },
    });
    if (!session?.url || !String(session.url).startsWith('https://checkout.stripe.com/')) {
      throw new Error('Stripe returnerade ingen betalningsadress');
    }
    return json(200, { url: session.url });
  } catch (e) {
    return errorResponse(e, 'create-checkout');
  }
};

export const config = { path: '/api/create-checkout' };
