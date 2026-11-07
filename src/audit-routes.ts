import { AUDIT_READER, type AuditLogRow, type AuditReader, auditQuerySchema } from '@framework/database';
import { authorizationGuard, type FrameworkEnv, type MountAuthorization, notFound, resolve } from '@framework/http';
import { validate } from '@framework/validation';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v4';

const auditIdParamSchema = z.object({ auditId: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();

export interface AuditRoutesOptions {
  /** Custom reader resolution (default: the request scope's AUDIT_READER). */
  readonly reader?: (c: Context<FrameworkEnv>) => AuditReader;
  /**
   * Required mount-time authorization: a guard that throws an `HttpError`
   * (e.g. `forbidden()`) to deny, or the explicit `'public'` opt-out.
   * Typical admin guard: `requireAbility('audit.admin')` from
   * `@framework/auth`.
   */
  readonly authorize: MountAuthorization;
}

/**
 * Audit trail endpoints over the framework-owned `audit_logs` table:
 *
 * ```text
 * GET /audit                     paginated, filterable trail
 * GET /audit/:auditId            one entry
 * ```
 *
 * `GET /audit?resource=products&resourceId=<id>` serves the per-entity trail;
 * `actorId`/`correlationId` filters answer user and correlation queries.
 * Authorization is required at mount time — pass a guard (e.g.
 * `requireAbility('audit.admin')`) or the explicit `'public'` opt-out; the
 * guard runs before validation, so anonymous callers get 401/403 and never
 * observe schema details.
 */
export function auditRoutes(options: AuditRoutesOptions): Hono<FrameworkEnv> {
  const readerFor = options.reader ?? ((c: Context<FrameworkEnv>) => resolve(c, AUDIT_READER));
  const guard = authorizationGuard(options.authorize);
  return new Hono<FrameworkEnv>()
    .get('/', guard, validate('query', auditQuerySchema), async (c) => {
      const query = c.req.valid('query');
      const { page, limit, ...filters } = query;
      const reader = readerFor(c);
      const trail = await reader.page({ page, limit }, filters);
      return c.json(trail, 200);
    })
    .get('/:auditId', guard, validate('param', auditIdParamSchema), async (c) => {
      const entry: AuditLogRow | null = await readerFor(c).findById(c.req.valid('param').auditId);
      if (!entry) throw notFound('Audit entry not found');
      return c.json(entry, 200);
    });
}
