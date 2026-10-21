import { pino } from 'pino';
import { env } from '../config/env.js';

// Structured JSON logs in staging/production; readable logs on a developer laptop.
// OTP codes, tokens, cookies, PAN and Aadhaar are never written to logs (P-01 backend rules, GR-36).
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.code', '*.otp', '*.pan', '*.aadhaar', '*.refreshToken', '*.accessToken'],
    censor: '[redacted]',
  },
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }
    : {}),
});
