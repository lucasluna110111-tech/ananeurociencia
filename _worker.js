const PRICE = 2000;
const CURRENCY = 'ARS';
const PRODUCT_ID = 'guia-neurociencia-001';
const PRODUCT = 'Guía Completa de Neurociencia Aplicada, Neuroplasticidad y Aprendizaje';
const R2_KEY = 'guia-neurociencia.docx';
const DOWNLOAD_NAME = 'Guia-Neurociencia-Aplicada.docx';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    }
  });
}

async function mpFetch(env, path, init = {}) {
  if (!env.MP_ACCESS_TOKEN) throw new Error('Falta MP_ACCESS_TOKEN');
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${env.MP_ACCESS_TOKEN}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(`https://api.mercadopago.com${path}`, { ...init, headers });
}

async function getPayment(env, paymentId) {
  const r = await mpFetch(env, `/v1/payments/${encodeURIComponent(paymentId)}`);
  if (!r.ok) return null;
  return r.json();
}

function paymentMatches(payment, token) {
  return !!payment &&
    payment.status === 'approved' &&
    payment.status_detail === 'accredited' &&
    payment.external_reference === token &&
    Number(payment.transaction_amount) === PRICE &&
    payment.currency_id === CURRENCY;
}

async function getSale(env, token) {
  return env.DB.prepare('SELECT * FROM sales WHERE token = ?').bind(token).first();
}

