# Copilot instructions (auto-trade)

## Big picture

- Monorepo using npm workspaces (see root `package.json`).
- `apps/web`: Next.js App Router UI.
- `apps/api`: NestJS REST API + Prisma (SQLite in dev).

## Run / build

- Dev (web+api): `npm run dev`
  - Web: http://localhost:3000
  - API: http://localhost:3001
- Build: `npm run build`

## Backend (NestJS) conventions

- Global request validation is enabled via `ValidationPipe` in [apps/api/src/main.ts](apps/api/src/main.ts).
- Prisma schema + migrations live in:
  - [apps/api/prisma/schema.prisma](apps/api/prisma/schema.prisma)
  - [apps/api/prisma/migrations/](apps/api/prisma/migrations/)
- Prisma usage goes through `PrismaService` in [apps/api/src/prisma/prisma.service.ts](apps/api/src/prisma/prisma.service.ts).

## Auth model + flow

- Email/password auth only (no OTP/email sending).
- Password hashing: `argon2`.
- Session: JWT stored in httpOnly cookie named `at`.
- Key endpoints in [apps/api/src/auth/](apps/api/src/auth/):
  - `POST /auth/register`
  - `POST /auth/login` (sets cookie)
  - `POST /auth/logout` (clears cookie)
  - `GET /auth/me`
  - `POST /auth/forgot-password` (returns `resetToken` for dev/testing)
  - `POST /auth/reset-password`

## Brokers + Zerodha Kite Connect

- Broker records are per-user and support multiple brokers per user (see `Broker` model in Prisma schema).
- Listing/CRUD endpoints are in [apps/api/src/brokers/](apps/api/src/brokers/).
- Kite connect flow:
  - Web calls `GET /brokers/kite/login-url?brokerId=...` and redirects the browser to the returned URL.
  - Zerodha redirects back to `GET /brokers/kite/callback?request_token=...&state=...`.
  - Callback stores `accessToken` for the broker and redirects to `/dashboard?kite=success`.
- Required env vars for local dev: [apps/api/.env](apps/api/.env)
  - `WEB_APP_URL` (e.g. `http://localhost:3000`)
  - `KITE_REDIRECT_URL` should match Zerodha app redirect URL.

## Frontend conventions

- API calls go through `apiFetch` in [apps/web/src/lib/api.ts](apps/web/src/lib/api.ts) and always use `credentials: 'include'`.
- `NEXT_PUBLIC_API_BASE_URL` is configured in [apps/web/.env.local](apps/web/.env.local).
- Toast notifications use `react-hot-toast` (see [apps/web/src/components/toaster.tsx](apps/web/src/components/toaster.tsx)).
