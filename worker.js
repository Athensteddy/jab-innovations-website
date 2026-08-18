function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

function unauthorized() {
  return new Response("Admin login required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="JAB Innovations Admin"',
      "cache-control": "no-store"
    }
  });
}

function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Basic ")) return false;
  try {
    const decoded = atob(auth.slice(6));
    const splitAt = decoded.indexOf(":");
    if (splitAt === -1) return false;
    const username = decoded.slice(0, splitAt);
    const password = decoded.slice(splitAt + 1);
    return username === "admin" && password === env.ADMIN_PASSWORD;
  } catch {
    return false;
  }
}

// ======================================================
// CUSTOMER SECURITY / AUTH
// ======================================================

const SESSION_COOKIE = "jab_session";
const SESSION_DAYS = 14;
const PBKDF2_ITERATIONS = 100000;
const enc = new TextEncoder();

function bytesToBase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(value) {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function randomBase64(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

async function sha256Base64(value) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return bytesToBase64(new Uint8Array(digest));
}

async function hashPassword(password, salt = randomBase64(16)) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64ToBytes(salt),
      iterations: PBKDF2_ITERATIONS
    },
    key,
    256
  );
  return { salt, hash: bytesToBase64(new Uint8Array(bits)) };
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(password, salt, expectedHash) {
  const result = await hashPassword(password, salt);
  return constantTimeEqual(result.hash, expectedHash);
}

function parseCookies(request) {
  const out = {};
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAge = SESSION_DAYS * 86400) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function cleanText(value, max = 200) {
  return String(value || "").trim().slice(0, max);
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 10) {
    throw new Error("Password must be at least 10 characters.");
  }
  if (password.length > 200) throw new Error("Password is too long.");
}

function assertSameOrigin(request) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  const origin = request.headers.get("Origin");
  if (!origin) return;
  const expected = new URL(request.url).origin;
  if (origin !== expected) throw new Error("Invalid request origin.");
}

