import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { TECHNICAL } from './config/technical.js';
import { errorHandler, jsonOnlyWrites, notFoundRoute, refreshSettings, requestId } from './http/middleware.js';
import { logger } from './lib/logger.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { apiSystemRouter, systemRouter } from './modules/system/system.routes.js';
import { assistantsRouter } from './modules/assistants/assistants.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { filesRouter } from './modules/files/files.routes.js';
import { kycAdminRouter } from './modules/kyc/kyc.admin.routes.js';
import { agentCodesAdminRouter } from './modules/insurers/agentcodes.admin.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { profileRouter } from './modules/profile/profile.routes.js';
import { tasksRouter } from './modules/tasks/tasks.routes.js';
import { approvalsRouter, catalogueAdminRouter } from './modules/catalogue/catalogue.admin.routes.js';
import { catalogueRouter } from './modules/catalogue/catalogue.routes.js';
import { leadsRouter } from './modules/leads/leads.routes.js';
import { customersRouter } from './modules/customers/customers.routes.js';
import { documentsRouter } from './modules/documents/documents.routes.js';
import { bestFitRouter, comparisonsRouter, paymentsRouter, policiesRouter, proposalsRouter, publicSalesRouter, quotationsRouter } from './modules/policies/sales.routes.js';
import './modules/jobs/daily.js';
import { advisorAdminRouter, billingRouter, communicationsRouter, publicReferralRouter, referrerRouter, referrersRouter, renewalsRouter, skyupAdminRouter, templatesRouter } from './modules/admin/phase6.routes.js';
import { unsubscribeRouter, webhooksRouter } from './modules/messages/webhooks.routes.js';
import './modules/messages/messages.service.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
      // Never log bodies: they can hold OTP codes and personal data
      serializers: {
        req: (req: { method: string; url: string; id: string }) => ({ method: req.method, url: req.url.split('?')[0], id: req.id }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  // Only for direct browser calls (the website uses its own proxy; the phone app needs no CORS)
  if (env.CORS_ORIGINS.length)
    app.use(cors({ origin: env.CORS_ORIGINS, credentials: true, exposedHeaders: ['x-access-token', 'x-refresh-token', 'x-access-expires-in', 'x-request-id', 'retry-after'] }));
  app.use(express.json({ limit: TECHNICAL.jsonBodyLimit, verify: (req, _res, buf) => void ((req as unknown as { rawBody: Buffer }).rawBody = buf) }));
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader('cache-control', 'no-store');
    next();
  });

  app.use(systemRouter);
  app.use('/api/v1', jsonOnlyWrites, refreshSettings);
  app.use('/api/v1', apiSystemRouter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/files', filesRouter);
  app.use('/api/v1/notifications', notificationsRouter);
  app.use('/api/v1/dashboard', dashboardRouter);
  app.use('/api/v1/tasks', tasksRouter);
  app.use('/api/v1/assistants', assistantsRouter);
  app.use('/api/v1/admin/kyc', kycAdminRouter);
  app.use('/api/v1/admin/agent-codes', agentCodesAdminRouter);
  app.use('/api/v1/admin/catalogue', catalogueAdminRouter);
  app.use('/api/v1/admin/approvals', approvalsRouter);
  app.use('/api/v1/catalogue', catalogueRouter);
  app.use('/api/v1/leads', leadsRouter);
  app.use('/api/v1/customers', customersRouter);
  app.use('/api/v1/documents', documentsRouter);
  app.use('/api/v1/best-fit', bestFitRouter);
  app.use('/api/v1/quotations', quotationsRouter);
  app.use('/api/v1/comparisons', comparisonsRouter);
  app.use('/api/v1/payments', paymentsRouter);
  app.use('/api/v1/proposals', proposalsRouter);
  app.use('/api/v1/policies', policiesRouter);
  app.use('/api/v1/public', publicSalesRouter);
  app.use('/api/v1/public', publicReferralRouter);
  app.use('/api/v1/public', unsubscribeRouter);
  app.use('/api/v1/webhooks', webhooksRouter);
  app.use('/api/v1/renewals', renewalsRouter);
  app.use('/api/v1/communications', communicationsRouter);
  app.use('/api/v1/admin/templates', templatesRouter);
  app.use('/api/v1/admin', skyupAdminRouter);
  app.use('/api/v1/billing', billingRouter);
  app.use('/api/v1/referrers', referrersRouter);
  app.use('/api/v1/referral', referrerRouter);
  app.use('/api/v1/me', advisorAdminRouter);
  app.use('/api/v1', profileRouter);

  app.use(notFoundRoute);
  app.use(errorHandler);
  return app;
}
