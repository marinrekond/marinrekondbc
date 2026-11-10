// Gemensam kod för CleanSea-webbshopen (Netlify Functions).
// Inga externa beroenden: Stripes REST-API anropas med inbyggd fetch.
// Hemliga nycklar läses ENDAST från Netlify Environment Variables.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SIZES = ['S', 'M', 'L'];
export const MAX_PER_SIZE = 10; // max antal per storlek i en beställning
export const MAX_TOTAL = 30; // max antal armband totalt i en beställning
export const SOURCE = 'marinrekondbc-cart'; // märker sessioner som kommer från den här varukorgen
export const PRODUCT_LABEL = 'CleanSea Wavy Havsblå & Saltvit';
export const DEFAULT_SHIPPING_SEK = 29;

const STRIPE_API = 'https://api.stripe.com/v1';

export const env = (name) => String(process.env[name] ?? '').trim();

export class ConfigError extends Error {}

export function json(status, data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

/* ---------- Konfiguration ---------- */

export function readSecret() {
  const secret = env('STRIPE_SECRET_KEY');
  if (!secret) return { ok: false, problem: 'STRIPE_SECRET_KEY saknas' };
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(secret)) {
    return { ok: false, problem: 'STRIPE_SECRET_KEY måste börja med sk_test_ eller sk_live_ (aldrig pk_)' };
  }
  return { ok: true, secret };
}

export function readConfig() {
  const s = readSecret();
  if (!s.ok) return s;

  const priceIds = { S: env('STRIPE_PRICE_S'), M: env('STRIPE_PRICE_M'), L: env('STRIPE_PRICE_L') };
  const missing = SIZES.filter((size) => !priceIds[size]).map((size) => `STRIPE_PRICE_${size}`);
  if (missing.length) return { ok: false, problem: `${missing.join(', ')} saknas` };
  for (const size of SIZES) {
    if (!/^price_[A-Za-z0-9]+$/.test(priceIds[size])) {
      return { ok: false, problem: `STRIPE_PRICE_${size} ska se ut som price_...` };
    }
  }

  const feeRaw = env('SHIPPING_FEE_SEK');
  const shippingFeeSek = feeRaw === '' ? DEFAULT_SHIPPING_SEK : Number(feeRaw);
  if (!Number.isInteger(shippingFeeSek) || shippingFeeSek < 0 || shippingFeeSek > 500) {
    return { ok: false, problem: 'SHIPPING_FEE_SEK ska vara ett heltal mellan 0 och 500 (kronor)' };
  }

  const countries = (env('SHIPPING_COUNTRIES') || 'SE')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  if (!countries.length || countries.some((c) => !/^[A-Z]{2}$/.test(c))) {
    return { ok: false, problem: 'SHIPPING_COUNTRIES ska vara landskoder, t.ex. SE' };
  }

  return { ok: true, secret: s.secret, priceIds, shippingFeeSek, countries };
}

/* ---------- Webbadresser och ursprung ---------- */

export function siteBase() {
  const v = env('SITE_URL') || env('URL');
  if (!/^https?:\/\//.test(v)) return '';
  return v.replace(/\/+$/, '');
}

function allowedOrigins() {
  const set = new Set();
  for (const key of ['SITE_URL', 'URL', 'DEPLOY_PRIME_URL']) {
    const v = env(key);
    if (!v) continue;
    try {
      const u = new URL(v);
      set.add(u.origin);
      const host = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
      set.add(`${u.protocol}//${host}${u.port ? ':' + u.port : ''}`);
    } catch {
      /* ignorera ogiltigt värde */
    }
  }
  return set;
}

/** Tillåter bara anrop från vår egen webbplats (ingen öppen CORS). */
export function originAllowed(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true; // t.ex. serveranrop; de kan ändå inte ändra priset
  if (env('NETLIFY_DEV') === 'true') return true; // lokal utveckling
  return allowedOrigins().has(origin);
}

/** Vilken adress kunden ska skickas tillbaka till efter Stripe. */
export function returnBase(req) {
  const origin = req.headers.get('origin');
  if (origin && allowedOrigins().has(origin)) return origin;
  return siteBase();
}

/* ---------- Varukorg ---------- */

/**
 * Validerar korgen från webbläsaren. Pris skickas aldrig av webbläsaren och används aldrig.
 * Returnerar { ok: true, items: [{size, quantity}] } (bara storlekar med antal > 0).
 */
export function parseCart(body) {
  const bad = (error) => ({ ok: false, error });
  if (!body || typeof body !== 'object' || !Array.isArray(body.items)) return bad('Ogiltig beställning.');
  if (body.items.length === 0 || body.items.length > 10) return bad('Ogiltig beställning.');

  const totals = { S: 0, M: 0, L: 0 };
  for (const item of body.items) {
    if (!item || typeof item !== 'object') return bad('Ogiltig beställning.');
    if (typeof item.size !== 'string' || !SIZES.includes(item.size)) return bad('Ogiltig storlek. Välj S, M eller L.');
    const q = item.quantity;
    if (typeof q !== 'number' || !Number.isInteger(q)) return bad('Antal måste vara ett heltal.');
    if (q < 0) return bad('Antal kan inte vara negativt.');
    totals[item.size] += q;
    if (totals[item.size] > MAX_PER_SIZE) return bad(`Du kan beställa högst ${MAX_PER_SIZE} armband per storlek åt gången.`);
  }

  const items = SIZES.filter((s) => totals[s] > 0).map((size) => ({ size, quantity: totals[size] }));
  const count = items.reduce((n, i) => n + i.quantity, 0);
  if (count < 1) return bad('Välj minst ett armband.');
  if (count > MAX_TOTAL) return bad(`Du kan beställa högst ${MAX_TOTAL} armband åt gången. Kontakta oss för större beställningar.`);
  return { ok: true, items, count };
}

export const orderString = (items) => items.map((i) => `${i.size}:${i.quantity}`).join(',');
export const describeOrder = (items) => items.map((i) => `${i.quantity}×${i.size}`).join(', ');

/** Läser tillbaka "S:1,M:2" från sessionens metadata. Ogiltiga delar ignoreras. */
export function parseOrderString(str) {
  const out = [];
  for (const part of String(str || '').split(',')) {
    const [size, q] = part.split(':');
    const quantity = Number(q);
    if (SIZES.includes(size) && Number.isInteger(quantity) && quantity > 0) out.push({ size, quantity });
  }
  return out;
}

/* ---------- Stripe ---------- */

export function toForm(obj) {
  const params = new URLSearchParams();
  const walk = (value, key) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${key}[${i}]`));
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, key ? `${key}[${k}]` : k);
    else params.append(key, String(value));
  };
  walk(obj, '');
  return params.toString();
}

export async function stripe(secret, method, path, { form, headers } = {}) {
  let res;
  try {
    res = await fetch(STRIPE_API + path, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      body: form ? toForm(form) : undefined,
      signal: AbortSignal.timeout(7000),
    });
  } catch (e) {
    const err = new Error('Kunde inte nå Stripe');
    err.network = true;
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ingen JSON */
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Stripe svarade ${res.status}`);
    err.status = res.status;
    err.stripe = data?.error || null;
    throw err;
  }
  return data;
}

