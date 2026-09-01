# Car Tracker

Track the vehicles you own now and have owned in the past: maintenance history,
fuel economy, and reminder emails for upcoming service — based on a date
interval, a mileage interval, whichever comes first, or a one-time date.

## Stack

- **Backend**: Node.js + TypeScript, Express, PostgreSQL via Prisma
- **Frontend**: React + Vite + Tailwind CSS, React Router
- **Auth**: email + password, with mandatory TOTP two-factor authentication
  on every account (no accounts without 2FA)
- **Encryption**: sensitive fields (VIN, license plate, notes, vendor, cost,
  TOTP secret) are encrypted at rest with a per-account data key
- **Email**: pluggable — SMTP or Resend, configured via environment variables
- **Deployment**: Docker Compose (Postgres + API server + static frontend
  behind nginx)

## Security model

- **Passwords**: hashed with Argon2id.
- **2FA**: TOTP (RFC 6238) is required to finish account setup — there is no
  way to use the app without it. 10 single-use backup codes are issued once,
  at enrollment, for account recovery if you lose your authenticator.
- **Sessions**: short-lived JWT access tokens (15 min, kept in memory in the
  browser tab) plus a rotating refresh token in an `HttpOnly`, `SameSite=Lax`
  cookie. Each refresh rotates the token and revokes the old one.
- **Per-account encryption**: at signup, each account gets a random 256-bit
  data key. That key is used to encrypt sensitive fields (VIN, license plate,
  vehicle notes, maintenance vendor/notes/cost, fuel-log notes, the TOTP
  secret) with AES-256-GCM before they're written to the database. The data
  key itself is "wrapped" (encrypted) with a single server-wide
  `MASTER_ENCRYPTION_KEY` and stored alongside the account.

  **What this protects against:** someone who obtains a copy of the database
  alone (a stolen backup, a leaked disk snapshot) cannot read any account's
  sensitive fields without also having the master key. Each account's data is
  encrypted independently, so a compromise of one account's key (which never
  happens in normal operation — it's never exposed to the account itself)
  wouldn't expose others.

  **What this does *not* protect against:** the application server, since it
  holds the master key, can decrypt any account's data — this is an envelope
  encryption model, not a zero-knowledge one. If you need the server itself
  to be unable to read your data, that requires a different architecture
  (client-side encryption with a key derived from your password, never sent
  to the server) — a reasonable future enhancement, not implemented here.

  **Losing `MASTER_ENCRYPTION_KEY` permanently destroys access to every
  account's encrypted fields.** Back it up somewhere safe and separate from
  your database backups.

- **Backups**: the in-app "Export a backup" feature (Settings page) produces
  a single file containing all of an account's vehicles, maintenance, fuel,
  and reminder data, encrypted with a passphrase you choose at export time
  (scrypt-derived key, AES-256-GCM). This is separate from the account's
  server-side encryption key, so you can safely store backup files anywhere
  (cloud storage, email to yourself, etc.) — they're only readable with the
  passphrase. "Restore a backup" decrypts and re-imports a file, **replacing**
  all vehicles/history currently in the signed-in account.

## Local development

Requires Node.js 22+ and a PostgreSQL 16 database.

```bash
# 1. Start Postgres however you like, then create a database, e.g.:
createdb car_tracker

# 2. Backend
cd server
npm install
# Create server/.env with at least:
#   DATABASE_URL=postgresql://<user>:<password>@localhost:5432/car_tracker
#   MASTER_ENCRYPTION_KEY=<openssl rand -base64 32>
#   JWT_ACCESS_SECRET=<openssl rand -base64 48>
#   JWT_REFRESH_SECRET=<openssl rand -base64 48>
#   MAIL_PROVIDER=none
# (see .env.example at the repo root for the full list of variables)
npx prisma db push
npm run dev             # http://localhost:4000

# 3. Frontend (separate terminal)
cd client
npm install
npm run dev              # http://localhost:5173, proxies /api to :4000
```

Register an account, scan the QR code with an authenticator app (Google
Authenticator, 1Password, Authy, etc.) to finish 2FA setup, then sign in.

## Production deployment (Docker Compose)

This mirrors the deployment style of the author's other self-hosted apps:
a `docker-compose.yml` at the repo root, one `.env` file for secrets, and
named volumes for persistent data.

