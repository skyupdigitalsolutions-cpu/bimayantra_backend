// Technical constants. These are NOT business rules and the document does not name them; they only
// make the software work safely. Business numbers live in CFG settings (settings.ts).
// Each one is listed in docs/DOCUMENT-CHANGES.md so the document owner can confirm or move it to CFG.
export const TECHNICAL = {
  /** Access-token lifetime. Every request still re-checks the session in the database. */
  accessTokenSeconds: 5 * 60,
  /** After a refresh-token rotation the previous token is accepted this long (parallel tabs). */
  refreshGraceSeconds: 30,
  /** An idempotency key still IN_PROGRESS after this long is treated as abandoned (server crash). */
  idempotencyStaleSeconds: 120,
  /** Timeout for one call to the SMS provider. */
  smsTimeoutMs: 10_000,
  /** Longest JSON body accepted. */
  jsonBodyLimit: '256kb',
} as const;
