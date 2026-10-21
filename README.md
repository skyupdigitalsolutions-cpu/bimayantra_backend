# Bimayantra API

Backend for Bimayantra (Business Process Document v3.2). Node 22, TypeScript, Express 5, PostgreSQL 16, Drizzle ORM.

**Phase 1:** the rules every screen follows, plus sign-in. **Phase 2:** profile, KYC, insurers, dashboard, bell, tasks, assistants. **Phase 3:** the insurance catalogue. **Phase 4:** leads, customers, family, vehicles, documents, global search. **Phase 5:** best fit, quotations, comparisons, payments, proposals, policies. **Phase 6:** renewals, messages, plans and wallet, referral, SkyUp administration.

- All CFG settings (Section 3.4–3.6) in the database, read live; the exact message catalogue (Section 21)
- Field formats FLD-01 to FLD-37 with their VAL messages; error results as in Section 2.5
- Idempotency keys and Check status (GR-10, GR-17); audit log that cannot be edited or deleted (GR-30)
- PAN and Aadhaar encryption and masking helpers (GR-36); per-user and per-IP rate limits
- P-01 register (name + mobile + OTP → account, TRIAL, ₹0 wallet, CFG-169 pipelines)
- P-02 OTP login for every role, P-03 sessions (idle logout, 12-hour limit, 3 devices, end a session)
- P-04 change mobile number (two OTPs), step-up OTP for sensitive actions (CFG-83, AUTH-26)
- The same sign-in for the Android app: tokens in headers (X-Client: mobile) instead of cookies, same rules
- API description: docs/openapi.yaml (NFR-13)

Phase 2:
- P-05 profile in four sections, each saved on its own; completion % from CFG-124 weights; milestones (CFG-129)
- P-06 KYC with uploads (type checked by content, size, password protection, virus scan), PAN encrypted;
  SkyUp review queue with Verify / Reject and the advisor told by bell and email
