function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
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
// PRODUCTS
// ======================================================

function cleanProduct(body, existingId = "") {
  const id = existingId || String(body.id || body.name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  if (!id || !String(body.name || "").trim()) {
    throw new Error("Product name is required.");
  }

  return {
    id,
    name: String(body.name).trim(),
    category: String(body.category || "Research Compounds").trim(),
    description: String(body.description || "").trim(),
    cost: Math.max(0, Number(body.cost || 0)),
    price: Math.max(0, Number(body.price || 0)),
    quantity: Math.max(0, Math.floor(Number(body.quantity || 0))),
    low_stock: Math.max(
      0,
      Math.floor(Number(body.low_stock ?? body.lowStock ?? 5))
    ),
    active: body.active === false || body.active === 0 ? 0 : 1,
    image_url: String(body.image_url ?? body.image ?? "").trim()
  };
}

async function listProducts(env) {
  const result = await env.DB.prepare(
    `SELECT
      id,
      name,
      category,
      description,
      cost,
      price,
      quantity,
      low_stock,
      active,
      image_url,
      updated_at
    FROM products
    ORDER BY name`
  ).all();

  return json(result.results || []);
}

async function createProduct(request, env) {
  try {
    const p = cleanProduct(await request.json());

    await env.DB.prepare(
      `INSERT INTO products
      (
        id,
        name,
        category,
        description,
        cost,
        price,
        quantity,
        low_stock,
        active,
        image_url,
        updated_at
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`
    )
      .bind(
        p.id,
        p.name,
        p.category,
        p.description,
        p.cost,
        p.price,
        p.quantity,
        p.low_stock,
        p.active,
        p.image_url
      )
      .run();

    return json({ ok: true, product: p }, 201);
  } catch (e) {
    return json({ ok: false, error: e.message }, 400);
  }
}

async function updateProduct(id, request, env) {
  try {
    const p = cleanProduct(await request.json(), id);

    const result = await env.DB.prepare(
      `UPDATE products SET
        name=?,
        category=?,
        description=?,
        cost=?,
        price=?,
        quantity=?,
        low_stock=?,
        active=?,
        image_url=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?`
    )
      .bind(
        p.name,
        p.category,
        p.description,
        p.cost,
        p.price,
        p.quantity,
        p.low_stock,
        p.active,
        p.image_url,
        id
      )
      .run();

    if (!result.meta?.changes) {
      return json({ ok: false, error: "Product not found." }, 404);
    }

    return json({ ok: true, product: p });
  } catch (e) {
    return json({ ok: false, error: e.message }, 400);
  }
}

async function deleteProduct(id, env) {
  const result = await env.DB
    .prepare("DELETE FROM products WHERE id=?")
    .bind(id)
    .run();

  return json({
    ok: true,
    deleted: result.meta?.changes || 0
  });
}


// ======================================================
// COA MANAGER
// ======================================================

async function ensureCoaTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS coas (
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
    )
  `).run();
}

async function listCoas(request, env) {
  await ensureCoaTable(env);

  const admin = isAdmin(request, env);

  const result = admin
    ? await env.DB.prepare(`
        SELECT *
        FROM coas
        ORDER BY created_at DESC
      `).all()
    : await env.DB.prepare(`
        SELECT *
        FROM coas
        WHERE active = 1
        ORDER BY created_at DESC
      `).all();

  return json(result.results || []);
}

async function uploadCoa(request, env) {
  if (!isAdmin(request, env)) {
    return unauthorized();
  }

  if (!env.COA_BUCKET) {
    return json({
      ok: false,
      error: "R2 binding COA_BUCKET is not connected."
    }, 503);
  }

  await ensureCoaTable(env);

  try {
    const form = await request.formData();

    const productName = String(form.get("product_name") || "").trim();
    const batchLot = String(form.get("batch_lot") || "").trim();
    const lab = String(form.get("lab") || "").trim();
    const testDate = String(form.get("test_date") || "").trim();
    const active = String(form.get("active") || "1") === "1" ? 1 : 0;
    const file = form.get("file");

    if (!productName) {
      throw new Error("Product is required.");
    }

    if (!batchLot) {
      throw new Error("Batch / Lot number is required.");
    }

    if (!(file instanceof File)) {
      throw new Error("Please choose a COA PDF or image.");
    }

    const allowed =
      file.type === "application/pdf" ||
      file.type.startsWith("image/");

    if (!allowed) {
      throw new Error("Only PDF or image files are allowed.");
    }

    if (file.size > 10 * 1024 * 1024) {
      throw new Error("COA file must be 10 MB or smaller.");
    }

    const id = crypto.randomUUID();

    const safeName = file.name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-");

    const fileKey = `coas/${id}/${safeName}`;

    await env.COA_BUCKET.put(
      fileKey,
      file.stream(),
      {
        httpMetadata: {
          contentType: file.type || "application/octet-stream"
        }
      }
    );

    try {
      await env.DB.prepare(`
        INSERT INTO coas
        (
          id,
          product_name,
          batch_lot,
          lab,
          test_date,
          file_key,
          file_name,
          content_type,
          active,
          created_at
        )
        VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      `)
        .bind(
          id,
          productName,
          batchLot,
          lab,
          testDate,
          fileKey,
          file.name,
          file.type || "application/octet-stream",
          active
        )
        .run();

    } catch (e) {
      await env.COA_BUCKET.delete(fileKey);
      throw e;
    }

    return json({
      ok: true,
      id
    }, 201);

  } catch (e) {
    return json({
      ok: false,
      error: e.message
    }, 400);
  }
}

async function getCoaFile(id, env) {
  await ensureCoaTable(env);

  if (!env.COA_BUCKET) {
    return new Response("COA storage is not connected.", {
      status: 503
    });
  }

  const coa = await env.DB.prepare(`
    SELECT
      file_key,
      file_name,
      content_type,
      active
    FROM coas
    WHERE id = ?
  `)
    .bind(id)
    .first();

  if (!coa) {
    return new Response("COA not found.", {
      status: 404
    });
  }

  const object = await env.COA_BUCKET.get(coa.file_key);

  if (!object) {
    return new Response("COA file not found.", {
      status: 404
    });
  }

  const headers = new Headers();

  object.writeHttpMetadata(headers);

  headers.set(
    "content-type",
    coa.content_type || "application/pdf"
  );

  const safeName = String(coa.file_name || "coa.pdf")
    .replace(/"/g, "");

  headers.set(
    "content-disposition",
    `inline; filename="${safeName}"`
  );

  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=300");

  return new Response(object.body, {
    status: 200,
    headers
  });
}
  const object = await env.COA_BUCKET.get(coa.file_key);

  if (!object) {
    return new Response("COA file not found.", {
      status: 404
    });
  }

  const headers = new Headers();

  headers.set(
    "content-type",
    coa.content_type || "application/octet-stream"
  );

  headers.set(
    "content-disposition",
    `inline; filename="${String(coa.file_name || "coa").replace(/"/g, "")}"`
  );

  headers.set("cache-control", "private, max-age=300");

  return new Response(object.body, {
    headers
  });
}