```bash
cp .env.example .env
```

Fill in `.env`:

- `POSTGRES_PASSWORD` — any strong password.
- `MASTER_ENCRYPTION_KEY` — generate with `openssl rand -base64 32`. **Back
  this up separately from your database backups** (see Security model above).
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — generate each with
  `openssl rand -base64 48`.
- `APP_URL` / `HTTP_PORT` — adjust if you're putting this behind your own
  reverse proxy (Traefik, Nginx Proxy Manager, Caddy) with a real domain and
  TLS. Point your reverse proxy at the `client` container's port 80, or at
  `HTTP_PORT` on the host if you're not using one.
- `COOKIE_SECURE` — leave `true` in any real deployment (requires HTTPS,
  which your reverse proxy should be terminating). Only set to `false` for
  plain-HTTP local testing.
- Mail settings — see "Reminder emails" below. Leave `MAIL_PROVIDER=none` to
  disable email sending (reminders still show up in the dashboard).

Then:

```bash
docker compose up -d --build
```

This starts three containers:

- `db` — PostgreSQL 16, data persisted in the `car_tracker_db` volume.
- `server` — the API. On startup it runs `prisma db push` to sync the
  database schema, then starts the Express server, including the daily
  reminder-check cron job.
- `client` — the built React app served by nginx, which also reverse-proxies
  `/api/*` to the `server` container so the browser only ever talks to one
  origin.

Visit `http://<your-host>:${HTTP_PORT}` (default `8080`) — or your reverse
proxy's domain, if you've set one up in front of it.

### Upgrading

```bash
git pull
docker compose up -d --build
```

Schema changes are applied automatically on `server` startup via
`prisma db push`. This project doesn't yet use versioned Prisma migrations
(`prisma migrate`) — for a single-admin self-hosted app `db push` is simpler
to operate, but it means schema changes are inferred from the current
`prisma/schema.prisma` rather than recorded as an explicit history. If that
becomes a concern (e.g. multiple environments, need for rollback), switching
to `prisma migrate deploy` is a natural follow-up.

### Backing up the database

Beyond the in-app per-account export (Settings page), back up the whole
Postgres volume regularly, e.g.:

```bash
docker compose exec db pg_dump -U car_tracker car_tracker > backup.sql
```

Store `MASTER_ENCRYPTION_KEY` (from your `.env`) alongside these backups —
without it, a restored database's encrypted fields (VINs, notes, costs, TOTP
secrets) are unreadable.

## Reminder emails

Reminders are evaluated once a day (`REMINDER_CRON`, default 8am UTC) against
every active reminder rule. A rule can trigger on:

- **A date interval** — e.g. every 180 days since the last time it was marked
  done (or since the rule was created, if never done).
- **A mileage interval** — e.g. every 5,000 miles since the last completion,
  compared against your most recent odometer reading (from a fuel log,
  maintenance entry, or manual entry).
- **Whichever comes first** — evaluates both and fires on the earlier one.
- **A one-time date** — a fixed future date (e.g. registration renewal),
  independent of any interval.

Each rule has its own lead time (days and/or miles) controlling how far in
advance of the due point it should start showing up as due and trigger an
email. An email is sent once per due period; marking the reminder "done" (or
logging matching maintenance) resets the interval for next time.

To actually send emails, set in `.env`:

- `MAIL_PROVIDER=smtp` and the `SMTP_*` variables for your mail provider or
  relay, **or**
- `MAIL_PROVIDER=resend` and `RESEND_API_KEY` for
  [Resend](https://resend.com).

With `MAIL_PROVIDER=none`, due reminders still appear on the dashboard —
nothing is emailed.

## Project structure

```
server/            Express + Prisma API
  prisma/schema.prisma
  src/
    auth/           password hashing, TOTP, JWT/session helpers
    crypto/         per-account field encryption, backup-file encryption
    middleware/      auth middleware
    routes/          REST endpoints
    services/        reminder evaluation, cron scheduler, mailer
client/            React + Vite + Tailwind frontend
  src/
    api/             fetch client, auth context, types
    components/ui/    small shadcn-style UI primitives
    pages/           route-level pages
docker-compose.yml
.env.example
```
