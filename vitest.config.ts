import { defineConfig } from 'vitest/config';

// Tests run against a real PostgreSQL database (bimayantra_test), one file at a time.
export const testEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/bimayantra_test',
  JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-0001',
  OTP_SECRET: 'test-otp-secret-test-otp-secret-test-0001',
  FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  SMS_PROVIDER: 'memory',
  EMAIL_PROVIDER: 'memory',
  JOBS_MODE: 'inline',
  UPLOAD_DIR: '/tmp/bimayantra-test-uploads',
  TRUST_PROXY: '1',
  SUPPORT_EMAIL: 'support@bimayantra.in',
  WHATSAPP_PROVIDER: 'memory',
  WHATSAPP_WEBHOOK_SECRET: 'test-whatsapp-webhook-secret',
  EMAIL_WEBHOOK_SECRET: 'test-email-webhook-secret',
  PAYMENT_GATEWAY: 'test',
  PAYMENT_WEBHOOK_SECRET: 'test-payment-webhook-secret',
};

export default defineConfig({
  test: {
    env: testEnv,
    globalSetup: ['./tests/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // NFR-13: validators, state changes and (later) the premium engine need at least CFG-144 line coverage
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/http/**', 'src/modules/**'],
      thresholds: { lines: 80 },
      reporter: ['text-summary', 'html'],
    },
  },
});
