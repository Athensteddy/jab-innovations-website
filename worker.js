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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Protect the Admin page itself.
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

    // Simple Worker status check.
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        worker: "twilight-paper-5e36"
      });
    }

    // Public catalog can READ products.
    // Adding products requires Admin login.
    if (url.pathname === "/api/products") {
      if (!env.DB) {
        return json(
          {
            ok: false,
            error: "D1 binding DB is not connected yet."
          },
          503
        );
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

      return json(
        {
          ok: false,
          error: "Method not allowed."
        },
        405
      );
    }

    // Changing or deleting individual products requires Admin login.
    if (url.pathname.startsWith("/api/products/")) {
      if (!env.DB) {
        return json(
          {
            ok: false,
            error: "D1 binding DB is not connected yet."
          },
          503
        );
      }

      if (!isAdmin(request, env)) {
        return unauthorized();
      }

      const id = decodeURIComponent(
        url.pathname.slice("/api/products/".length)
      );

      if (!id) {
        return json(
          {
            ok: false,
            error: "Product id required."
          },
          400
        );
      }

      if (request.method === "PUT") {
        return updateProduct(id, request, env);
      }

      if (request.method === "DELETE") {
        return deleteProduct(id, env);
      }

      return json(
        {
          ok: false,
          error: "Method not allowed."
        },
        405
      );
    }

    // Everything else remains public.
    return env.ASSETS.fetch(request);
  }
};
