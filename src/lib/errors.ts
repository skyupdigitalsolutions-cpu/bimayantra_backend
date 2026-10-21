// Errors with a message ID (GR-05): every known failure has its own message; GEN-99 only for unknown causes.
// The error handler turns these into the HTTP results of Section 2.5.
import type { Params } from '../messages/messages.js';

export type FieldError = { field: string; code: string; params?: Params };

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly params: Params = {},
    readonly fields: FieldError[] = [],
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

/** 400/422 with a field list (GEN-02 is added by the handler when there are 2 or more). */
export const fieldErrors = (fields: FieldError[]) =>
  fields.length === 1 ? new AppError(422, fields[0]!.code, fields[0]!.params ?? {}, fields) : new AppError(422, 'GEN-02', { count: fields.length }, fields);
export const fieldError = (field: string, code: string, params?: Params) => fieldErrors([{ field, code, ...(params ? { params } : {}) }]);
export const forbidden = (code = 'GEN-03', params?: Params) => new AppError(403, code, params);
export const notFound = () => new AppError(404, 'GEN-11'); // never reveals whether a record exists elsewhere (GR-18)
export const stateConflict = (recordType: string, currentStatus: string) =>
  new AppError(409, 'GEN-04', { 'record type': recordType, 'current status': currentStatus }, [], { reason: 'state' });
export const versionConflict = (recordType: string, changedFields: string[] = []) =>
  new AppError(409, 'GEN-05', { 'record type': recordType }, [], { reason: 'version', changedFields });
export const tooMany = (code = 'GEN-15', params?: Params, retryAfterSeconds?: number) =>
  new AppError(429, code, params, [], retryAfterSeconds ? { retryAfterSeconds } : {});
export const unauthorized = (code = 'GEN-09', reason?: string) => new AppError(401, code, {}, [], reason ? { reason } : {});
