// PostgreSQL schema (Drizzle). Phase 1: settings, accounts, users, OTP, sessions, audit, idempotency.
// Status names are stored exactly as the document writes them, in capitals (Section 4).
// `npm run db:generate` creates a SQL migration from changes here; `npm run db:migrate` applies them.
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });
// GR-11: every editable record has a version number
const version = () => integer('version').notNull().default(1);

// ---------- Configuration (Section 3.4 – 3.6, P-49) ----------
export const configValues = pgTable('config_values', {
  id: text('id').primaryKey(), // 'CFG-02'
  value: jsonb('value').notNull(),
  defaultValue: jsonb('default_value').notNull(),
  changeBy: text('change_by').notNull(), // ADM | Release
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

// ---------- Accounts and users (Section 3.1, 4.1, 4.3) ----------
export const accounts = pgTable('accounts', {
  id: id(),
  status: text('status').notNull().default('ACTIVE'), // ACTIVE | SUSPENDED | CLOSED
  statusReason: text('status_reason'),
  closedAt: ts('closed_at'),
  createdAt: createdAt(),
  version: version(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    accountId: uuid('account_id').references(() => accounts.id), // null for SkyUp Staff and Admin
    role: text('role').notNull(), // ADV | AST | REF | STF | ADM
    name: text('name').notNull(),
    mobile: text('mobile').notNull(), // stored as +91XXXXXXXXXX (FLD-01)
    status: text('status').notNull(), // INVITED | ACTIVE | DISABLED
    invitedBy: uuid('invited_by'),
    invitedAt: ts('invited_at'),
    activatedAt: ts('activated_at'),
    lastLoginAt: ts('last_login_at'),
    termsVersion: text('terms_version'),
    termsAcceptedAt: ts('terms_accepted_at'),
    // optional password (extra: OTP login stays); scrypt hash only, never returned by the API
    passwordHash: text('password_hash'),
    passwordSetAt: ts('password_set_at'),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [
    // GR-12 + DEC-07: one person, one role per mobile number — a database rule, not only a lookup
    uniqueIndex('users_mobile_unique').on(t.mobile),
    index('users_account_idx').on(t.accountId),
    check('users_role_check', sql`${t.role} in ('ADV','AST','REF','STF','ADM')`),
    check('users_status_check', sql`${t.status} in ('INVITED','ACTIVE','DISABLED')`),
    check('users_account_check', sql`(${t.role} in ('STF','ADM')) = (${t.accountId} is null)`),
  ],
);

// P-05: the advisor profile, section by section. Each section has its own version (GR-11: two tabs saving
// the same section → GEN-05; saving one section never touches another).
export const advisorProfiles = pgTable('advisor_profiles', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id),
  // Personal
  fullName: text('full_name').notNull(),
  dateOfBirth: date('date_of_birth'),
  gender: text('gender'), // MALE | FEMALE | TRANSGENDER | PREFER_NOT_TO_SAY
  photoFileId: uuid('photo_file_id'),
  personalVersion: integer('personal_version').notNull().default(1),
  // Contact
  email: text('email'),
  altMobile: text('alt_mobile'),
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  state: text('state'),
  pinCode: text('pin_code'),
  contactVersion: integer('contact_version').notNull().default(1),
  // Professional
  advisorType: text('advisor_type'), // INDIVIDUAL_AGENT | POSP | CORPORATE_AGENT_STAFF | BROKER_STAFF
  licenceNumber: text('licence_number'),
  licenceValidUntil: date('licence_valid_until'),
  experienceYears: integer('experience_years'),
  authorisedTypeIds: uuid('authorised_type_ids').array().notNull().default(sql`'{}'::uuid[]`),
  professionalVersion: integer('professional_version').notNull().default(1),
  // Business
  businessName: text('business_name'),
  logoFileId: uuid('logo_file_id'),
  gstin: text('gstin'),
  businessVersion: integer('business_version').notNull().default(1),
  // Completion (server-computed only, P-05 backend rules)
  completionPercent: integer('completion_percent').notNull().default(0),
  /** @deprecated Phase 1 column; KYC status now lives in advisor_kyc (kept so existing databases migrate cleanly) */
  kycStatus: text('kyc_status').notNull().default('NOT_SUBMITTED'),
  /** @deprecated Phase 1 column; each section now has its own version */
  version: version(),
  lastMilestone: integer('last_milestone').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: ts('updated_at'),
});

// P-06 KYC: PAN encrypted field by field (GR-36); a keyed hash allows lookups without decrypting
export const advisorKyc = pgTable(
  'advisor_kyc',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .references(() => accounts.id),
    status: text('status').notNull().default('NOT_SUBMITTED'), // NOT_SUBMITTED | PENDING_REVIEW | VERIFIED | REJECTED
    panEnc: text('pan_enc'),
    panIndex: text('pan_index'),
    nameOnPan: text('name_on_pan'),
    panFileId: uuid('pan_file_id'),
    licenceFileId: uuid('licence_file_id'),
    declaredAt: ts('declared_at'),
    submittedAt: ts('submitted_at'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    rejectReason: text('reject_reason'),
    rejectNote: text('reject_note'),
    version: version(),
  },
  (t) => [
    check('kyc_status_check', sql`${t.status} in ('NOT_SUBMITTED','PENDING_REVIEW','VERIFIED','REJECTED')`),
    index('kyc_queue').on(t.status, t.submittedAt),
  ],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    plan: text('plan'), // null during TRIAL (no plan chosen) | NORMAL | PREMIUM
    status: text('status').notNull(), // TRIAL | ACTIVE | GRACE | EXPIRED
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [uniqueIndex('subscriptions_one_current').on(t.accountId).where(sql`${t.isCurrent}`)],
);

export const wallets = pgTable(
  'wallets',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .references(() => accounts.id),
    balance: numeric('balance', { precision: 14, scale: 2 }).notNull().default('0.00'),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [check('wallets_balance_not_negative', sql`${t.balance} >= 0`)],
);

export const pipelines = pgTable(
  'pipelines',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('pipelines_account_name').on(t.accountId, t.name)],
);

// ---------- OTP (P-01, P-02, P-04, step-up) ----------
export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: id(),
    mobile: text('mobile').notNull(),
    purpose: text('purpose').notNull(), // REGISTER | LOGIN | CHANGE_MOBILE | CHANGE_MOBILE_NEW | STEP_UP
    userId: uuid('user_id'),
    codeHash: text('code_hash').notNull(), // salted hash only; the code itself is never stored
    status: text('status').notNull().default('ISSUED'), // ISSUED | VERIFIED | EXPIRED | REPLACED | LOCKED
    wrongTries: integer('wrong_tries').notNull().default(0),
    sent: boolean('sent').notNull().default(false), // SMS accepted by the provider
    sentAt: ts('sent_at'),
    context: jsonb('context'), // e.g. registration name, step-up action
    ip: text('ip'),
    expiresAt: ts('expires_at').notNull(),
    verifiedAt: ts('verified_at'),
    createdAt: createdAt(),
  },
  (t) => [
    // One open challenge per mobile and purpose (Section 4.1)
    uniqueIndex('otp_one_open').on(t.mobile, t.purpose).where(sql`${t.status} = 'ISSUED'`),
    index('otp_mobile_created').on(t.mobile, t.createdAt),
  ],
);