async function createCheckout(request, env) {
  if (request.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  if (!env.MP_ACCESS_TOKEN) return json({ error: 'Falta configurar MP_ACCESS_TOKEN en Cloudflare.' }, 500);
  if (!env.DB) return json({ error: 'Falta vincular la base D1 con el nombre DB.' }, 500);

  let body = {};
  try { body = await request.json(); } catch {}
  if (body.product && body.product !== 'guia-neurociencia') return json({ error: 'Producto inválido.' }, 400);

  const token = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO sales (token, product, amount, currency, created_at, approved, used)
    VALUES (?, ?, ?, ?, ?, 0, 0)
  `).bind(token, PRODUCT, PRICE, CURRENCY, now).run();

  const siteUrl = new URL(request.url).origin;
  const preference = {
    items: [{
      id: PRODUCT_ID,
      title: PRODUCT,
      description: 'Material digital educativo',
      quantity: 1,
      currency_id: CURRENCY,
      unit_price: PRICE
    }],
    external_reference: token,
    back_urls: {
      success: `${siteUrl}/?payment=success`,
      pending: `${siteUrl}/?payment=pending`,
      failure: `${siteUrl}/?payment=failure`
    },
    auto_return: 'approved',
    notification_url: `${siteUrl}/api/mp-webhook`
  };

  let response;
  try {
    response = await mpFetch(env, '/checkout/preferences', {
      method: 'POST',
      body: JSON.stringify(preference)
    });
  } catch (e) {
    await env.DB.prepare('DELETE FROM sales WHERE token = ?').bind(token).run();
    return json({ error: 'No se pudo conectar con Mercado Pago.' }, 502);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.init_point) {
    await env.DB.prepare('DELETE FROM sales WHERE token = ?').bind(token).run();
    return json({ error: 'Mercado Pago no pudo crear el checkout.', detail: data }, 502);
  }

  await env.DB.prepare('UPDATE sales SET preference_id = ? WHERE token = ?').bind(String(data.id || ''), token).run();
  return json({ checkoutUrl: data.init_point, token });
}

async function paymentStatus(request, env) {
  if (request.method !== 'GET') return json({ error: 'Método no permitido' }, 405);
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const paymentId = url.searchParams.get('payment_id');
  if (!token || !paymentId) return json({ error: 'Faltan datos de pago.' }, 400);

  const sale = await getSale(env, token);
  if (!sale) return json({ error: 'Compra no encontrada.' }, 404);
  if (sale.product !== PRODUCT || Number(sale.amount) !== PRICE || sale.currency !== CURRENCY) return json({ error: 'Producto inválido.' }, 400);
  if (Number(sale.used) === 1) return json({ status: 'used', message: 'Este enlace de descarga ya fue utilizado.' });

  const payment = await getPayment(env, paymentId);
  if (!payment) return json({ status: 'pending', message: 'Todavía no se pudo consultar el pago.' });

  if (payment.external_reference !== token || Number(payment.transaction_amount) !== PRICE || payment.currency_id !== CURRENCY) {
    return json({ error: 'El pago no coincide con esta compra.' }, 403);
  }

  if (payment.status !== 'approved' || payment.status_detail !== 'accredited') {
    return json({ status: payment.status || 'pending', detail: payment.status_detail || null });
  }

  await env.DB.prepare(`
    UPDATE sales SET approved = 1, payment_id = ?, approved_at = ?
    WHERE token = ? AND used = 0
  `).bind(String(payment.id), Date.now(), token).run();

  return json({
    status: 'approved',
    message: 'Pago aprobado y acreditado. Preparando descarga…',
    downloadUrl: `/api/download?token=${encodeURIComponent(token)}&payment_id=${encodeURIComponent(payment.id)}`
  });
}

async function webhook(request, env) {
  if (request.method !== 'POST') return new Response('OK');
  let body = {};
  try { body = await request.json(); } catch { return new Response('OK'); }

  const paymentId = body?.data?.id || new URL(request.url).searchParams.get('data.id');
  const type = body?.type || new URL(request.url).searchParams.get('type');
  if (!paymentId || (type && type !== 'payment')) return new Response('OK');

  const payment = await getPayment(env, paymentId);
  if (!paymentMatches(payment, payment?.external_reference)) return new Response('OK');
  const token = payment.external_reference;
  const sale = await getSale(env, token);
  if (!sale || sale.product !== PRODUCT || Number(sale.amount) !== PRICE || sale.currency !== CURRENCY || Number(sale.used) === 1) return new Response('OK');

  await env.DB.prepare(`
    UPDATE sales SET approved = 1, payment_id = ?, approved_at = ?
    WHERE token = ? AND used = 0
  `).bind(String(payment.id), Date.now(), token).run();
  return new Response('OK');
}

async function download(request, env) {
  if (request.method !== 'GET') return new Response('Método no permitido', { status: 405 });
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const paymentId = url.searchParams.get('payment_id');
  if (!token || !paymentId) return new Response('Enlace inválido.', { status: 400 });
  if (!env.GUIDES) return new Response('Falta vincular el bucket R2 con el nombre GUIDES.', { status: 500 });

  const sale = await getSale(env, token);
  if (!sale) return new Response('Enlace inválido o expirado.', { status: 404 });
  if (Number(sale.used) === 1) return new Response('Este enlace de descarga ya fue utilizado.', { status: 410 });
  if (Number(sale.approved) !== 1 || String(sale.payment_id) !== String(paymentId)) return new Response('El pago todavía no está aprobado.', { status: 403 });

  const payment = await getPayment(env, paymentId);
  if (!paymentMatches(payment, token)) return new Response('No se pudo validar el pago.', { status: 403 });

  // Primero comprobamos que el archivo privado exista. No se consume el enlace si R2 falla.
  const object = await env.GUIDES.get(R2_KEY);
  if (!object) return new Response('Archivo no disponible en el servidor.', { status: 500 });

  // Reserva atómica de un solo uso: solo una solicitud puede cambiar used de 0 a 1.
  const claim = await env.DB.prepare(`
    UPDATE sales SET used = 1, used_at = ?
    WHERE token = ? AND used = 0 AND approved = 1 AND payment_id = ?
  `).bind(Date.now(), token, String(paymentId)).run();

  if (!claim?.meta || Number(claim.meta.changes) !== 1) {
    return new Response('Este enlace de descarga ya fue utilizado.', { status: 410 });
  }

  const headers = new Headers();
  headers.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  headers.set('Content-Disposition', `attachment; filename="${DOWNLOAD_NAME}"`);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  headers.set('Pragma', 'no-cache');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (object.size != null) headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/create-checkout') return await createCheckout(request, env);
      if (url.pathname === '/api/payment-status') return await paymentStatus(request, env);
      if (url.pathname === '/api/mp-webhook') return await webhook(request, env);
      if (url.pathname === '/api/download') return await download(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      if (url.pathname.startsWith('/api/')) return json({ error: 'Error interno del servidor.' }, 500);
      return env.ASSETS.fetch(request);
    }
  }
};
