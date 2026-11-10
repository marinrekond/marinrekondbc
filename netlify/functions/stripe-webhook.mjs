// POST /api/stripe-webhook   (VALFRI i första versionen)
// Stripe anropar den här adressen när en betalning är klar. Den verifierar att anropet verkligen
// kommer från Stripe (signatur) och loggar den betalda beställningen. Om RESEND_API_KEY och
// ORDER_NOTIFY_EMAIL är satta mejlas även en orderbekräftelse till er.
// Aktiveras genom att STRIPE_WEBHOOK_SECRET sätts i Netlify. Ingen databas behövs.

import {
  SOURCE,
  env,
  json,
  kr,
  parseOrderString,
  readSecret,
  stripe,
  verifyStripeSignature,
} from './_shared/shop.mjs';

function summarize(session) {
  const order = parseOrderString(session.metadata?.order);
  const count = order.reduce((n, i) => n + i.quantity, 0);
  const ship = session.collected_information?.shipping_details || session.shipping_details || null;
  const a = ship?.address || {};
  const lines = [
    `Ny betald beställning (CleanSea-armband)`,
    ``,
    `Läge: ${session.livemode ? 'LIVE' : 'TEST'}`,
    `Session: ${session.id}`,
    `Artiklar: ${order.map((i) => `${i.quantity} × ${i.size}`).join(', ')} (totalt ${count})`,
    `Frakt: ${kr(session.total_details?.amount_shipping ?? 0)}`,
    `Totalt betalt: ${kr(session.amount_total ?? 0)}`,
    ``,
    `Kund: ${session.customer_details?.name || ship?.name || '-'}`,
    `E-post: ${session.customer_details?.email || '-'}`,
    `Leverans: ${[ship?.name, a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ') || '-'}`,
    ``,
    `Öppna i Stripe: https://dashboard.stripe.com/${session.livemode ? '' : 'test/'}payments/${session.payment_intent || ''}`,
  ];
  return { text: lines.join('\n'), count };
}

async function sendEmail(session, text) {
  const key = env('RESEND_API_KEY');
  const to = env('ORDER_NOTIFY_EMAIL');
  if (!key || !to) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `order-${session.id}`, // ingen dubbel mejl om Stripe skickar om händelsen
    },
    body: JSON.stringify({
      from: env('ORDER_EMAIL_FROM') || 'Marinrekond BC <onboarding@resend.dev>',
      to: [to],
      subject: `Ny order: CleanSea-armband${session.livemode ? '' : ' (TEST)'}`,
      text,
    }),
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error(`Resend svarade ${res.status}`);
  return true;
}

async function handlePaid(sessionFromEvent) {
  if (sessionFromEvent?.metadata?.source !== SOURCE) return; // t.ex. betalningar via era vanliga Payment Links
  const s = readSecret();
  if (!s.ok) throw new Error(s.problem);
  // Hämta om sessionen från Stripe så att vi alltid arbetar med färska, kompletta uppgifter.
  const session = await stripe(s.secret, 'GET', `/checkout/sessions/${sessionFromEvent.id}`);
  if (session.payment_status !== 'paid') return;
  const { text } = summarize(session);
  console.log('ORDER BETALD\n' + text);
  await sendEmail(session, text);
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Metoden stöds inte.' }, { Allow: 'POST' });

  const secret = env('STRIPE_WEBHOOK_SECRET');
  if (!secret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET är inte satt.');
    return json(503, { error: 'Webhook är inte aktiverad.' });
  }

  const raw = await req.text(); // måste vara exakt rå text för att signaturen ska stämma
  if (!verifyStripeSignature(raw, req.headers.get('stripe-signature'), secret)) {
    return json(400, { error: 'Ogiltig signatur.' });
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json(400, { error: 'Ogiltig begäran.' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        // Vid vissa betalsätt är betalningen inte klar än (payment_status = unpaid). Då väntar vi på nästa händelse.
        if (event.data?.object?.payment_status === 'paid') await handlePaid(event.data.object);
        break;
      case 'checkout.session.async_payment_succeeded':
        await handlePaid(event.data.object);
        break;
      case 'checkout.session.async_payment_failed':
        if (event.data?.object?.metadata?.source === SOURCE)
          console.warn('[stripe-webhook] Betalningen misslyckades för session', event.data.object.id);
        break;
      default:
        break; // andra händelser ignoreras
    }
  } catch (e) {
    console.error('[stripe-webhook] Kunde inte hantera händelsen:', event?.type, e?.message || e);
    return json(500, { error: 'Kunde inte hantera händelsen.' }); // Stripe försöker igen automatiskt
  }
  return json(200, { received: true });
};

export const config = { path: '/api/stripe-webhook' };