export const otpLocks = pgTable(
  'otp_locks',
  {
    mobile: text('mobile').notNull(),
    purpose: text('purpose').notNull(),
    lockedUntil: ts('locked_until').notNull(),
    reason: text('reason').notNull(), // WRONG_TRIES | TOO_MANY_SENDS
  },
  (t) => [primaryKey({ columns: [t.mobile, t.purpose] })],
);

// ---------- Sessions (P-03) ----------
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    refreshHash: text('refresh_hash').notNull(),
    // The previous refresh token stays valid for a few seconds after rotation, so two browser tabs
    // refreshing at the same moment do not log each other out (see src/config/technical.ts)
    prevRefreshHash: text('prev_refresh_hash'),
    refreshRotatedAt: ts('refresh_rotated_at'),
    deviceName: text('device_name').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
    lastActiveAt: ts('last_active_at').notNull().defaultNow(),
    endedAt: ts('ended_at'),
    // LOGOUT | IDLE | MAX_AGE | REPLACED | ENDED_BY_USER | USER_DISABLED | ACCOUNT_SUSPENDED | MOBILE_CHANGED | ROLE_CHANGED
    endReason: text('end_reason'),
  },
  (t) => [index('sessions_user_active').on(t.userId).where(sql`${t.endedAt} is null`)],
);

// Short-lived tickets for multi-step flows (P-04 change mobile) and step-up OTP (CFG-83, AUTH-26)
export const authTickets = pgTable('auth_tickets', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  sessionId: uuid('session_id').notNull(),
  kind: text('kind').notNull(), // CHANGE_MOBILE_CURRENT_VERIFIED | STEP_UP
  data: jsonb('data'),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
});

// ---------- Global rules ----------
// GR-10: idempotency keys — a repeated request returns the original result
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    scope: text('scope').notNull(), // user id, or 'public'
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestHash: text('request_hash').notNull(),
    state: text('state').notNull().default('IN_PROGRESS'), // IN_PROGRESS | DONE
    statusCode: integer('status_code'),
    response: jsonb('response'),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] })],
);

// GR-30: audit log — written in the same transaction as the change; cannot be edited or deleted (trigger)
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull().defaultNow(),
    actorUserId: uuid('actor_user_id'),
    actorRole: text('actor_role'),
    actorJob: text('actor_job'), // system job name when not a person
    accountId: uuid('account_id'),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    result: text('result').notNull().default('SUCCESS'),
    requestId: text('request_id'),
    ip: text('ip'),
  },
  (t) => [index('audit_account_at').on(t.accountId, t.at), index('audit_entity').on(t.entity, t.entityId)],
);

