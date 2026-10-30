import type { AuditAction, Prisma } from '../generated/prisma/client.js';

/** Column limits shared by AuditLog and RefreshToken (see schema.prisma). */
export const IP_ADDRESS_MAX_LENGTH = 45;
export const USER_AGENT_MAX_LENGTH = 500;

/**
 * Cuts a string to at most `max` characters without splitting a surrogate pair.
 * Empty or missing values become null.
 */
export function fitColumn(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  // Drop a dangling high surrogate whose low half was cut off.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export interface AuditEntry {
  action: AuditAction;
  /** The acting admin; null/omitted when unknown (e.g. a login for a non-existent email). */
  adminId?: string | null | undefined;
  /** Required by the schema, e.g. "Admin", "Movie", "Showtime". */
  entity: string;
  entityId?: string | null | undefined;
  details?: Prisma.InputJsonObject | undefined;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
}

/** Accepts the PrismaClient or an interactive-transaction client. */
export type AuditDb = Pick<Prisma.TransactionClient, 'auditLog'>;

/**
 * Writes one AuditLog row.
 *
 * SECURITY: never pass passwords, password hashes, tokens (raw or hashed), cookies or
 * secrets, in `details` or anywhere else. Audit rows are read by admins and kept long-term.
 */
export async function writeAudit(db: AuditDb, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      action: entry.action,
      adminId: entry.adminId ?? null,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      ...(entry.details && { details: entry.details }),
      ipAddress: fitColumn(entry.ipAddress, IP_ADDRESS_MAX_LENGTH),
      userAgent: fitColumn(entry.userAgent, USER_AGENT_MAX_LENGTH),
    },
    select: { id: true },
  });
}