async function ensureCustomerTables(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS customer_sessions (
      token_hash TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_customer ON customer_sessions(customer_id)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS customer_addresses (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT 'Primary',
      recipient_name TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      line1 TEXT NOT NULL,
      line2 TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      postal_code TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'US',
      phone TEXT NOT NULL DEFAULT '',
      is_default_shipping INTEGER NOT NULL DEFAULT 0,
      is_default_billing INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_addresses_customer ON customer_addresses(customer_id)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_number TEXT NOT NULL UNIQUE,
      customer_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_payment',
      payment_status TEXT NOT NULL DEFAULT 'not_configured',
      subtotal REAL NOT NULL DEFAULT 0,
      shipping_amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      shipping_json TEXT NOT NULL,
      billing_json TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, created_at)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      unit_price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      line_total REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)`)
  ]);
}

async function getCurrentCustomer(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = await sha256Base64(token);
  const row = await env.DB.prepare(`
    SELECT c.id, c.email, c.name, c.phone, c.active
    FROM customer_sessions s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP AND c.active = 1
  `).bind(tokenHash).first();
  return row || null;
}

async function requireCustomer(request, env) {
  const customer = await getCurrentCustomer(request, env);
  if (!customer) throw Object.assign(new Error("Please sign in first."), { status: 401 });
  return customer;
}

async function createSession(customerId, env) {
  const token = randomBase64(32);
  const tokenHash = await sha256Base64(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.prepare(`INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES (?,?,?)`)
    .bind(tokenHash, customerId, expiresAt)
    .run();
  return token;
}

async function registerCustomer(request, env) {
  assertSameOrigin(request);
  await ensureCustomerTables(env);
  const body = await request.json();
  const email = cleanText(body.email, 254).toLowerCase();
  const name = cleanText(body.name, 120);
  const phone = cleanText(body.phone, 40);
  const password = body.password;
  if (!validEmail(email)) throw new Error("Enter a valid email address.");
  if (!name) throw new Error("Name is required.");
  validatePassword(password);
  const existing = await env.DB.prepare("SELECT id FROM customers WHERE email = ? COLLATE NOCASE").bind(email).first();
  if (existing) throw Object.assign(new Error("An account already exists for this email."), { status: 409 });
  const id = crypto.randomUUID();
  const passwordData = await hashPassword(password);
  await env.DB.prepare(`INSERT INTO customers (id,email,password_hash,password_salt,name,phone) VALUES (?,?,?,?,?,?)`)
    .bind(id, email, passwordData.hash, passwordData.salt, name, phone)
    .run();
  const token = await createSession(id, env);
  return json({ ok: true, customer: { id, email, name, phone } }, 201, { "set-cookie": sessionCookie(token) });
}

async function loginCustomer(request, env) {
  assertSameOrigin(request);
  await ensureCustomerTables(env);
  const body = await request.json();
  const email = cleanText(body.email, 254).toLowerCase();
  const password = body.password;
  if (!validEmail(email) || typeof password !== "string") {
    throw Object.assign(new Error("Email or password is incorrect."), { status: 401 });
  }
  const customer = await env.DB.prepare(`SELECT * FROM customers WHERE email = ? COLLATE NOCASE AND active = 1`)
    .bind(email).first();
  if (!customer || !(await verifyPassword(password, customer.password_salt, customer.password_hash))) {
    throw Object.assign(new Error("Email or password is incorrect."), { status: 401 });
  }
  const token = await createSession(customer.id, env);
  return json({ ok: true, customer: { id: customer.id, email: customer.email, name: customer.name, phone: customer.phone } }, 200, { "set-cookie": sessionCookie(token) });
}

async function logoutCustomer(request, env) {
  assertSameOrigin(request);
  await ensureCustomerTables(env);
  const token = parseCookies(request)[SESSION_COOKIE];
  if (token) {
    const tokenHash = await sha256Base64(token);
    await env.DB.prepare("DELETE FROM customer_sessions WHERE token_hash = ?").bind(tokenHash).run();
  }
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}

async function accountMe(request, env) {
  await ensureCustomerTables(env);
  const customer = await getCurrentCustomer(request, env);
  if (!customer) return json({ authenticated: false }, 200);
  return json({ authenticated: true, customer });
}

function cleanAddress(body) {
  const address = {
    label: cleanText(body.label || "Primary", 40),
    recipient_name: cleanText(body.recipient_name, 120),
    company: cleanText(body.company, 120),
    line1: cleanText(body.line1, 160),
    line2: cleanText(body.line2, 160),
    city: cleanText(body.city, 100),
    state: cleanText(body.state, 80),
    postal_code: cleanText(body.postal_code, 30),
    country: cleanText(body.country || "US", 2).toUpperCase(),
    phone: cleanText(body.phone, 40),
    is_default_shipping: body.is_default_shipping ? 1 : 0,
    is_default_billing: body.is_default_billing ? 1 : 0
  };
  if (!address.recipient_name || !address.line1 || !address.city || !address.state || !address.postal_code) {
    throw new Error("Name, street, city, state and ZIP/postal code are required.");
  }
  return address;
}

async function listAddresses(request, env) {
  await ensureCustomerTables(env);
  const customer = await requireCustomer(request, env);
  const result = await env.DB.prepare(`SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY is_default_shipping DESC, created_at ASC`)
    .bind(customer.id).all();
  return json(result.results || []);
}

async function saveAddress(request, env) {
  assertSameOrigin(request);
  await ensureCustomerTables(env);
  const customer = await requireCustomer(request, env);
  const body = await request.json();
  const a = cleanAddress(body);
  const id = crypto.randomUUID();
  if (a.is_default_shipping) await env.DB.prepare("UPDATE customer_addresses SET is_default_shipping=0 WHERE customer_id=?").bind(customer.id).run();
  if (a.is_default_billing) await env.DB.prepare("UPDATE customer_addresses SET is_default_billing=0 WHERE customer_id=?").bind(customer.id).run();
  await env.DB.prepare(`INSERT INTO customer_addresses
    (id,customer_id,label,recipient_name,company,line1,line2,city,state,postal_code,country,phone,is_default_shipping,is_default_billing)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, customer.id, a.label, a.recipient_name, a.company, a.line1, a.line2, a.city, a.state, a.postal_code, a.country, a.phone, a.is_default_shipping, a.is_default_billing)
    .run();
  return json({ ok: true, id }, 201);
}

async function deleteAddress(id, request, env) {
  assertSameOrigin(request);
  await ensureCustomerTables(env);
  const customer = await requireCustomer(request, env);
  await env.DB.prepare("DELETE FROM customer_addresses WHERE id=? AND customer_id=?").bind(id, customer.id).run();
  return json({ ok: true });
}

