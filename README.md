# Car Tracker

Track the vehicles you own now and have owned in the past: maintenance history,
fuel economy, and reminder emails for upcoming service — based on a date
interval, a mileage interval, whichever comes first, or a one-time date.

## Stack

- **Backend**: Node.js + TypeScript, Express, PostgreSQL via Prisma
- **Frontend**: React + Vite + Tailwind CSS, React Router, Web Crypto API
- **Auth**: email + password, with mandatory TOTP two-factor authentication
  on every account (no accounts without 2FA)
- **Encryption**: zero-knowledge, client-side. Sensitive fields (VIN, license
  plate, notes, vendor, cost) are encrypted and decrypted in the browser with
  a key the server never has — see Security model below.
- **Email**: pluggable — SMTP or Resend, configured via environment variables
- **Deployment**: Docker Compose (Postgres + API server + static frontend
  behind nginx)

## Security model

This app is built so that **the server cannot decrypt your vehicle data,
under any circumstances** — not with database access, not with its
environment variables, not with its source code. That's a deliberate,
significant constraint, and it shapes several things below that would
otherwise be simpler. If you haven't worked with a zero-knowledge design
before, read this section in full before relying on it.

### The vault key

At signup, your browser (never the server) generates a random 256-bit AES
key — the **data key** — and uses it to encrypt every sensitive field (VIN,
license plate, vehicle notes, maintenance vendor/notes/cost, fuel-log notes)
with AES-256-GCM before it's ever sent over the network. The server only
ever stores and returns these opaque ciphertext blobs; it has no code path
that decrypts them (see `server/src/routes/vehicles.ts` etc. — there is
simply no cipher there to call). All of that crypto lives in
`client/src/crypto/vault.ts` and runs via the browser's Web Crypto API.

The data key itself needs to survive between logins without being stored in
recoverable plaintext anywhere, so it's **wrapped** (encrypted) two
different ways, both computed client-side at signup:

1. **By your password** — a key derived from your password via PBKDF2
   (600,000 iterations, SHA-256) plus a random salt. This is what unlocks
   the vault on every normal login.
2. **By a one-time recovery key** — a separate random 256-bit value, shown
   to you exactly once at signup and never stored anywhere (not by us, not
   in the database). It's your only way back in if you forget your
   password.

The server stores both wrapped copies (`vaultKeyWrappedByPassword`,
`vaultKeyWrappedByRecovery`) plus the salt. All three are useless without
the password or the recovery key — there is no field, function, or
environment variable on the server that can turn them back into the data
key.

**This means:**

- **Losing both your password and your recovery key permanently and
  irreversibly loses access to your data.** There is no "reset password and
  keep your data" support option — the whole point is that we cannot offer
  one. Save your recovery key somewhere durable (a password manager, printed
  and filed) the moment it's shown to you.
- **Your vault "locks" on every page refresh.** The data key lives only in
  browser memory for the current tab — never `localStorage`, never a
  cookie — so a refresh (or the access-token-refresh flow silently renewing
  your session) loses it. You'll see an "Unlock your vault" prompt asking
  for your password again; this is expected, not a bug, and requires no
  network round trip to resolve (the salt and wrapped key needed are already
  in hand from your session).
- **Changing your password isn't supported yet.** The recovery-key flow
  (Settings → "Forgot password?" from the login page) is currently the only
  way to rotate your password, and it revokes all of your sessions when it
  succeeds. A dedicated in-session "change password" flow is a natural
  follow-up, not yet built.

### What's deliberately *not* zero-knowledge

Two things are exceptions, both auth mechanics rather than your data:

- **The TOTP secret.** Verifying a 2FA code has to happen server-side,
  before you've done anything that could hand the server a decryption key —
  so the TOTP secret uses its own, separate server-controlled envelope (a
  random per-account key wrapped with the server's `MASTER_ENCRYPTION_KEY`),
  same as a conventional app. Losing `MASTER_ENCRYPTION_KEY` breaks
  everyone's 2FA (they'd need to re-enroll) but does **not** expose any
  vehicle data — the two encryption systems don't share key material.
- **Non-sensitive fields** (year, make, model, ownership status, dates,
  odometer readings, fuel quantity/cost, reminder rule names/intervals) are
  stored in plaintext, same as before. They're needed for filtering/sorting
  and aren't considered sensitive. Only the fields listed above under "The
  vault key" are encrypted.

### Sessions

Argon2id password hashing, short-lived JWT access tokens (15 min, kept in
memory in the browser tab) plus a rotating refresh token in an `HttpOnly`,
`SameSite=Lax` cookie. Each refresh rotates the token and revokes the old
one. 10 single-use TOTP backup codes are issued once, at 2FA enrollment.

### Backups

The in-app "Export a backup" feature (Settings page) runs **entirely in your
browser**: it fetches your already-encrypted vehicle/maintenance/fuel data
(the server never decrypts it to build the file), wraps your data key with a
passphrase you choose (fresh salt, same PBKDF2+AES-GCM scheme as above), and
bundles both into one downloadable file. The server is not involved in the
encryption at all — see `server/src/routes/backup.ts`, which just relays
your already-encrypted rows verbatim.