- P-07 insurers and agent codes (one per insurer, expired-code and removed-insurer warnings, duplicate flag)
- P-08 dashboard widgets (banners SUB-03/04/05, today's tasks, recent activity, profile card)
- P-10 bell notifications (one per event, unread count, read / read all); emails go through the job queue
- P-11 tasks with tabs, edit conflicts (GEN-05), and a reminder CFG-34 before the due time
- P-53 assistants (Premium or Trial, extra OTP to add, limit CFG-158, disable ends sessions)
- Background jobs on pg-boss in PostgreSQL (task reminders, emails, clean-up) — no Redis

Phase 3 (Section 9, maker-checker: whoever makes a change never approves it; a second ADM approves with the extra OTP):
- P-20 insurers (pending changes for active insurers, CAT-09 impact on deactivation)
- P-21 insurance types and versioned feature templates (features, rating factors, quotation questions; bands without overlaps or gaps)
- P-22 verified products (DRAFT → PENDING_APPROVAL → PUBLISHED, every version kept) and advisors' own products; private commission
- P-23 brochure reading for text PDFs, with a review grid; nothing reaches a product without a person's decision
- P-24 private, dated price versions (one open price, enforced by the database), CSV template, SkyUp reference price
- P-25 one Approvals list; P-58 advisors suggest corrections to verified products

Phase 4 (Sections 10–11):
- P-12 to P-19 leads (sources, contact log, status, convert), customers with family, vehicles, consent, documents
- P-09 global search across leads, customers, quotations, policies

Phase 5 (Sections 12–14):
- P-26 best fit (rate tables + feature templates, budget fit), P-27 to P-29 quotations with revisions,
  PDF (pdf-lib, bundled DejaVu fonts), share by link / WhatsApp / email, validity from first share
- P-30 comparisons, P-31 / P-32 insurer payment links and recorded payments, P-55 proposals,
  P-33 to P-36 policies (issue, nominees, endorsements, existing policies), renewal cycles

Phase 6 (Sections 15–17):
- P-37 / P-38 renewals (SYS-03 daily run, reminders, contact log, not renewing, reopen, pause)
- P-39 message templates (maker-checker, Meta status), P-40 greetings, P-41 to P-43 message log, cancel, resend
- P-47 plans with GST invoices (BY/FY/NNNNNN), P-56 WhatsApp wallet, Razorpay or test gateway, signed webhooks
- P-44 to P-46 referrers, links and the public referral form; P-48 to P-52 SkyUp users, configuration,
  audit, accounts, export; P-57 support access
- Daily jobs (SYS-01, 03, 04, 05, 06, 13) run once per IST day; each run is recorded in `job_runs`

## Run on a laptop

You need Node.js 22 and PostgreSQL 16 (or Docker: `docker compose up -d` starts PostgreSQL).

```bash
npm install
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
# fill FIELD_ENCRYPTION_KEY (command in the file), SEED_ADMIN_MOBILE and SEED_SECOND_ADMIN_MOBILE
npm run db:migrate            # creates the tables
npm run seed                  # settings, SkyUp admins, demo advisor 99999 00001 and a demo product
npm run dev                   # http://localhost:4000/ready
```

With `OTP_FIXED_CODE=123456` every OTP is `123456` (development only; the server refuses it in production).

## Tests

```bash
npm test        # 175 tests against a real PostgreSQL database "bimayantra_test" (created fresh each run)
npm run lint
npm run typecheck
```

Create the test database once: `createdb -U postgres bimayantra_test` (or in psql: `create database bimayantra_test;`).
Each acceptance check (AC-P01-1 … AC-P58-2) has a test named after it.

## Deploy (Railway)

- Add a **PostgreSQL** database. API service variables: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `PORT=4000`, `NODE_ENV=staging`
  (demo) or `production`, `TRUST_PROXY=1`, the three secrets, `SEED_ADMIN_MOBILE` and `SEED_SECOND_ADMIN_MOBILE`, and for production `SMS_PROVIDER=msg91` + MSG91 keys.
- Files: `STORAGE_DRIVER=s3` + `S3_BUCKET` (AWS India region, object lock) or a Railway volume with `UPLOAD_DIR`.
  Production also needs `SCAN_PROVIDER=clamav` (a ClamAV service) and `EMAIL_PROVIDER=smtp` + `SMTP_URL`.
- Phase 5–6 variables: `APP_URL` (website address used in links), `WHATSAPP_PROVIDER` (`none` until a provider
  is ready, then `http` + `WHATSAPP_API_URL`, `WHATSAPP_API_KEY`, `WHATSAPP_WEBHOOK_SECRET`), `EMAIL_WEBHOOK_SECRET`,
  `PAYMENT_GATEWAY` (`none` or `razorpay` + `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `PAYMENT_WEBHOOK_SECRET`).
  Webhooks: `/api/v1/webhooks/whatsapp`, `/api/v1/webhooks/email`, `/api/v1/webhooks/payments`.
- Production refuses `OTP_FIXED_CODE`, `SEED_DEMO_DATA=true`, `TEST_CLOCK_ENABLED=true`, `PAYMENT_GATEWAY=test` and
  `WHATSAPP_PROVIDER=log|memory`.
- Build `npm run build` · Pre-deploy `npm run db:migrate:prod && npm run seed:prod` · Start `npm start` · Healthcheck `/ready`.
- The website calls the API through its own `/api/v1` proxy (no CORS needed). The Android app calls the API
  directly, so give the API service a public domain (Generate Domain) and put it in the app's `EXPO_PUBLIC_API_URL`.

## Folders

```
src/config      env.ts (checked at start-up), settings.ts (every CFG value), technical.ts
src/db          schema.ts (tables), client.ts
src/http        auth (session check), idempotency, middleware (errors, request ID)
src/lib         fields (FLD rules), errors, clock (IST, test clock), crypto, mask
src/messages    messages.json (Section 21 catalogue)
src/modules     auth, accounts, audit, catalogue, files, kyc, profile, tasks, … (one folder per area)
drizzle/        SQL migrations (0001 makes the audit log unchangeable)
docs/           DOCUMENT-CHANGES.md: questions for the document owner
```
