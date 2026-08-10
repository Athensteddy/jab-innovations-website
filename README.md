# JAB Innovations — Corrected Cloudflare Worker Build

This package corrects the earlier Pages-style build. It is a real Cloudflare Worker
with static assets plus API routes.

Worker name: twilight-paper-5e36
Static assets: ./public
Worker entry: worker.js
API routes: /api/products and /api/products/:id

IMPORTANT:
The existing D1 database is intentionally NOT hard-coded in wrangler.toml.
After this Worker is deployed, add the dashboard binding:
  Variable name: DB
  D1 database: jab-innovations-db

That avoids creating a second database and lets the existing database/table be reused. Deployment trigger