function newOrderNumber() {
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,"0")}${String(d.getUTCDate()).padStart(2,"0")}`;
  const rnd = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  return `JAB-${stamp}-${rnd}`;
}

async function createOrder(request, env) {
  assertSameOrigin(request);
  await ensureCustomerTables(env);
  const customer = await requireCustomer(request, env);
  const body = await request.json();
  const requested = Array.isArray(body.items) ? body.items : [];
  if (!requested.length || requested.length > 100) throw new Error("Your cart is empty.");

  const normalized = [];
  for (const item of requested) {
    const id = cleanText(item.id, 120);
    const qty = Math.max(1, Math.min(999, Math.floor(Number(item.qty || 0))));
    if (!id || !Number.isFinite(qty)) throw new Error("Invalid cart item.");
    normalized.push({ id, qty });
  }

  const productRows = [];
  let subtotal = 0;
  for (const item of normalized) {
    const p = await env.DB.prepare(`SELECT id,name,price,quantity,active FROM products WHERE id=?`).bind(item.id).first();
    if (!p || Number(p.active) !== 1) throw new Error("One of the selected products is no longer available.");
    if (Number(p.quantity) < item.qty) throw new Error(`${p.name} only has ${p.quantity} available.`);
    const unitPrice = Number(p.price || 0);
    const lineTotal = Math.round(unitPrice * item.qty * 100) / 100;
    subtotal += lineTotal;
    productRows.push({ ...item, name: p.name, unitPrice, lineTotal });
  }
  subtotal = Math.round(subtotal * 100) / 100;

  const shipping = cleanAddress(body.shipping || {});
  const billing = body.billing_same_as_shipping ? shipping : cleanAddress(body.billing || {});
  const notes = cleanText(body.notes, 1000);
  const shippingAmount = 0;
  const taxAmount = 0;
  const total = Math.round((subtotal + shippingAmount + taxAmount) * 100) / 100;
  const orderId = crypto.randomUUID();
  const orderNumber = newOrderNumber();

  const statements = [
    env.DB.prepare(`INSERT INTO orders
      (id,order_number,customer_id,status,payment_status,subtotal,shipping_amount,tax_amount,total,currency,shipping_json,billing_json,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(orderId, orderNumber, customer.id, "pending_payment", "not_configured", subtotal, shippingAmount, taxAmount, total, "USD", JSON.stringify(shipping), JSON.stringify(billing), notes)
  ];
  for (const item of productRows) {
    statements.push(env.DB.prepare(`INSERT INTO order_items
      (id,order_id,product_id,product_name,unit_price,quantity,line_total) VALUES (?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), orderId, item.id, item.name, item.unitPrice, item.qty, item.lineTotal));
  }
  await env.DB.batch(statements);

    // Send JAB an immediate new-order notification.
  // Email failure must never cancel or lose a saved customer order.
  if (env.SEND_EMAIL) {
    try {
      const itemLines = productRows
        .map(item => `${item.name} x ${item.qty} — $${item.lineTotal.toFixed(2)}`)
        .join("\n");

      const shippingLines = [
        shipping.recipient_name,
        shipping.company,
        shipping.line1,
        shipping.line2,
        `${shipping.city}, ${shipping.state} ${shipping.postal_code}`,
        shipping.phone
      ].filter(Boolean).join("\n");

      await env.SEND_EMAIL.send({
        to: "sales@jab-innovations154.com",
        from: "orders@jab-innovations154.com",
        subject: `New JAB Order — ${orderNumber}`,
        text:
`NEW JAB INNOVATIONS ORDER

Order: ${orderNumber}

CUSTOMER
${customer.name}
${customer.email}
${customer.phone || ""}

ITEMS
${itemLines}

TOTAL
$${total.toFixed(2)}

PAYMENT STATUS
Pending

SHIPPING
${shippingLines}

NOTES
${notes || "None"}

Log in to JAB Admin to review this order.`
      });
    } catch (emailError) {
      console.error("New order email notification failed:", emailError);
    }
  }
  if (env.SEND_EMAIL) {
    try {
      await env.SEND_EMAIL.send({
        to: customer.email,
        from: "orders@jab-innovations154.com",
        subject: `JAB Innovations — Order Received ${orderNumber}`,
        text:
`Thank you, ${customer.name}.

We received your JAB Innovations order.

Order: ${orderNumber}

ITEMS
${productRows.map(item => `${item.name} x ${item.qty} — $${item.lineTotal.toFixed(2)}`).join("\n")}

TOTAL
$${total.toFixed(2)}

STATUS
Order received — pending confirmation.

We will send another email when your order is confirmed.

JAB Innovations
Advancing Research Through Quality and Innovation.`
      });
    } catch (emailError) {
      console.error("Customer order receipt email failed:", emailError);
    }
  }
  return json({
    ok: true,
    order: { id: orderId, order_number: orderNumber, status: "pending_payment", payment_status: "not_configured", subtotal, shipping_amount: shippingAmount, tax_amount: taxAmount, total, currency: "USD" },
    message: "Order saved. Online card payment is not enabled yet, so inventory has not been reduced."
  }, 201);
}

async function listOrders(request, env) {
  await ensureCustomerTables(env);
  const customer = await requireCustomer(request, env);
  const result = await env.DB.prepare(`SELECT id,order_number,status,payment_status,subtotal,shipping_amount,tax_amount,total,currency,created_at FROM orders WHERE customer_id=? ORDER BY created_at DESC`)
    .bind(customer.id).all();
  const orders = result.results || [];
  for (const order of orders) {
    const items = await env.DB.prepare(`SELECT product_id,product_name,unit_price,quantity,line_total FROM order_items WHERE order_id=? ORDER BY rowid`).bind(order.id).all();
    order.items = items.results || [];
  }
  return json(orders);
}

async function listAdminOrders(request, env) {
  if (!isAdmin(request, env)) return unauthorized();
  await ensureCustomerTables(env);
  const result = await env.DB.prepare(`
    SELECT o.id,o.order_number,o.status,o.payment_status,o.subtotal,o.shipping_amount,o.tax_amount,o.total,o.currency,o.shipping_json,o.billing_json,o.notes,o.created_at,
           c.name AS customer_name,c.email AS customer_email,c.phone AS customer_phone
    FROM orders o
    JOIN customers c ON c.id=o.customer_id
    ORDER BY o.created_at DESC
    LIMIT 250
  `).all();
  const orders = result.results || [];
  for (const order of orders) {
    const items = await env.DB.prepare(`SELECT product_id,product_name,unit_price,quantity,line_total FROM order_items WHERE order_id=? ORDER BY rowid`).bind(order.id).all();
    order.items = items.results || [];
    try { order.shipping = JSON.parse(order.shipping_json || "{}"); } catch { order.shipping = {}; }
    try { order.billing = JSON.parse(order.billing_json || "{}"); } catch { order.billing = {}; }
    delete order.shipping_json;
    delete order.billing_json;
  }
  return json(orders);
}

// ======================================================
// PRODUCTS (EXISTING SYSTEM - KEPT INTACT)
// ======================================================

function cleanProduct(body, existingId = "") {
  const id = existingId || String(body.id || body.name || "")
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!id || !String(body.name || "").trim()) throw new Error("Product name is required.");
  return {
    id,
    name: String(body.name).trim(),
    category: String(body.category || "Research Compounds").trim(),
    description: String(body.description || "").trim(),
    cost: Math.max(0, Number(body.cost || 0)),
    price: Math.max(0, Number(body.price || 0)),
    quantity: Math.max(0, Math.floor(Number(body.quantity || 0))),
    low_stock: Math.max(0, Math.floor(Number(body.low_stock ?? body.lowStock ?? 5))),
    active: body.active === false || body.active === 0 ? 0 : 1,
    image_url: String(body.image_url ?? body.image ?? "").trim()
  };
}

async function listProducts(env) {
  const result = await env.DB.prepare(`SELECT id,name,category,description,cost,price,quantity,low_stock,active,image_url,updated_at FROM products ORDER BY name`).all();
  return json(result.results || []);
}

async function createProduct(request, env) {
  try {
    const p = cleanProduct(await request.json());
    await env.DB.prepare(`INSERT INTO products (id,name,category,description,cost,price,quantity,low_stock,active,image_url,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
      .bind(p.id,p.name,p.category,p.description,p.cost,p.price,p.quantity,p.low_stock,p.active,p.image_url).run();
    return json({ ok: true, product: p }, 201);
  } catch (e) { return json({ ok: false, error: e.message }, 400); }
}

async function updateProduct(id, request, env) {
  try {
    const p = cleanProduct(await request.json(), id);
    const result = await env.DB.prepare(`UPDATE products SET name=?,category=?,description=?,cost=?,price=?,quantity=?,low_stock=?,active=?,image_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(p.name,p.category,p.description,p.cost,p.price,p.quantity,p.low_stock,p.active,p.image_url,id).run();
    if (!result.meta?.changes) return json({ ok: false, error: "Product not found." }, 404);
    return json({ ok: true, product: p });
  } catch (e) { return json({ ok: false, error: e.message }, 400); }
}

async function deleteProduct(id, env) {
  const result = await env.DB.prepare("DELETE FROM products WHERE id=?").bind(id).run();
  return json({ ok: true, deleted: result.meta?.changes || 0 });
}

// ======================================================
// COA MANAGER (EXISTING SYSTEM - KEPT INTACT)
// ======================================================

async function ensureCoaTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS coas (
    id TEXT PRIMARY KEY,
    product_name TEXT NOT NULL,
    batch_lot TEXT NOT NULL,
    lab TEXT DEFAULT '',
    test_date TEXT DEFAULT '',
    file_key TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content_type TEXT DEFAULT 'application/octet-stream',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
}

async function listCoas(request, env) {
  await ensureCoaTable(env);
  const admin = isAdmin(request, env);
  const result = admin
    ? await env.DB.prepare(`SELECT * FROM coas ORDER BY created_at DESC`).all()
    : await env.DB.prepare(`SELECT * FROM coas WHERE active = 1 ORDER BY created_at DESC`).all();
  return json(result.results || []);
}

async function uploadCoa(request, env) {
  if (!isAdmin(request, env)) return unauthorized();
  if (!env.COA_BUCKET) return json({ ok: false, error: "R2 binding COA_BUCKET is not connected." }, 503);
  await ensureCoaTable(env);
  try {
    const form = await request.formData();
    const productName = String(form.get("product_name") || "").trim();
    const batchLot = String(form.get("batch_lot") || "").trim();
    const lab = String(form.get("lab") || "").trim();
    const testDate = String(form.get("test_date") || "").trim();
    const active = String(form.get("active") || "1") === "1" ? 1 : 0;
    const file = form.get("file");
    if (!productName) throw new Error("Product is required.");
    if (!batchLot) throw new Error("Batch / Lot number is required.");
    if (!(file instanceof File)) throw new Error("Please choose a COA PDF or image.");
    const allowed = file.type === "application/pdf" || file.type.startsWith("image/");
    if (!allowed) throw new Error("Only PDF or image files are allowed.");
    if (file.size > 10 * 1024 * 1024) throw new Error("COA file must be 10 MB or smaller.");
    const id = crypto.randomUUID();
    const safeName = file.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    const fileKey = `coas/${id}/${safeName}`;
    await env.COA_BUCKET.put(fileKey, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
    try {
      await env.DB.prepare(`INSERT INTO coas (id,product_name,batch_lot,lab,test_date,file_key,file_name,content_type,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
        .bind(id,productName,batchLot,lab,testDate,fileKey,file.name,file.type || "application/octet-stream",active).run();
    } catch (e) { await env.COA_BUCKET.delete(fileKey); throw e; }
    return json({ ok: true, id }, 201);
  } catch (e) { return json({ ok: false, error: e.message }, 400); }
}

async function getCoaFile(id, env) {
  await ensureCoaTable(env);
  if (!env.COA_BUCKET) return new Response("COA storage is not connected.", { status: 503 });
  const coa = await env.DB.prepare(`SELECT file_key,file_name,content_type,active FROM coas WHERE id=?`).bind(id).first();
  if (!coa) return new Response("COA not found.", { status: 404 });
  const object = await env.COA_BUCKET.get(coa.file_key);
  if (!object) return new Response("COA file not found.", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", coa.content_type || "application/pdf");
  const safeName = String(coa.file_name || "coa.pdf").replace(/"/g, "");
  headers.set("content-disposition", `inline; filename="${safeName}"`);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=300");
  return new Response(object.body, { status: 200, headers });
}

async function deleteCoa(id, request, env) {
  if (!isAdmin(request, env)) return unauthorized();
  await ensureCoaTable(env);
  const coa = await env.DB.prepare(`SELECT file_key FROM coas WHERE id=?`).bind(id).first();
  if (!coa) return json({ ok: false, error: "COA not found." }, 404);
  if (env.COA_BUCKET && coa.file_key) await env.COA_BUCKET.delete(coa.file_key);
  await env.DB.prepare(`DELETE FROM coas WHERE id=?`).bind(id).run();
  return json({ ok: true });
}

// ======================================================
// WORKER
// ======================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      // PROTECTED ADMIN PAGE
      if (url.pathname === "/admin" || url.pathname === "/admin/" || url.pathname === "/admin.html") {
        if (!isAdmin(request, env)) return unauthorized();
        return env.ASSETS.fetch(request);
      }

      if (url.pathname === "/api/health") return json({ ok: true, worker: "twilight-paper-5e36" });

      // CUSTOMER AUTH / ACCOUNT
      if (url.pathname === "/api/auth/register" && request.method === "POST") return await registerCustomer(request, env);
      if (url.pathname === "/api/auth/login" && request.method === "POST") return await loginCustomer(request, env);
      if (url.pathname === "/api/auth/logout" && request.method === "POST") return await logoutCustomer(request, env);
      if (url.pathname === "/api/auth/me" && request.method === "GET") return await accountMe(request, env);

      if (url.pathname === "/api/addresses") {
        if (request.method === "GET") return await listAddresses(request, env);
        if (request.method === "POST") return await saveAddress(request, env);
        return json({ ok: false, error: "Method not allowed." }, 405);
      }
      if (url.pathname.startsWith("/api/addresses/") && request.method === "DELETE") {
        return await deleteAddress(decodeURIComponent(url.pathname.slice("/api/addresses/".length)), request, env);
      }
      if (url.pathname === "/api/orders") {
        if (request.method === "GET") return await listOrders(request, env);
        if (request.method === "POST") return await createOrder(request, env);
        return json({ ok: false, error: "Method not allowed." }, 405);
      }

      // ADMIN ORDERS (read-only until live payment processing is connected)
      if (url.pathname === "/api/admin/orders" && request.method === "GET") {
        return await listAdminOrders(request, env);
      }

      // PRODUCTS
      if (url.pathname === "/api/products") {
        if (!env.DB) return json({ ok: false, error: "D1 binding DB is not connected yet." }, 503);
        if (request.method === "GET") return listProducts(env);
        if (request.method === "POST") {
          if (!isAdmin(request, env)) return unauthorized();
          return createProduct(request, env);
        }
        return json({ ok: false, error: "Method not allowed." }, 405);
      }
      if (url.pathname.startsWith("/api/products/")) {
        if (!env.DB) return json({ ok: false, error: "D1 binding DB is not connected yet." }, 503);
        if (!isAdmin(request, env)) return unauthorized();
        const id = decodeURIComponent(url.pathname.slice("/api/products/".length));
        if (!id) return json({ ok: false, error: "Product id required." }, 400);
        if (request.method === "PUT") return updateProduct(id, request, env);
        if (request.method === "DELETE") return deleteProduct(id, env);
        return json({ ok: false, error: "Method not allowed." }, 405);
      }

      // COAs
      if (url.pathname === "/api/coas") {
        if (!env.DB) return json({ ok: false, error: "D1 binding DB is not connected." }, 503);
        if (request.method === "GET") return listCoas(request, env);
        if (request.method === "POST") return uploadCoa(request, env);
        return json({ ok: false, error: "Method not allowed." }, 405);
      }
      if (url.pathname.startsWith("/api/coas/") && url.pathname.endsWith("/file")) {
        const id = decodeURIComponent(url.pathname.slice("/api/coas/".length).slice(0, -"/file".length));
        return getCoaFile(id, env);
      }
      if (url.pathname.startsWith("/api/coas/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/coas/".length));
        if (!id) return json({ ok: false, error: "COA id required." }, 400);
        if (request.method === "DELETE") return deleteCoa(id, request, env);
        return json({ ok: false, error: "Method not allowed." }, 405);
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      const status = Number(e.status || 400);
      return json({ ok: false, error: e.message || "Request failed." }, status >= 400 && status < 600 ? status : 400);
    }
  }
};