const priceCache = new Map();
export function clearPriceCache() {
  priceCache.clear();
}

/**
 * Hämtar de tre priserna från Stripe och kontrollerar att de är aktiva, i SEK och engångsbetalningar.
 * Returnerar { S: öre, M: öre, L: öre }. Priset kommer alltså från Stripe, aldrig från webbläsaren.
 */
export async function loadPrices(cfg) {
  const out = {};
  await Promise.all(
    SIZES.map(async (size) => {
      const id = cfg.priceIds[size];
      const hit = priceCache.get(id);
      let price;
      if (hit && Date.now() - hit.at < 10 * 60 * 1000) {
        price = hit.data;
      } else {
        try {
          price = await stripe(cfg.secret, 'GET', `/prices/${id}`);
        } catch (e) {
          if (e.status === 401) throw new ConfigError('Stripe nekade nyckeln (STRIPE_SECRET_KEY).');
          if (e.status === 404 || e.status === 400)
            throw new ConfigError(`Priset STRIPE_PRICE_${size} hittades inte. Kontrollera att nyckeln och priset är båda test eller båda live.`);
          throw e;
        }
        priceCache.set(id, { at: Date.now(), data: price });
      }
      if (!price.active) throw new ConfigError(`Priset STRIPE_PRICE_${size} är inte aktivt i Stripe.`);
      if (price.currency !== 'sek') throw new ConfigError(`Priset STRIPE_PRICE_${size} är inte i SEK.`);
      if (price.type !== 'one_time') throw new ConfigError(`Priset STRIPE_PRICE_${size} ska vara en engångsbetalning.`);
      if (!Number.isInteger(price.unit_amount) || price.unit_amount <= 0)
        throw new ConfigError(`Priset STRIPE_PRICE_${size} saknar fast belopp.`);
      out[size] = price.unit_amount;
    }),
  );
  return out;
}

/** Översätter interna fel till begripliga svar. Detaljer loggas, inga hemligheter. */
export function errorResponse(e, where) {
  if (e instanceof ConfigError) {
    console.error(`[${where}] Konfigurationsfel:`, e.message);
    return json(500, { error: 'Betalningen är inte korrekt inställd än. Kontakta oss så hjälper vi dig.' });
  }
  if (e?.status === 401) {
    console.error(`[${where}] Stripe nekade nyckeln.`);
    return json(500, { error: 'Betalningen är inte korrekt inställd än. Kontakta oss så hjälper vi dig.' });
  }
  if (e?.status === 429) {
    return json(429, { error: 'Många försöker köpa just nu. Vänta en stund och försök igen.' });
  }
  console.error(`[${where}] Fel från Stripe/nätverk:`, e?.stripe?.type || '', e?.stripe?.code || '', e?.message || e);
  return json(502, { error: 'Vi kunde inte starta betalningen just nu. Försök igen om en stund.' });
}

/* ---------- Webhook-signatur ---------- */

export function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300, nowMs = Date.now()) {
  if (!header || !secret) return false;
  let t = null;
  const sigs = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') sigs.push(v);
  }
  if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest();
  return sigs.some((s) => {
    if (!/^[0-9a-f]+$/i.test(s)) return false;
    const b = Buffer.from(s, 'hex');
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
}

/** Samma beställning från samma person inom en minut ger samma Stripe-session (skyddar mot dubbelklick). */
export function idempotencyKey(orderStr, ip, base) {
  const bucket = Math.floor(Date.now() / 60000);
  return 'cart-' + createHash('sha256').update(`${orderStr}|${ip}|${base}|${bucket}`).digest('hex').slice(0, 48);
}

export const kr = (ore) => `${(ore / 100).toLocaleString('sv-SE', { maximumFractionDigits: 2 })} kr`;