"Restore a backup" reverses this client-side: unwraps the file's data key
with the passphrase you enter, and re-encrypts every field with your
*current* account's data key before uploading (this also makes it possible,
in principle, to restore a backup into a different account than the one
that made it — the re-encryption step handles the key mismatch
transparently). Restoring **replaces** all vehicles/history currently in the
signed-in account.

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
- `MASTER_ENCRYPTION_KEY` — generate with `openssl rand -base64 32`. This
  protects only the TOTP secrets used for 2FA login, not vehicle data (which
  is zero-knowledge — see Security model above). Losing it means every
  account needs to re-enroll in 2FA, but no vehicle data is lost.
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

A `pg_dump` alone is enough to restore vehicle data — it's already
zero-knowledge ciphertext in the dump, unlockable by each account's own
password or recovery key, not by any server-held key. `MASTER_ENCRYPTION_KEY`
only needs to travel with the dump if you also want restored accounts' 2FA
(TOTP) to keep working without re-enrolling.

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

## Testing

Both apps have unit and integration test suites, run in CI (`.github/workflows/test.yml`)
on every push/PR and expected to stay green — please add or update tests
alongside any behavior change rather than after the fact.

**Server** (`server/`): Vitest + Supertest, against a real disposable PostgreSQL
database (never your dev/prod one).

```bash
cd server
createdb car_tracker_test   # once; or set TEST_DATABASE_URL to point elsewhere
npm test
```

- Unit tests live next to the code they test (`src/**/*.test.ts`): the TOTP
  envelope (an `AccountCipher`/master-key round trip, used only for the 2FA
  secret), the recovery-verifier constant-time comparison, and the reminder
  due/not-due logic for all four trigger types (pure function, driven by an
  explicit clock — no waiting on real time). Note there's no server-side
  "encrypt vehicle data" unit test to write — that logic doesn't exist here
  by design; see the client suite below.
- Integration tests live in `test/integration/*.test.ts` and drive the real
  Express app (`src/app.ts`) through Supertest: full register → 2FA enroll →
  login → verify → refresh → logout, the account-recovery flow end to end,
  cross-account ownership isolation on every resource, fuel-economy
  calculation, the reminder sweep end-to-end, and a full export → wipe →
  import round trip (including simulating a restore into a *different*
  account, which requires client-side re-encryption).
- **`test/helpers.ts` imports `client/src/crypto/vault.ts` directly** rather
  than reimplementing its own copy of the crypto. Server integration tests
  therefore act as a real "browser stand-in": they generate and wrap data
  keys, encrypt fields, and derive recovery proofs exactly as the frontend
  does, so the tests genuinely exercise the zero-knowledge protocol rather
  than a simplified version of it. If you change how the client wraps or
  encrypts something, these tests pick it up for free.
- `test/globalSetup.ts` pushes the current Prisma schema to the test database
  once before the run; `test/resetDb.ts` truncates all tables between tests
  so each test starts clean. Tests run serially (`fileParallelism: false`)
  since they share that one database.

**Client** (`client/`): Vitest + Testing Library, jsdom environment.

```bash
cd client
npm test
```

This is where the real cryptographic unit tests live, since that's where the
crypto lives now: `crypto/vault.test.ts` covers password/recovery-key
wrapping and unwrapping (including wrong-password and wrong-recovery-key
failure modes), field encrypt/decrypt round trips, and the independence of
the two HKDF outputs derived from one recovery key. `crypto/backup.test.ts`
covers the export/import passphrase wrapping and the re-encryption path used
when restoring into a different account's data key. Also covered: the API
client's request/retry logic (auth header attachment, 401 → refresh → retry,
concurrent-401 coalescing), the `cn()` class-merging utility, and
client-side form validation on the register page.

## Project structure

```
server/            Express + Prisma API - stores only opaque ciphertext for
                   vehicle data; cannot decrypt it (see Security model)
  prisma/schema.prisma
  src/
    app.ts          Express app factory (used by both index.ts and tests)
    auth/           password hashing, TOTP, JWT/session helpers
    crypto/         master-key envelope for the TOTP secret ONLY - not
                     used for vehicle/maintenance/fuel data
    middleware/      auth middleware
    routes/          REST endpoints (vehicles/maintenance/fuel/backup are
                     opaque-blob pass-through; auth handles the vault-wrap
                     fields and account recovery)
    services/        reminder evaluation, cron scheduler, mailer
    **/*.test.ts     unit tests, next to the code they test
  test/
    integration/     Supertest integration tests
    globalSetup.ts, setup.ts, resetDb.ts, helpers.ts   test harness
                     (helpers.ts imports client/src/crypto/vault.ts directly
                     to act as a real "browser" in these tests)
  vitest.config.ts
client/            React + Vite + Tailwind frontend
  src/
    crypto/          vault.ts (Web Crypto: key derivation, field
                     encrypt/decrypt, recovery-key HKDF), backup.ts
                     (client-side export/import), pending.ts (in-memory
                     handoff of sensitive values between auth-flow pages)
    api/             fetch client, auth + vault contexts, crypto-mapping.ts
                     (encrypt/decrypt helpers per entity), types
    components/ui/    small shadcn-style UI primitives
    pages/           route-level pages (RecoveryKeyPage, UnlockPage,
                     ForgotPasswordPage are new for the zero-knowledge flow)
    **/*.test.ts(x)  unit/component tests, next to the code they test
    test/setup.ts     testing-library setup
  vitest.config.ts
.github/workflows/test.yml   CI: runs both test suites on push/PR
docker-compose.yml
.env.example
```