async function deleteCoa(id, request, env) {
  if (!isAdmin(request, env)) {
    return unauthorized();
  }

  await ensureCoaTable(env);

  const coa = await env.DB.prepare(`
    SELECT file_key
    FROM coas
    WHERE id = ?
  `)
    .bind(id)
    .first();

  if (!coa) {
    return json({
      ok: false,
      error: "COA not found."
    }, 404);
  }

  if (env.COA_BUCKET && coa.file_key) {
    await env.COA_BUCKET.delete(coa.file_key);
  }

  await env.DB.prepare(`
    DELETE FROM coas
    WHERE id = ?
  `)
    .bind(id)
    .run();

  return json({
    ok: true
  });
}


// ======================================================
// WORKER
// ======================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);


    // --------------------------------------------------
    // PROTECTED ADMIN PAGE
    // --------------------------------------------------

    if (
      url.pathname === "/admin" ||
      url.pathname === "/admin/" ||
      url.pathname === "/admin.html"
    ) {
      if (!isAdmin(request, env)) {
        return unauthorized();
      }

      return env.ASSETS.fetch(request);
    }


    // --------------------------------------------------
    // HEALTH
    // --------------------------------------------------

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        worker: "twilight-paper-5e36"
      });
    }


    // --------------------------------------------------
    // PRODUCTS
    // --------------------------------------------------

    if (url.pathname === "/api/products") {
      if (!env.DB) {
        return json({
          ok: false,
          error: "D1 binding DB is not connected yet."
        }, 503);
      }

      if (request.method === "GET") {
        return listProducts(env);
      }

      if (request.method === "POST") {
        if (!isAdmin(request, env)) {
          return unauthorized();
        }

        return createProduct(request, env);
      }

      return json({
        ok: false,
        error: "Method not allowed."
      }, 405);
    }


    if (url.pathname.startsWith("/api/products/")) {
      if (!env.DB) {
        return json({
          ok: false,
          error: "D1 binding DB is not connected yet."
        }, 503);
      }

      if (!isAdmin(request, env)) {
        return unauthorized();
      }

      const id = decodeURIComponent(
        url.pathname.slice("/api/products/".length)
      );

      if (!id) {
        return json({
          ok: false,
          error: "Product id required."
        }, 400);
      }

      if (request.method === "PUT") {
        return updateProduct(id, request, env);
      }

      if (request.method === "DELETE") {
        return deleteProduct(id, env);
      }

      return json({
        ok: false,
        error: "Method not allowed."
      }, 405);
    }


    // --------------------------------------------------
    // COAs
    // --------------------------------------------------

    if (url.pathname === "/api/coas") {
      if (!env.DB) {
        return json({
          ok: false,
          error: "D1 binding DB is not connected."
        }, 503);
      }

      if (request.method === "GET") {
        return listCoas(request, env);
      }

      if (request.method === "POST") {
        return uploadCoa(request, env);
      }

      return json({
        ok: false,
        error: "Method not allowed."
      }, 405);
    }


    if (
      url.pathname.startsWith("/api/coas/") &&
      url.pathname.endsWith("/file")
    ) {
      const id = decodeURIComponent(
        url.pathname
          .slice("/api/coas/".length)
          .slice(0, -"/file".length)
      );

      return getCoaFile(id, env);
    }


    if (url.pathname.startsWith("/api/coas/")) {
      const id = decodeURIComponent(
        url.pathname.slice("/api/coas/".length)
      );

      if (!id) {
        return json({
          ok: false,
          error: "COA id required."
        }, 400);
      }

      if (request.method === "DELETE") {
        return deleteCoa(id, request, env);
      }

      return json({
        ok: false,
        error: "Method not allowed."
      }, 405);
    }


    // --------------------------------------------------
    // STATIC SITE
    // --------------------------------------------------

    return env.ASSETS.fetch(request);
  }
};
