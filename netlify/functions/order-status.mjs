// GET /api/order-status?session_id=cs_...
// Tack-sidan använder den här för att kontrollera betalningen direkt mot Stripe.
// Att kunden hamnar på tack-sidan räcker alltså aldrig som bevis på betalning.
// Returnerar inga personuppgifter (ingen e-post, ingen adress).

import { SOURCE, errorResponse, json, parseOrderString, readSecret, stripe } from './_shared/shop.mjs';

export default async (req) => {
  if (req.method !== 'GET') return json(405, { error: 'Metoden stöds inte.' }, { Allow: 'GET' });

  const id = new URL(req.url).searchParams.get('session_id') || '';
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return json(400, { error: 'Ogiltigt beställnings-id.' });

  const s = readSecret();
  if (!s.ok) {
    console.error('[order-status] Konfigurationsfel:', s.problem);
    return json(503, { error: 'Kunde inte kontrollera betalningen just nu.' });
  }

  try {
    const session = await stripe(s.secret, 'GET', `/checkout/sessions/${id}`);
    // Visa bara sessioner som skapats av vår egen varukorg.
    if (session?.metadata?.source !== SOURCE) return json(404, { error: 'Beställningen hittades inte.' });

    const order = parseOrderString(session.metadata.order);
    const paid = session.payment_status === 'paid';
    return json(200, {
      paid,
      paymentStatus: session.payment_status, // paid | unpaid | no_payment_required
      sessionStatus: session.status, // open | complete | expired
      livemode: !!session.livemode,
      order, // [{ size, quantity }]
      totalCount: order.reduce((n, i) => n + i.quantity, 0),
      amountTotal: session.amount_total, // öre, inklusive frakt
      amountShipping: session.total_details?.amount_shipping ?? null,
      currency: session.currency,
    });
  } catch (e) {
    if (e?.status === 404) return json(404, { error: 'Beställningen hittades inte.' });
    return errorResponse(e, 'order-status');
  }
};

export const config = { path: '/api/order-status' };
