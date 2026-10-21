// Values the middleware attaches to each request.
export type Role = 'ADV' | 'AST' | 'REF' | 'STF' | 'ADM';

export type AuthContext = {
  userId: string;
  sessionId: string;
  role: Role;
  /** null for SkyUp Staff and Admin (they belong to no advisor account). */
  accountId: string | null;
  name: string;
  mobile: string;
  /** GR-33: subscription EXPIRED → view, search and export only. */
  readOnly: boolean;
};

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
      /** The exact request body, kept for webhook signature checks (P-42, P-47, P-56). */
      rawBody?: Buffer;
    }
    interface Locals {
      /** Saved with an idempotent result but never sent to the browser (for example the session it started). */
      idempotencyPrivate?: Record<string, unknown>;
    }
  }
}