// Fixed-window counters for rate limits (CFG-05, CFG-10, CFG-99 …)
export const rateCounters = pgTable(
  'rate_counters',
  {
    key: text('key').notNull(),
    windowStart: ts('window_start').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

// NFR-13: test-only clock override (non-production only)
export const testClock = pgTable('test_clock', {
  id: integer('id').primaryKey().default(1),
  offsetMs: bigint('offset_ms', { mode: 'number' }).notNull().default(0),
});

// ---------- Files (FLD-22, GR-32) ----------
// Stored privately (local disk or S3); opened only through a short-lived link by a user allowed to see it.
export const files = pgTable(
  'files',
  {
    id: id(),
    accountId: uuid('account_id'), // null for platform files (insurer logos)
    uploadedBy: uuid('uploaded_by').notNull(),
    purpose: text('purpose').notNull(), // PROFILE_PHOTO | BUSINESS_LOGO | KYC_PAN | KYC_LICENCE | APPOINTMENT_LETTER …
    originalName: text('original_name').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    scan: text('scan').notNull(), // CLEAN | NOT_SCANNED (development only)
    createdAt: createdAt(),
  },
  (t) => [index('files_account').on(t.accountId)],
);

// ---------- Catalogue (Section 9: P-20 to P-25, P-58) ----------
// Maker-checker columns shared by insurers and insurance types: everyone who edited the item since its
// last approval is a maker and can never approve it (CAT-05). An edit to an ACTIVE record waits in
// pending_change; advisors keep seeing the old values until a different ADM approves it (AC-P20-3).
const makerChecker = () => ({
  pendingChange: jsonb('pending_change'),
  makers: uuid('makers').array().notNull().default(sql`'{}'::uuid[]`),
  submittedAt: ts('submitted_at'),
  rejectReason: text('reject_reason'),
  approvedBy: uuid('approved_by'),
  approvedAt: ts('approved_at'),
  approvalTicketId: uuid('approval_ticket_id'), // the step-up OTP verification used (P-25 backend rules)
});

export const insuranceTypes = pgTable(
  'insurance_types',
  {
    id: id(),
    name: text('name').notNull(),
    status: text('status').notNull().default('ACTIVE'), // DRAFT | PENDING_APPROVAL | ACTIVE | INACTIVE
    position: integer('position').notNull().default(0),
    ...makerChecker(),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [uniqueIndex('insurance_types_name').on(sql`lower(${t.name})`)],
);

// P-21: one row per template version. Features, rating factors and quotation questions are kept as JSON
// so an older version never changes when a newer one is approved (AC-P21-1).
export const templateVersions = pgTable(
  'template_versions',
  {
    id: id(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => insuranceTypes.id),
    versionNo: integer('version_no').notNull(),
    status: text('status').notNull().default('DRAFT'), // DRAFT | PENDING_APPROVAL | ACTIVE | RETIRED
    features: jsonb('features').notNull().default(sql`'[]'::jsonb`),
    factors: jsonb('factors').notNull().default(sql`'[]'::jsonb`),
    questions: jsonb('questions').notNull().default(sql`'[]'::jsonb`),
    makers: uuid('makers').array().notNull().default(sql`'{}'::uuid[]`),
    submittedAt: ts('submitted_at'),
    rejectReason: text('reject_reason'),
    approvedBy: uuid('approved_by'),
    approvedAt: ts('approved_at'),
    approvalTicketId: uuid('approval_ticket_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('template_one_active').on(t.typeId).where(sql`${t.status} = 'ACTIVE'`),
    uniqueIndex('template_one_open').on(t.typeId).where(sql`${t.status} in ('DRAFT','PENDING_APPROVAL')`),
    uniqueIndex('template_version_no').on(t.typeId, t.versionNo),
  ],
);

export const insurers = pgTable(
  'insurers',
  {
    id: id(),
    name: text('name').notNull(),
    shortCode: text('short_code').notNull(),
    category: text('category').notNull(), // LIFE | GENERAL | STANDALONE_HEALTH
    irdaiRegNo: text('irdai_reg_no').notNull(),
    website: text('website'),
    paymentDomains: text('payment_domains').array().notNull().default(sql`'{}'::text[]`),
    careNumber: text('care_number'),
    careEmail: text('care_email'),
    logoFileId: uuid('logo_file_id'),
    status: text('status').notNull().default('DRAFT'), // DRAFT | PENDING_APPROVAL | ACTIVE | INACTIVE
    ...makerChecker(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [uniqueIndex('insurers_name').on(sql`lower(${t.name})`), uniqueIndex('insurers_code').on(t.shortCode)],
);

// P-07: which insurers an advisor sells for, with the agent code. One entry per account and insurer.
export const insurerMappings = pgTable(
  'insurer_mappings',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    insurerId: uuid('insurer_id')
      .notNull()
      .references(() => insurers.id),
    agentCode: text('agent_code').notNull(),
    codeValidUntil: date('code_valid_until'),
    appointmentFileId: uuid('appointment_file_id'),
    declaredAt: ts('declared_at').notNull(),
    status: text('status').notNull().default('ACTIVE'), // ACTIVE | INACTIVE
    // Same insurer + agent code in another account: flagged for SkyUp review, never told to the advisor (DEC-09)
    flaggedForReview: boolean('flagged_for_review').notNull().default(false),
    // Agent code check from the appointment letter: UNVERIFIED (no letter) | VERIFIED | REVIEW (SkyUp checks) | REJECTED
    verification: text('verification').notNull().default('UNVERIFIED'),
    verificationNote: text('verification_note'), // shown to the advisor
    verificationRead: jsonb('verification_read'), // what was read from the letter + reasons (for SkyUp)
    verifiedAt: ts('verified_at'),
    verifiedBy: uuid('verified_by'),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [uniqueIndex('insurer_mappings_unique').on(t.accountId, t.insurerId), index('insurer_mappings_code').on(t.insurerId, t.agentCode)],
);

// ---------- P-10 Bell notifications ----------
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    accountId: uuid('account_id'),
    messageId: text('message_id').notNull(),
    text: text('text').notNull(),
    linkType: text('link_type'),
    linkId: text('link_id'),
    dedupeKey: text('dedupe_key').notNull(), // event + record + date: the same event twice creates one item
    status: text('status').notNull().default('UNREAD'), // UNREAD | READ
    createdAt: createdAt(),
    readAt: ts('read_at'),
  },
  (t) => [uniqueIndex('notifications_dedupe').on(t.userId, t.dedupeKey), index('notifications_user').on(t.userId, t.status, t.createdAt)],
);

// ---------- P-11 Tasks ----------
export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    title: text('title').notNull(),
    dueAt: ts('due_at').notNull(), // IST date + time, stored in UTC
    linkedType: text('linked_type'), // LEAD | CUSTOMER | QUOTATION | RENEWAL
    linkedId: uuid('linked_id'),
    notes: text('notes'),
    status: text('status').notNull().default('OPEN'), // OPEN | DONE | CANCELLED
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
    remindedForDueAt: ts('reminded_for_due_at'), // one reminder per task and due time
    version: version(),
  },
  (t) => [index('tasks_account_due').on(t.accountId, t.status, t.dueAt)],
);

// ---------- P-22 Products ----------
// VERIFIED products are SkyUp's (account_id null, seen by every advisor); OWN products belong to one
// account and are filtered like any other account record (GR-20).
export const products = pgTable(
  'products',
  {
    id: id(),
    kind: text('kind').notNull(), // VERIFIED | OWN
    accountId: uuid('account_id').references(() => accounts.id),
    insurerId: uuid('insurer_id')
      .notNull()
      .references(() => insurers.id),
    typeId: uuid('type_id')
      .notNull()
      .references(() => insuranceTypes.id),
    code: text('code').notNull(),
    status: text('status').notNull().default('UPCOMING'), // UPCOMING | ACTIVE | WITHDRAWN (Section 4.3)
    statusReason: text('status_reason'),
    publishedVersionId: uuid('published_version_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [
    check('products_kind_check', sql`(${t.kind} = 'VERIFIED') = (${t.accountId} is null)`),
    check('products_status_check', sql`${t.status} in ('UPCOMING','ACTIVE','WITHDRAWN')`),
    uniqueIndex('products_verified_code').on(t.insurerId, t.code).where(sql`${t.kind} = 'VERIFIED'`),
    uniqueIndex('products_own_code').on(t.accountId, t.insurerId, t.code).where(sql`${t.kind} = 'OWN'`),
    index('products_account').on(t.accountId),
  ],
);

// Every product version is kept; quotations and policies store the version they used (GR-23).
export const productVersions = pgTable(
  'product_versions',
  {
    id: id(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    versionNo: integer('version_no').notNull(),
    status: text('status').notNull().default('DRAFT'), // DRAFT | PENDING_APPROVAL | PUBLISHED | SUPERSEDED
    templateVersionId: uuid('template_version_id')
      .notNull()
      .references(() => templateVersions.id),
    name: text('name').notNull(),
    uin: text('uin'),
    data: jsonb('data').notNull(),
    makers: uuid('makers').array().notNull().default(sql`'{}'::uuid[]`),
    correctionIds: uuid('correction_ids').array().notNull().default(sql`'{}'::uuid[]`), // P-58 backend rules
    submittedAt: ts('submitted_at'),
    rejectReason: text('reject_reason'),
    approvedBy: uuid('approved_by'),
    approvedAt: ts('approved_at'),
    approvalTicketId: uuid('approval_ticket_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at'),
    version: version(),
  },
  (t) => [
    uniqueIndex('product_one_published').on(t.productId).where(sql`${t.status} = 'PUBLISHED'`),
    uniqueIndex('product_one_open').on(t.productId).where(sql`${t.status} in ('DRAFT','PENDING_APPROVAL')`),
    uniqueIndex('product_version_no').on(t.productId, t.versionNo),
  ],
);

// "My commercials": private to the advisor; never returned by any shared catalogue API (P-22).
export const productCommercials = pgTable(
  'product_commercials',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    commissionPercent: numeric('commission_percent', { precision: 5, scale: 2 }).notNull(),
    notes: text('notes'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    version: version(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.productId] })],
);

// ---------- P-24 Price versions ----------
// owner_key is the account ID, or 'SKYUP' for a SkyUp reference price. Exactly one version per owner and
// product has no end date — a database rule, so two saves at the same moment cannot both win (AC-P24-3).
export const priceVersions = pgTable(
  'price_versions',
  {
    id: id(),
    ownerKey: text('owner_key').notNull(),
    accountId: uuid('account_id').references(() => accounts.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    seq: integer('seq').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    status: text('status').notNull(), // CURRENT | SCHEDULED | CLOSED | CANCELLED
    taxPercent: numeric('tax_percent', { precision: 5, scale: 2 }).notNull(),
    rows: jsonb('rows').notNull(), // [{ factors: { key: label }, basePremium: "12500.00" }]
    riderPrices: jsonb('rider_prices').notNull().default(sql`'[]'::jsonb`),
    sourceNote: text('source_note'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    cancelledAt: ts('cancelled_at'),
  },
  (t) => [
    uniqueIndex('price_one_open').on(t.ownerKey, t.productId).where(sql`${t.effectiveTo} is null and ${t.status} <> 'CANCELLED'`),
    uniqueIndex('price_seq').on(t.ownerKey, t.productId, t.seq),
    check('price_status_check', sql`${t.status} in ('CURRENT','SCHEDULED','CLOSED','CANCELLED')`),
  ],
);

// ---------- P-23 Brochure reading ----------
export const ocrJobs = pgTable(
  'ocr_jobs',
  {
    id: id(),
    accountId: uuid('account_id'), // null for SkyUp work on a verified draft
    productVersionId: uuid('product_version_id'), // verified draft; null for an advisor's own-product preview
    templateVersionId: uuid('template_version_id').notNull(),
    fileId: uuid('file_id').notNull(),
    status: text('status').notNull().default('QUEUED'), // QUEUED | PROCESSING | REVIEW_REQUIRED | REVIEWED | FAILED
    raw: jsonb('raw'), // raw text per page, kept for audit
    rows: jsonb('rows').notNull().default(sql`'[]'::jsonb`), // one row per feature, with the reviewer's decision
    error: text('error'),
    startedBy: uuid('started_by').notNull(),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
    version: version(),
  },
  (t) => [
    // Running OCR again on the same file reuses the open job (P-23)
    uniqueIndex('ocr_one_open')
      .on(t.fileId, sql`coalesce(${t.productVersionId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
      .where(sql`${t.status} in ('QUEUED','PROCESSING','REVIEW_REQUIRED')`),
  ],
);

// ---------- P-58 Corrections to verified products ----------
export const productCorrections = pgTable(
  'product_corrections',
  {
    id: id(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    userId: uuid('user_id').notNull(),
    field: text('field').notNull(),
    fieldLabel: text('field_label').notNull(),
    currentValue: text('current_value'),
    proposedValue: text('proposed_value').notNull(),
    reason: text('reason').notNull(),
    fileId: uuid('file_id'),
    status: text('status').notNull().default('SUBMITTED'), // SUBMITTED | ACCEPTED | REJECTED
    rejectReason: text('reject_reason'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    resultingVersionId: uuid('resulting_version_id'),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('corrections_one_open').on(t.accountId, t.productId, t.field).where(sql`${t.status} = 'SUBMITTED'`),
    index('corrections_queue').on(t.status, t.createdAt),
  ],
);

// ======================= Phase 4: leads, customers, family, consent, documents, vehicles =======================

// Reference numbers per account (Section 4.2): given only when a record is first saved; never reused.
export const accountCounters = pgTable(
  'account_counters',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    kind: text('kind').notNull(), // LD | CU | QT | CQ | PL | PR
    value: integer('value').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.kind] })],
);

// P-12 Leads. Open = not CONVERTED and not LOST. The exact-duplicate rule is a database rule on
// (account, mobile, normalised name) for open leads (P-12 backend rules).
export const leads = pgTable(
  'leads',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    number: text('number').notNull(),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id),
    name: text('name').notNull(),
    nameNorm: text('name_norm').notNull(), // lower case, no spaces or dots
    mobile: text('mobile').notNull(), // +91 form
    altMobile: text('alt_mobile'),
    email: text('email'),
    source: text('source').notNull(), // CFG-133
    referrerUserId: uuid('referrer_user_id'),
    referredByCustomerId: uuid('referred_by_customer_id'),
    campaign: text('campaign'),
    interestTypeIds: uuid('interest_type_ids').array().notNull().default(sql`'{}'::uuid[]`),
    priority: text('priority').notNull().default('MEDIUM'), // HIGH | MEDIUM | LOW
    status: text('status').notNull().default('NEW'), // CFG-170 stages
    nextFollowUpAt: ts('next_follow_up_at'),
    followUpTaskId: uuid('follow_up_task_id'),
    lostReason: text('lost_reason'),
    lostNote: text('lost_note'),
    customerId: uuid('customer_id'),
    notes: text('notes'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at'),
    convertedAt: ts('converted_at'),
    version: version(),
  },
  (t) => [
    uniqueIndex('leads_number').on(t.accountId, t.number),
    uniqueIndex('leads_open_exact').on(t.accountId, t.mobile, t.nameNorm).where(sql`${t.status} not in ('CONVERTED','LOST')`),
    index('leads_account_status').on(t.accountId, t.status, t.createdAt),
    index('leads_account_mobile').on(t.accountId, t.mobile),
  ],
);

// Lead timeline: contacts, status changes (the pipeline's stage history), edits (P-13 backend rules).
export const leadEvents = pgTable(
  'lead_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    accountId: uuid('account_id').notNull(),
    kind: text('kind').notNull(), // CREATED | CONTACT | STATUS | EDITED | CONVERTED
    outcome: text('outcome'), // SPOKE | NOT_REACHABLE | CALL_BACK
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    reason: text('reason'),
    note: text('note'),
    userId: uuid('user_id'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('lead_events_lead').on(t.leadId, t.at)],
);

// P-15 Customers. Exact duplicate = same mobile and normalised name among ACTIVE customers.
export const customers = pgTable(
  'customers',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    number: text('number').notNull(),
    fullName: text('full_name').notNull(),
    nameNorm: text('name_norm').notNull(),
    dateOfBirth: date('date_of_birth'),
    gender: text('gender'),
    mobile: text('mobile').notNull(),
    altMobile: text('alt_mobile'),
    email: text('email'),
    preferredContact: text('preferred_contact'), // WHATSAPP | PHONE | EMAIL
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    pinCode: text('pin_code'),
    anniversary: date('anniversary'),
    occupation: text('occupation'),
    source: text('source').notNull().default('Direct'),
    leadId: uuid('lead_id'),
    referrerUserId: uuid('referrer_user_id'),
    referredByCustomerId: uuid('referred_by_customer_id'),
    campaign: text('campaign'),
    notes: text('notes'),
    // GR-31 / GR-36: PAN and Aadhaar encrypted; blind index for "same PAN on another customer"; masked copy
    panEnc: text('pan_enc'),
    panIndex: text('pan_index'),
    panMasked: text('pan_masked'),
    aadhaarEnc: text('aadhaar_enc'),
    aadhaarMasked: text('aadhaar_masked'),
    defaultNominee: jsonb('default_nominee'), // { familyMemberId?, name, relationship, sharePercent }
    status: text('status').notNull().default('ACTIVE'), // ACTIVE | INACTIVE
    inactiveReason: text('inactive_reason'),
    inactiveNote: text('inactive_note'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at'),
    version: version(),
  },
  (t) => [
    uniqueIndex('customers_number').on(t.accountId, t.number),
    uniqueIndex('customers_active_exact').on(t.accountId, t.mobile, t.nameNorm).where(sql`${t.status} = 'ACTIVE'`),
    index('customers_account_status').on(t.accountId, t.status),
    index('customers_account_mobile').on(t.accountId, t.mobile),
    index('customers_pan').on(t.accountId, t.panIndex),
  ],
);

// P-16 Household roster. Each member has exactly one customer; never a nominee automatically.
export const familyMembers = pgTable(
  'family_members',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    fullName: text('full_name').notNull(),
    nameNorm: text('name_norm').notNull(),
    relationship: text('relationship').notNull(), // CFG-36
    dateOfBirth: date('date_of_birth'),
    gender: text('gender'),
    anniversary: date('anniversary'),
    mobile: text('mobile'),
    email: text('email'),
    photoFileId: uuid('photo_file_id'),
    status: text('status').notNull().default('ACTIVE'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('family_active_name_rel').on(t.customerId, t.nameNorm, t.relationship).where(sql`${t.status} = 'ACTIVE'`),
    index('family_customer').on(t.customerId),
  ],
);

// P-15 family links between two customers of the account (Spouse, Parent, Child, Sibling, Other).
export const customerLinks = pgTable(
  'customer_links',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    linkedCustomerId: uuid('linked_customer_id')
      .notNull()
      .references(() => customers.id),
    relation: text('relation').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('customer_links_pair').on(t.customerId, t.linkedCustomerId)],
);

// P-17 Consent per person (customer or family member) and channel, for the exact mobile or email.
export const consents = pgTable(
  'consents',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    familyMemberId: uuid('family_member_id'),
    channel: text('channel').notNull(), // WHATSAPP | EMAIL | SMS | PERSONAL_DATA
    status: text('status').notNull(), // GIVEN | WITHDRAWN (no row = NOT_RECORDED)
    address: text('address'), // the mobile or email it was given for
    how: text('how'),
    evidenceFileId: uuid('evidence_file_id'),
    termsVersion: text('terms_version'),
    changedBy: uuid('changed_by'), // null for an automatic opt-out (SYS)
    changedAt: ts('changed_at').notNull(),
    version: version(),
  },
  (t) => [
    uniqueIndex('consents_person_channel')
      .on(t.customerId, sql`coalesce(${t.familyMemberId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.channel),
  ],
);

export const consentHistory = pgTable(
  'consent_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    consentId: uuid('consent_id').notNull(),
    accountId: uuid('account_id').notNull(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
    address: text('address'),
    how: text('how'),
    evidenceFileId: uuid('evidence_file_id'),
    byUserId: uuid('by_user_id'),
    source: text('source').notNull(), // ADVISOR | SYS
    at: ts('at').notNull(),
  },
  (t) => [index('consent_history_consent').on(t.consentId, t.at)],
);

// P-18 Document vault: one document per person and type (and name for Other); every upload is a version.
// Vehicle RC and vehicle photos belong to a vehicle (P-54). Nothing is ever deleted.
export const documents = pgTable(
  'documents',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    familyMemberId: uuid('family_member_id'),
    vehicleId: uuid('vehicle_id'),
    type: text('type').notNull(), // CFG-171
    name: text('name'), // for Other (FLD-37)
    slot: text('slot'), // vehicle photo slot (CFG-155)
    label: text('label').notNull(),
    latestVersion: integer('latest_version').notNull().default(1),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('documents_person_type').on(
      t.customerId,
      sql`coalesce(${t.familyMemberId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`coalesce(${t.vehicleId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.type,
      sql`coalesce(lower(${t.name}), '')`,
      sql`coalesce(${t.slot}, '')`,
    ),
    uniqueIndex('documents_label').on(t.customerId, sql`lower(${t.label})`),
    index('documents_customer').on(t.customerId),
  ],
);

export const documentVersions = pgTable(
  'document_versions',
  {
    id: id(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    accountId: uuid('account_id').notNull(),
    versionNo: integer('version_no').notNull(),
    fileId: uuid('file_id').notNull(),
    originalName: text('original_name').notNull(),
    status: text('status').notNull(), // UNCONFIRMED | CONFIRMED (types without a verify step are CONFIRMED)
    readValues: jsonb('read_values'),
    confirmedValues: jsonb('confirmed_values'), // identity numbers are never kept here in plain text
    uploadedBy: uuid('uploaded_by').notNull(),
    uploadedAt: ts('uploaded_at').notNull(),
    confirmedBy: uuid('confirmed_by'),
    confirmedAt: ts('confirmed_at'),
    version: version(),
  },
  (t) => [uniqueIndex('document_versions_no').on(t.documentId, t.versionNo)],
);

export const documentLabelChanges = pgTable('document_label_changes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id),
  oldLabel: text('old_label').notNull(),
  newLabel: text('new_label').notNull(),
  byUserId: uuid('by_user_id').notNull(),
  at: ts('at').notNull(),
});

// P-54 Vehicles. Registration stored without spaces, in capitals; unique in the account.
export const vehicles = pgTable(
  'vehicles',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    registration: text('registration').notNull(),
    vehicleType: text('vehicle_type').notNull(), // PRIVATE_CAR | TWO_WHEELER | COMMERCIAL
    make: text('make').notNull(),
    model: text('model').notNull(),
    year: integer('year').notNull(),
    fuel: text('fuel').notNull(), // PETROL | DIESEL | CNG | ELECTRIC | HYBRID
    status: text('status').notNull().default('ACTIVE'), // ACTIVE | INACTIVE (sold)
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [uniqueIndex('vehicles_registration').on(t.accountId, t.registration), index('vehicles_customer').on(t.customerId)],
);

// ======================= Phase 5: best fit, quotations, comparisons, payments, proposals, policies =======================

// P-26 ranking log: the answers, the products ranked with their scores, and the product chosen.
export const fitLogs = pgTable(
  'fit_logs',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    inputs: jsonb('inputs').notNull(),
    ranked: jsonb('ranked').notNull(),
    chosenProductId: uuid('chosen_product_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('fit_logs_account').on(t.accountId, t.createdAt)],
);

// P-27 Normal quotation. The number (QT-YYYYMM-NNNNN) is given at the first Generate; each revision keeps its
// own inputs, snapshot and PDF for ever (GR-22).
export const quotations = pgTable(
  'quotations',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    number: text('number'),
    productId: uuid('product_id'),
    insurerId: uuid('insurer_id'),
    typeId: uuid('type_id'),
    renewalOfPolicyId: uuid('renewal_of_policy_id'),
    fromComparisonId: uuid('from_comparison_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [uniqueIndex('quotations_number').on(t.accountId, t.number), index('quotations_customer').on(t.customerId)],
);

export const quotationRevisions = pgTable(
  'quotation_revisions',
  {
    id: id(),
    quotationId: uuid('quotation_id')
      .notNull()
      .references(() => quotations.id),
    accountId: uuid('account_id').notNull(),
    revisionNo: integer('revision_no').notNull(),
    // DRAFT | READY | SHARED | ACCEPTED | REJECTED | EXPIRED | SUPERSEDED | CANCELLED
    status: text('status').notNull().default('DRAFT'),
    step: integer('step').notNull().default(1),
    inputs: jsonb('inputs').notNull().default(sql`'{}'::jsonb`),
    breakdown: jsonb('breakdown'),
    snapshot: jsonb('snapshot'),
    priceVersionId: uuid('price_version_id'),
    calculatedOn: date('calculated_on'),
    finalPayable: numeric('final_payable', { precision: 14, scale: 2 }),
    pdfFileId: uuid('pdf_file_id'),
    pdfChecksum: text('pdf_checksum'),
    validUntil: date('valid_until'),
    firstSharedAt: ts('first_shared_at'),
    viewToken: text('view_token'),
    viewedAt: ts('viewed_at'),
    reason: text('reason'),
    reasonNote: text('reason_note'),
    statusAt: ts('status_at'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at'),
    version: version(),
  },
  (t) => [
    uniqueIndex('qrev_no').on(t.quotationId, t.revisionNo),
    // Section 4.3 / P-29: one draft and one live (READY, SHARED, ACCEPTED) revision per quotation at a time
    uniqueIndex('qrev_one_draft').on(t.quotationId).where(sql`${t.status} = 'DRAFT'`),
    uniqueIndex('qrev_one_live').on(t.quotationId).where(sql`${t.status} in ('READY','SHARED','ACCEPTED')`),
    uniqueIndex('qrev_token').on(t.viewToken),
    index('qrev_account_status').on(t.accountId, t.status),
  ],
);

// P-30 Comparison quotation (CQ-YYYYMM-NNNNN): 2 to 3 options frozen together; never a payment link.
export const comparisons = pgTable(
  'comparisons',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    number: text('number'),
    typeId: uuid('type_id'),
    status: text('status').notNull().default('DRAFT'), // DRAFT | READY | SHARED | PRODUCT_CHOSEN | EXPIRED | CANCELLED
    step: integer('step').notNull().default(1),
    inputs: jsonb('inputs').notNull().default(sql`'{}'::jsonb`),
    options: jsonb('options').notNull().default(sql`'[]'::jsonb`),
    snapshot: jsonb('snapshot'),
    calculatedOn: date('calculated_on'),
    pdfFileId: uuid('pdf_file_id'),
    validUntil: date('valid_until'),
    firstSharedAt: ts('first_shared_at'),
    viewToken: text('view_token'),
    viewedAt: ts('viewed_at'),
    chosenProductId: uuid('chosen_product_id'),
    linkedQuotationId: uuid('linked_quotation_id'),
    reason: text('reason'),
    statusAt: ts('status_at'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at'),
    version: version(),
  },
  (t) => [uniqueIndex('comparisons_number').on(t.accountId, t.number), uniqueIndex('comparisons_token').on(t.viewToken), index('comparisons_customer').on(t.customerId)],
);

// Share history and the customer's views (P-28): EMAIL | WHATSAPP | LINK | PDF | VIEWED
export const shareEvents = pgTable(
  'share_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: uuid('account_id').notNull(),
    recordType: text('record_type').notNull(), // QUOTATION | COMPARISON
    recordId: uuid('record_id').notNull(), // revision ID or comparison ID
    channel: text('channel').notNull(),
    messageId: uuid('message_id'),
    userId: uuid('user_id'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('share_events_record').on(t.recordId, t.at), index('share_events_account_day').on(t.accountId, t.at)],
);

// Outgoing messages (GR-26: saved before sending). Occurrence key is a database unique rule (P-37, P-41).
export const outgoingMessages = pgTable(
  'outgoing_messages',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    customerId: uuid('customer_id'),
    familyMemberId: uuid('family_member_id'),
    personName: text('person_name'),
    channel: text('channel').notNull(), // EMAIL | WHATSAPP
    // QUOTATION_EMAIL | COMPARISON_EMAIL | RENEWAL_REMINDER | BIRTHDAY | FAMILY_BIRTHDAY | ANNIVERSARY
    purpose: text('purpose').notNull(),
    recipient: text('recipient').notNull(),
    templateId: uuid('template_id'),
    templateVersion: integer('template_version'),
    variables: jsonb('variables').notNull().default(sql`'{}'::jsonb`),
    subject: text('subject'),
    body: text('body').notNull(),
    attachmentFileId: uuid('attachment_file_id'),
    occurrenceKey: text('occurrence_key').notNull(),
    // QUEUED | SENT | DELIVERED | READ | FAILED | SKIPPED | CANCELLED | STATUS_UNKNOWN | SHARED_MANUALLY
    status: text('status').notNull(),
    reason: text('reason'),
    providerId: text('provider_id'),
    providerError: text('provider_error'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at'),
    relatedType: text('related_type'), // QUOTATION | COMPARISON | RENEWAL | OCCASION
    relatedId: uuid('related_id'),
    resendOf: uuid('resend_of'),
    resendCount: integer('resend_count').notNull().default(0),
    charged: boolean('charged').notNull().default(false),
    sentAt: ts('sent_at'),
    deliveredAt: ts('delivered_at'),
    readAt: ts('read_at'),
    statusAt: ts('status_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('messages_occurrence').on(t.occurrenceKey),
    uniqueIndex('messages_provider').on(t.providerId),
    index('messages_account_status').on(t.accountId, t.status, t.createdAt),
    index('messages_customer').on(t.customerId, t.createdAt),
    index('messages_queue').on(t.status, t.nextAttemptAt),
  ],
);

// P-31 / P-32 Payments, "as recorded by the advisor". At most one PAID per quotation; one awaiting per revision.
// Renewal premium payments of regular-premium policies (P-38) are stored here too, with the policy.
export const payments = pgTable(
  'payments',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    kind: text('kind').notNull().default('QUOTATION'), // QUOTATION | RENEWAL_PREMIUM
    quotationId: uuid('quotation_id'),
    revisionId: uuid('revision_id'),
    policyId: uuid('policy_id'),
    insurerId: uuid('insurer_id').notNull(),
    method: text('method'), // LINK | BRANCH | OTHER
    link: text('link'),
    linkValidUntil: date('link_valid_until'),
    portalAmount: numeric('portal_amount', { precision: 14, scale: 2 }),
    note: text('note'),
    status: text('status').notNull(), // AWAITING_PAYMENT | PAID | FAILED | EXPIRED | CANCELLED | REVERSED
    mode: text('mode'),
    amount: numeric('amount', { precision: 14, scale: 2 }),
    paidOn: date('paid_on'),
    reference: text('reference'),
    referenceNorm: text('reference_norm'),
    chequeNumber: text('cheque_number'),
    chequeBank: text('cheque_bank'),
    chequeDate: date('cheque_date'),
    differenceReason: text('difference_reason'),
    differenceNote: text('difference_note'),
    receiptFileId: uuid('receipt_file_id'),
    reason: text('reason'),
    recordedBy: uuid('recorded_by'),
    recordedAt: ts('recorded_at'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at'),
    version: version(),
  },
  (t) => [
    uniqueIndex('payments_one_paid').on(t.quotationId).where(sql`${t.status} = 'PAID' and ${t.quotationId} is not null`),
    uniqueIndex('payments_one_awaiting').on(t.revisionId).where(sql`${t.status} = 'AWAITING_PAYMENT'`),
    uniqueIndex('payments_reference').on(t.accountId, t.insurerId, t.referenceNorm).where(sql`${t.status} = 'PAID' and ${t.referenceNorm} is not null`),
    index('payments_quotation').on(t.quotationId),
    index('payments_policy').on(t.policyId),
  ],
);

// P-55 Proposal (PR-YYYYMM-NNNNN). One open (DRAFT or SUBMITTED) proposal per quotation.
export const proposals = pgTable(
  'proposals',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    number: text('number').notNull(),
    quotationId: uuid('quotation_id')
      .notNull()
      .references(() => quotations.id),
    revisionId: uuid('revision_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    status: text('status').notNull().default('DRAFT'), // DRAFT | SUBMITTED | CANCELLED | ISSUED | DECLINED
    step: integer('step').notNull().default(1),
    members: jsonb('members').notNull(),
    declarations: jsonb('declarations').notNull().default(sql`'{}'::jsonb`),
    nominees: jsonb('nominees').notNull().default(sql`'[]'::jsonb`),
    policyId: uuid('policy_id'),
    reason: text('reason'),
    submittedAt: ts('submitted_at'),
    submittedBy: uuid('submitted_by'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at'),
    version: version(),
  },
  (t) => [
    uniqueIndex('proposals_number').on(t.accountId, t.number),
    uniqueIndex('proposals_one_open').on(t.quotationId).where(sql`${t.status} in ('DRAFT','SUBMITTED')`),
    index('proposals_account_status').on(t.accountId, t.status),
  ],
);

// P-33 / P-34 Policy (PL-NNNNNN). Insurer policy number unique per insurer in the account.
export const policies = pgTable(
  'policies',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    number: text('number').notNull(),
    source: text('source').notNull(), // QUOTATION | EXISTING
    soldByMe: boolean('sold_by_me').notNull().default(true),
    insurerId: uuid('insurer_id').notNull(),
    productId: uuid('product_id'),
    productName: text('product_name').notNull(),
    typeId: uuid('type_id'),
    quotationId: uuid('quotation_id'),
    revisionId: uuid('revision_id'),
    proposalId: uuid('proposal_id'),
    paymentId: uuid('payment_id'),
    renewalOfPolicyId: uuid('renewal_of_policy_id'),
    insurerPolicyNumber: text('insurer_policy_number'),
    policyNumberNorm: text('policy_number_norm'),
    issueDate: date('issue_date'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    frequency: text('frequency'), // SINGLE | YEARLY | HALF_YEARLY | QUARTERLY | MONTHLY
    nextDueDate: date('next_due_date'),
    sumInsured: numeric('sum_insured', { precision: 14, scale: 2 }),
    sumInsuredReason: text('sum_insured_reason'),
    premium: numeric('premium', { precision: 14, scale: 2 }),
    insured: jsonb('insured').notNull().default(sql`'[]'::jsonb`),
    declarations: jsonb('declarations'),
    documentFileId: uuid('document_file_id'),
    notes: text('notes'),
    expectedCommission: numeric('expected_commission', { precision: 14, scale: 2 }),
    graceDays: integer('grace_days'),
    nomineeRequired: boolean('nominee_required').notNull().default(false),
    maxNominees: integer('max_nominees'),
    status: text('status').notNull(), // AWAITING_ISSUANCE | ISSUED | EXPIRED | RENEWED | CANCELLED
    cancelReason: text('cancel_reason'),
    cancelDate: date('cancel_date'),
    refundAmount: numeric('refund_amount', { precision: 14, scale: 2 }),
    cancelNote: text('cancel_note'),
    snapshot: jsonb('snapshot'),
    statusAt: ts('status_at'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at'),
    version: version(),
  },
  (t) => [
    uniqueIndex('policies_number').on(t.accountId, t.number),
    uniqueIndex('policies_insurer_number').on(t.accountId, t.insurerId, t.policyNumberNorm).where(sql`${t.policyNumberNorm} is not null`),
    index('policies_customer').on(t.customerId),
    index('policies_account_status').on(t.accountId, t.status),
  ],
);

// P-36 correction history: the values before each correction, with reason and user.
export const policyHistory = pgTable('policy_history', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  policyId: uuid('policy_id').notNull(),
  kind: text('kind').notNull(), // RECORDED | CORRECTED | CANCELLED | RENEWED | PREMIUM_PAID
  oldValue: jsonb('old_value'),
  newValue: jsonb('new_value'),
  reason: text('reason'),
  userId: uuid('user_id'),
  at: ts('at').notNull().defaultNow(),
});

// P-35 Nominee list versions: one CURRENT per policy; never copied between policies.
export const nomineeVersions = pgTable(
  'nominee_versions',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => policies.id),
    customerId: uuid('customer_id').notNull(),
    versionNo: integer('version_no').notNull(),
    status: text('status').notNull(), // CURRENT | PREVIOUS
    nominees: jsonb('nominees').notNull(),
    endorsementRef: text('endorsement_ref'),
    effectiveDate: date('effective_date'),
    endorsementFileId: uuid('endorsement_file_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('nominees_one_current').on(t.policyId).where(sql`${t.status} = 'CURRENT'`), uniqueIndex('nominees_version').on(t.policyId, t.versionNo)],
);

// P-37 / P-38 Renewal cycle: one per policy and renewal date.
export const renewalCycles = pgTable(
  'renewal_cycles',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => policies.id),
    customerId: uuid('customer_id').notNull(),
    kind: text('kind').notNull(), // END_DATE | PREMIUM_DUE
    renewalDate: date('renewal_date').notNull(),
    graceEnd: date('grace_end').notNull(),
    status: text('status').notNull(), // UPCOMING | DUE | IN_FOLLOW_UP | RENEWED | NOT_RENEWING | LAPSED
    remindersPaused: boolean('reminders_paused').notNull().default(false),
    remindersSent: integer('reminders_sent').notNull().default(0),
    lastContactAt: ts('last_contact_at'),
    lastOutcome: text('last_outcome'),
    reason: text('reason'),
    note: text('note'),
    renewalQuotationId: uuid('renewal_quotation_id'),
    renewedByPolicyId: uuid('renewed_by_policy_id'),
    closedAt: ts('closed_at'),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('renewal_policy_date').on(t.policyId, t.renewalDate),
    index('renewal_account_status').on(t.accountId, t.status, t.renewalDate),
  ],
);

export const renewalEvents = pgTable(
  'renewal_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    cycleId: uuid('cycle_id').notNull(),
    kind: text('kind').notNull(), // CONTACT | STATUS | PAUSED | RESUMED | QUOTATION | REMINDER
    outcome: text('outcome'),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    note: text('note'),
    userId: uuid('user_id'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('renewal_events_cycle').on(t.cycleId, t.at)],
);

// ======================= Phase 6: communications, wallet, referral, subscription, administration =======================

// P-39 Message templates. STF drafts, a different ADM approves; WhatsApp templates also need Meta approval.
export const messageTemplates = pgTable(
  'message_templates',
  {
    id: id(),
    name: text('name').notNull(),
    channel: text('channel').notNull(), // WHATSAPP | EMAIL
    // BIRTHDAY | FAMILY_BIRTHDAY | ANNIVERSARY | RENEWAL_REMINDER | QUOTATION_EMAIL | KYC_RESULT_EMAIL | SUBSCRIPTION_REMINDER_EMAIL
    purpose: text('purpose').notNull(),
    metaCategory: text('meta_category'), // MARKETING | UTILITY (WhatsApp)
    language: text('language').notNull().default('English'),
    subject: text('subject'),
    body: text('body').notNull(),
    headerFileId: uuid('header_file_id'),
    // DRAFT | PENDING_APPROVAL | SUBMITTED_TO_META | ACTIVE | REJECTED | INACTIVE
    status: text('status').notNull().default('DRAFT'),
    rejectReason: text('reject_reason'),
    metaName: text('meta_name'),
    templateVersion: integer('template_version').notNull().default(1),
    makers: uuid('makers').array().notNull().default(sql`'{}'::uuid[]`),
    submittedAt: ts('submitted_at'),
    approvedBy: uuid('approved_by'),
    approvedAt: ts('approved_at'),
    approvalTicketId: uuid('approval_ticket_id'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at'),
    version: version(),
  },
  (t) => [uniqueIndex('templates_name').on(sql`lower(${t.name})`, t.channel, t.language)],
);

// P-40 Occasion greetings per account (Premium). Exclusions are per person.
export const occasionSettings = pgTable('occasion_settings', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id),
  enabled: boolean('enabled').notNull().default(false),
  birthdayTemplateId: uuid('birthday_template_id'),
  familyBirthdayTemplateId: uuid('family_birthday_template_id'),
  anniversaryTemplateId: uuid('anniversary_template_id'),
  updatedAt: ts('updated_at'),
  version: version(),
});

export const occasionExclusions = pgTable(
  'occasion_exclusions',
  {
    accountId: uuid('account_id').notNull(),
    personKey: text('person_key').notNull(), // customer:{id} | member:{id}
    by: uuid('by').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.personKey] })],
);

// P-47 Dedicated WhatsApp Business number (Premium): set up by SkyUp after the plan is bought.
export const whatsappNumbers = pgTable('whatsapp_numbers', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id),
  status: text('status').notNull(), // SETTING_UP | READY | STOPPED
  number: text('number'),
  requestedAt: ts('requested_at').notNull(),
  readyAt: ts('ready_at'),
  version: version(),
});

// Payment gateway orders (P-47 plans, P-56 wallet recharges). Credited only from the signed notification.
export const gatewayOrders = pgTable(
  'gateway_orders',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    purpose: text('purpose').notNull(), // SUBSCRIPTION | WALLET
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull(), // CREATED | PAID | FAILED
    gatewayOrderId: text('gateway_order_id'),
    gatewayPaymentId: text('gateway_payment_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    settledAt: ts('settled_at'),
  },
  (t) => [uniqueIndex('gateway_orders_payment').on(t.gatewayPaymentId), uniqueIndex('gateway_orders_order').on(t.gatewayOrderId), index('gateway_orders_account').on(t.accountId, t.createdAt)],
);

// P-56 Wallet statement. Each debit references its outgoing message (once per message).
export const walletTransactions = pgTable(
  'wallet_transactions',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    kind: text('kind').notNull(), // RECHARGE | DEBIT | CREDIT
    status: text('status').notNull(), // PENDING | SUCCESS | FAILED
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    balanceAfter: numeric('balance_after', { precision: 14, scale: 2 }),
    messageId: uuid('message_id'),
    orderId: uuid('order_id'),
    reason: text('reason'),
    by: uuid('by'),
    createdAt: createdAt(),
    settledAt: ts('settled_at'),
  },
  (t) => [uniqueIndex('wallet_debit_once').on(t.messageId).where(sql`${t.kind} = 'DEBIT'`), uniqueIndex('wallet_order_once').on(t.orderId), index('wallet_account').on(t.accountId, t.createdAt)],
);

// P-47 GST invoices: one series per financial year.
export const subscriptionInvoices = pgTable(
  'subscription_invoices',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    number: text('number').notNull(),
    subscriptionId: uuid('subscription_id'),
    plan: text('plan').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    cgst: numeric('cgst', { precision: 14, scale: 2 }).notNull().default('0.00'),
    sgst: numeric('sgst', { precision: 14, scale: 2 }).notNull().default('0.00'),
    igst: numeric('igst', { precision: 14, scale: 2 }).notNull().default('0.00'),
    total: numeric('total', { precision: 14, scale: 2 }).notNull(),
    gstin: text('gstin'),
    state: text('state'),
    source: text('source').notNull(), // GATEWAY | OFFLINE | WALLET
    reference: text('reference'),
    referenceNorm: text('reference_norm'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('invoices_number').on(t.number), uniqueIndex('invoices_offline_ref').on(t.referenceNorm).where(sql`${t.source} = 'OFFLINE'`), index('invoices_account').on(t.accountId)],
);

export const invoiceCounters = pgTable('invoice_counters', {
  financialYear: text('financial_year').primaryKey(), // 2026-27
  value: integer('value').notNull().default(0),
});

// P-44 Referrers and their codes. A referrer belongs to exactly one advisor account.
export const referrerProfiles = pgTable('referrer_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  accountId: uuid('account_id').notNull(),
  note: text('note'),
  createdAt: createdAt(),
});

export const referralCodes = pgTable(
  'referral_codes',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    referrerUserId: uuid('referrer_user_id').notNull(),
    code: text('code').notNull(),
    validUntil: date('valid_until').notNull(),
    status: text('status').notNull(), // ACTIVE | EXPIRED | REVOKED
    createdAt: createdAt(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('referral_code_unique').on(t.code), uniqueIndex('referral_one_active').on(t.referrerUserId).where(sql`${t.status} = 'ACTIVE'`)],
);

// P-46 Referral submissions (public form). Invalid submissions are refused and not stored.
export const referralSubmissions = pgTable(
  'referral_submissions',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    codeId: uuid('code_id').notNull(),
    referrerUserId: uuid('referrer_user_id').notNull(),
    name: text('name').notNull(),
    mobile: text('mobile').notNull(),
    email: text('email'),
    knowsAs: text('knows_as').notNull(),
    interestTypeId: uuid('interest_type_id').notNull(),
    city: text('city'),
    message: text('message'),
    result: text('result').notNull(), // LEAD_CREATED | LINKED_TO_EXISTING
    leadId: uuid('lead_id'),
    customerId: uuid('customer_id'),
    lastStatus: text('last_status'),
    createdAt: createdAt(),
  },
  (t) => [index('referrals_referrer').on(t.referrerUserId, t.createdAt), index('referrals_account').on(t.accountId, t.createdAt)],
);

// P-49 Configuration change requests: one pending change per setting.
export const configChanges = pgTable(
  'config_changes',
  {
    id: id(),
    settingId: text('setting_id').notNull(),
    oldValue: jsonb('old_value').notNull(),
    newValue: jsonb('new_value').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull(), // PENDING_APPROVAL | APPLIED | REJECTED
    requestedBy: uuid('requested_by').notNull(),
    requestedAt: ts('requested_at').notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: ts('decided_at'),
    rejectReason: text('reject_reason'),
    approvalTicketId: uuid('approval_ticket_id'),
  },
  (t) => [uniqueIndex('config_one_pending').on(t.settingId).where(sql`${t.status} = 'PENDING_APPROVAL'`)],
);

// P-52 Account export jobs.
export const exportJobs = pgTable(
  'export_jobs',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    include: text('include').array().notNull(),
    status: text('status').notNull(), // QUEUED | READY | DOWNLOAD_EXPIRED | FAILED
    fileId: uuid('file_id'),
    readyAt: ts('ready_at'),
    expiresAt: ts('expires_at'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('exports_account').on(t.accountId, t.createdAt)],
);

// P-57 Support grants: one ACTIVE grant per SkyUp user and account; every record opened is logged.
export const supportGrants = pgTable(
  'support_grants',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    staffUserId: uuid('staff_user_id').notNull(),
    reason: text('reason').notNull(),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    status: text('status').notNull(), // ACTIVE | ENDED | EXPIRED
    grantedBy: uuid('granted_by').notNull(),
    ticketId: uuid('ticket_id'),
    endedAt: ts('ended_at'),
    endedBy: uuid('ended_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('grants_one_active').on(t.staffUserId, t.accountId).where(sql`${t.status} = 'ACTIVE'`), index('grants_account').on(t.accountId, t.createdAt)],
);

export const supportViews = pgTable(
  'support_views',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    grantId: uuid('grant_id').notNull(),
    accountId: uuid('account_id').notNull(),
    staffUserId: uuid('staff_user_id').notNull(),
    recordType: text('record_type').notNull(),
    recordId: text('record_id'),
    label: text('label').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('support_views_grant').on(t.grantId, t.at)],
);

// Provider webhooks (P-42, P-47, P-56) are processed once by their event ID.
export const webhookEvents = pgTable(
  'webhook_events',
  {
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.eventId] })],
);

// Email addresses that bounced hard: no more emails until the address is changed (P-42 step 4).
export const emailSuppressions = pgTable('email_suppressions', {
  email: text('email').primaryKey(),
  reason: text('reason').notNull(),
  at: ts('at').notNull().defaultNow(),
});

// Daily jobs (SYS-01 … SYS-13) run once per IST date at the time set in configuration.
export const jobRuns = pgTable(
  'job_runs',
  {
    name: text('name').notNull(),
    runDate: date('run_date').notNull(),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
    result: jsonb('result'),
  },
  (t) => [primaryKey({ columns: [t.name, t.runDate] })],
);
