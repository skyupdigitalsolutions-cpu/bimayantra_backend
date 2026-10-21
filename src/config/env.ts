// Environment variables, checked once at start-up. The server refuses to start with a wrong value.
// Business numbers (OTP validity, limits, job times …) are NOT here: they are CFG settings (src/config/settings.ts).
import { z } from 'zod';

const secret = (name: string) => z.string().min(32, `${name} must be at least 32 characters`);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0), // 1 behind Railway / Render / a load balancer

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    DATABASE_SSL: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

    JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
    OTP_SECRET: secret('OTP_SECRET'),
    // 32 random bytes, base64 — encrypts PAN and Aadhaar field by field (GR-36, NFR-07)
    FIELD_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'FIELD_ENCRYPTION_KEY must be 32 bytes, base64 encoded'),

    // Web addresses allowed to call the API with cookies (comma separated). The website normally calls
    // through its own /api proxy, so this is only needed for direct browser calls.
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
    COOKIE_SECURE: z.enum(['true', 'false']).optional(),
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

    SMS_PROVIDER: z.enum(['console', 'msg91', 'memory']).default('console'), // memory = automated tests only
    MSG91_AUTH_KEY: z.string().default(''),
    MSG91_OTP_TEMPLATE_ID: z.string().default(''),
    MSG91_MOBILE_CHANGED_TEMPLATE_ID: z.string().default(''),
    // Development/test/staging only: every OTP is this code (never allowed in production, Section 20.2)
    OTP_FIXED_CODE: z
      .string()
      .regex(/^\d{4,8}$/)
      .optional()
      .or(z.literal('').transform(() => undefined)),

    // Files (FLD-22, GR-32): private storage and a virus scan before a file is accepted
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    UPLOAD_DIR: z.string().default('./uploads'),
    S3_BUCKET: z.string().default(''),
    S3_REGION: z.string().default('ap-south-1'),
    S3_ENDPOINT: z.string().default(''),
    SCAN_PROVIDER: z.enum(['none', 'clamav']).default('none'),
    CLAMAV_HOST: z.string().default('127.0.0.1'),
    CLAMAV_PORT: z.coerce.number().int().default(3310),

    // Email (KYC result, subscription reminders …): console prints to the terminal (development only)
    EMAIL_PROVIDER: z.enum(['console', 'smtp', 'memory']).default('console'),
    SMTP_URL: z.string().default(''),
    EMAIL_FROM: z.string().default('Bimayantra <no-reply@bimayantra.in>'),
    // Website address used in email links
    APP_URL: z.string().default('http://localhost:3000'),

    // WhatsApp Business provider for automated messages (P-37, P-41, Premium). none = not set up yet:
    // automated WhatsApp messages are skipped. log = print to the terminal (development). memory = tests.
    WHATSAPP_PROVIDER: z.enum(['none', 'log', 'memory', 'http']).default('none'),
    WHATSAPP_API_URL: z.string().default(''),
    WHATSAPP_API_KEY: z.string().default(''),
    // Shared secrets used to check provider webhooks (P-42, P-47, P-56). Unsigned calls are refused.
    WHATSAPP_WEBHOOK_SECRET: z.string().default(''),
    EMAIL_WEBHOOK_SECRET: z.string().default(''),
    // Payment gateway for plans and wallet recharges (P-47, P-56). none = payments not available (SUB-18);
    // razorpay = Razorpay orders and signed webhooks; test = development only (a test page completes it).
    PAYMENT_GATEWAY: z.enum(['none', 'razorpay', 'test']).default('none'),
    RAZORPAY_KEY_ID: z.string().default(''),
    RAZORPAY_KEY_SECRET: z.string().default(''),
    PAYMENT_WEBHOOK_SECRET: z.string().default(''),

    // Background jobs (pg-boss in PostgreSQL). inline = run at once in the same process (automated tests)
    JOBS_MODE: z.enum(['queue', 'inline', 'off']).default('queue'),

    TERMS_VERSION: z.string().default('2026-10-11'),
    SUPPORT_EMAIL: z.email().default('support@bimayantra.in'),
    // Start-up data (npm run seed): the first SkyUp Admin. Demo data only outside production.
    SEED_ADMIN_MOBILE: z.string().default(''),
    SEED_ADMIN_NAME: z.string().default('SkyUp Admin'),
    // A second SkyUp Admin: catalogue approvals need a different admin (maker-checker) until P-48 lets
    // SkyUp add users from the screen (Phase 6)
    SEED_SECOND_ADMIN_MOBILE: z.string().default(''),
    SEED_SECOND_ADMIN_NAME: z.string().default('SkyUp Approver'),
    SEED_DEMO_DATA: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    TEST_CLOCK_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.OTP_FIXED_CODE) ctx.addIssue({ code: 'custom', path: ['OTP_FIXED_CODE'], message: 'A fixed OTP can never be used in production' });
      if (env.SMS_PROVIDER === 'console') ctx.addIssue({ code: 'custom', path: ['SMS_PROVIDER'], message: 'A real SMS provider is required in production' });
      if (env.SEED_DEMO_DATA) ctx.addIssue({ code: 'custom', path: ['SEED_DEMO_DATA'], message: 'Demo data can never be created in production' });
      if (env.SCAN_PROVIDER === 'none') ctx.addIssue({ code: 'custom', path: ['SCAN_PROVIDER'], message: 'Uploaded files must be virus-scanned in production (SCAN_PROVIDER=clamav)' });
      if (env.EMAIL_PROVIDER !== 'smtp') ctx.addIssue({ code: 'custom', path: ['EMAIL_PROVIDER'], message: 'A real email provider is required in production (EMAIL_PROVIDER=smtp)' });
      if (env.PAYMENT_GATEWAY === 'test') ctx.addIssue({ code: 'custom', path: ['PAYMENT_GATEWAY'], message: 'The test payment gateway can never be used in production' });
      if (env.WHATSAPP_PROVIDER === 'log' || env.WHATSAPP_PROVIDER === 'memory') ctx.addIssue({ code: 'custom', path: ['WHATSAPP_PROVIDER'], message: 'Use WHATSAPP_PROVIDER=http (or none) in production' });
      if (env.TEST_CLOCK_ENABLED) ctx.addIssue({ code: 'custom', path: ['TEST_CLOCK_ENABLED'], message: 'The test clock can never be used in production' });
    }
    if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) ctx.addIssue({ code: 'custom', path: ['S3_BUCKET'], message: 'S3_BUCKET is required for STORAGE_DRIVER=s3' });
    if (env.EMAIL_PROVIDER === 'smtp' && !env.SMTP_URL) ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'SMTP_URL is required for EMAIL_PROVIDER=smtp' });
    if ((env.EMAIL_PROVIDER === 'memory' || env.JOBS_MODE === 'inline') && env.NODE_ENV !== 'test') {
      ctx.addIssue({ code: 'custom', path: ['JOBS_MODE'], message: 'EMAIL_PROVIDER=memory and JOBS_MODE=inline are only for automated tests' });
    }
    if (env.PAYMENT_GATEWAY === 'razorpay' && (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.PAYMENT_WEBHOOK_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['PAYMENT_GATEWAY'], message: 'RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and PAYMENT_WEBHOOK_SECRET are required for PAYMENT_GATEWAY=razorpay' });
    }
    if (env.WHATSAPP_PROVIDER === 'http' && (!env.WHATSAPP_API_URL || !env.WHATSAPP_WEBHOOK_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['WHATSAPP_PROVIDER'], message: 'WHATSAPP_API_URL and WHATSAPP_WEBHOOK_SECRET are required for WHATSAPP_PROVIDER=http' });
    }
    if (env.SMS_PROVIDER === 'memory' && env.NODE_ENV !== 'test') {
      ctx.addIssue({ code: 'custom', path: ['SMS_PROVIDER'], message: 'SMS_PROVIDER=memory is only for automated tests' });
    }
    if (env.SMS_PROVIDER === 'msg91' && (!env.MSG91_AUTH_KEY || !env.MSG91_OTP_TEMPLATE_ID)) {
      ctx.addIssue({ code: 'custom', path: ['MSG91_AUTH_KEY'], message: 'MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID are required for SMS_PROVIDER=msg91' });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const cookieSecure = env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
