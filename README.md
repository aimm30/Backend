# Kanjirowa Mart — backend

This is the missing piece your storefront (`index.html`) was already built to
talk to. It fixes exactly the three problems you described:

1. **One account per email, enforced on the server.** Signing up checks a
   shared database, not the browser you're using — so the same email (or the
   same Gmail address written with dots/a `+alias`, which Gmail treats as
   identical) can only ever have one account, on any device.
2. **Same password everywhere**, because the password (hashed, never stored
   in plain text) lives in that same shared database, not in each browser's
   local storage.
3. **Admin dashboard shows every device's signups and orders**, because it
   reads from that same shared database too.

Your `index.html` does not need to change. It already detects this backend
automatically (`checkBackendHealth()`) and switches from "local demo mode"
to "connected mode" the moment it can reach this server.

## Run it locally

You'll need [Node.js](https://nodejs.org) 18 or newer installed.

```bash
cd backend
npm install
cp .env.example .env
npm start
```

You should see:

```
[kanjimart backend] listening on port 3000
[kanjimart backend] admin email: aimloqris@gmail.com
[kanjimart backend] SMTP configured: false
```

Now open `index.html` in your browser (as a file, or via a local web server —
either works). Since it's on `localhost`, it will automatically look for the
backend at `http://localhost:3000/api` and connect to it. Try signing up —
because `EXPOSE_DEV_CODE=true` in `.env.example`, the verification code will
be shown directly in the browser toast/banner so you don't need real email
set up yet.

The database is a single file at `backend/data/kanjimart.db` (SQLite — no
separate database server to install or pay for).

## Setting up real email (required before going live)

Right now, without SMTP configured, verification and password-reset codes
are only logged to the server's console — real customers won't receive
anything. To fix that, fill in the `SMTP_*` values in `.env`:

- **Easiest option (Gmail):** set `SMTP_USER` to your Gmail address and
  `SMTP_PASS` to a Gmail **App Password** (Google Account → Security →
  2-Step Verification → App passwords) — not your normal Gmail password.
- Any other provider (SendGrid, Mailgun, Zoho, your web host's SMTP, etc.)
  works too — just fill in `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`.

Once real SMTP is set, set `EXPOSE_DEV_CODE=false` in `.env` — otherwise
verification codes would be visible in the browser's network traffic, which
defeats the point of emailing them.

## Deploying so every device can actually reach it

Running this only on your own laptop won't help customers on other devices —
it needs to live on a server that's reachable over the internet. A few
beginner-friendly options that all support Node.js + a persistent disk (for
the SQLite file) on a free or cheap tier:

- **Render.com** — connect your GitHub repo, "New Web Service", build
  command `npm install`, start command `npm start`, add a small persistent
  disk mounted at `/opt/render/project/src/backend/data` (or set `DB_PATH`
  to wherever the disk is mounted), and add your `.env` values under
  "Environment".
- **Railway.app** — similar flow; add a volume for the `data/` folder.
- Any VPS (DigitalOcean, a Hetzner box, etc.) — install Node, `git clone`,
  `npm install`, run it with a process manager like `pm2` so it restarts on
  crashes/reboots, and put it behind nginx with HTTPS (e.g. via
  [Certbot](https://certbot.eff.org/)).

Whichever you pick, once it's deployed you'll have a URL like
`https://kanjimart-backend.onrender.com`. Two things to set:

1. **In the backend's environment variables**, set
   `CORS_ORIGIN=https://your-storefront-domain.com` (the exact URL your
   `index.html` is hosted at) — this stops other websites from making
   authenticated requests using your customers' cookies.
2. **In `index.html`**, if the frontend and backend end up on *different*
   domains (e.g. storefront on Netlify, backend on Render), add one line
   near the top of the `<script>` block, before anything else runs:
   ```html
   <script>window.KANJIMART_API_BASE = 'https://kanjimart-backend.onrender.com/api';</script>
   ```
   If instead you serve `index.html` from the *same* domain/server as this
   backend (e.g. Express serving both), you can skip this — the frontend
   already defaults to `/api` on a relative path in that case.

## API summary

All routes are prefixed with `/api` and return JSON. Session/login state is
kept in an HTTP-only cookie (`credentials: 'include'`, already set up in the
frontend) — there's nothing to wire up on the client side.

| Method | Path | Purpose |
|---|---|---|
| GET | /health | Used by the frontend to detect the backend is reachable |
| GET | /products | Product catalog |
| GET | /categories | Category counts |
| POST | /auth/signup | Start signup, sends a 6-digit code |
| POST | /auth/resend-verification | Resend the signup code |
| POST | /auth/verify | Confirm the code, creates the session |
| POST | /auth/login | Log in (any device, same password) |
| POST | /auth/logout | Clear the session |
| GET | /auth/me | Current logged-in user |
| POST | /auth/forgot-password | Send a password-reset code |
| POST | /auth/reset-password | Set a new password with that code |
| GET | /orders | The logged-in customer's own orders |
| POST | /orders | Place an order (prices re-checked server-side) |
| GET | /admin/dashboard | All orders + all customers, admin-only |

## A note on the demo product catalog

`backend/seed-products.json` is a one-time copy of the 150 demo products
already built into `index.html`, so `/products` has something to show the
first time you run the server. Once you have real products, add an admin
route (or edit the `products` table directly) to manage them — that wasn't
part of what you asked for here, so it isn't included yet, but it's a
natural next step now that there's a real database to store them in.
