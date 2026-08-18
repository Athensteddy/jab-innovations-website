# JAB Innovations Customer Checkout Upgrade

## Added in this build

- Customer registration and sign-in using D1.
- PBKDF2-SHA256 password hashing with per-user random salts.
- HttpOnly, Secure, SameSite=Lax customer session cookies.
- Saved shipping/billing addresses.
- Persistent cart handoff from the live catalog to checkout.
- Server-side product price, active-state, and inventory validation at order creation.
- Customer order history.
- Additive D1 tables for customers, sessions, addresses, orders, and order items.
- Existing products, admin, COA D1/R2, and catalog APIs retained.

## Payment status

Orders are currently created as:

- status: pending_payment
- payment_status: not_configured

Inventory is intentionally NOT reduced at this stage. Inventory should only be reduced after a payment provider confirms successful payment.

Stripe's current published guidance says it can support many peptide businesses and can support research-purpose peptides when appropriate preventive measures are in place, subject to review. Do not add live Stripe keys until JAB's Stripe merchant account has been reviewed/approved for the actual product catalog and business model.

## New customer routes

- POST /api/auth/register
- POST /api/auth/login
- POST /api/auth/logout
- GET /api/auth/me
- GET /api/addresses
- POST /api/addresses
- DELETE /api/addresses/:id
- GET /api/orders
- POST /api/orders

## New pages

- /account.html
- /checkout.html

## Deployment

The Worker creates the new customer/order tables lazily on the first account request. `schema.sql` also contains the complete additive schema so it can be applied explicitly if desired.

No existing products or COA tables are renamed or replaced.
