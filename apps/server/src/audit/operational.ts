import type { Pool, QueryResultRow } from "pg";

export interface OperationalAuditActor {
  readonly id: string;
  readonly role: "ADMINISTRATOR" | "PSYCHIATRIST";
}

type OperationalTargetType = "USER" | "DEPLOYMENT_EVIDENCE";

export interface OperationalAuditEvent {
  readonly id: string;
  readonly eventType: string;
  readonly actorUserId: string | null;
  readonly target: {
    readonly type: OperationalTargetType;
    readonly id: string;
    readonly version: string | null;
  } | null;
  readonly beforeMetadata: Readonly<Record<string, unknown>> | null;
  readonly afterMetadata: Readonly<Record<string, unknown>> | null;
  readonly requestId: string | null;
  readonly occurredAt: string;
}

interface OperationalAuditRow extends QueryResultRow {
  id: string;
  event_type: string;
  actor_user_id: string | null;
  target_type: OperationalTargetType;
  target_id: string | null;
  target_version: string | null;
  before_metadata: Record<string, unknown> | null;
  after_metadata: Record<string, unknown> | null;
  request_id: string | null;
  occurred_at: Date;
}

export class OperationalAuditAuthorizationError extends Error {
  constructor() {
    super("Operational audit is available only to Administrators.");
    this.name = "OperationalAuditAuthorizationError";
  }
}

export async function listOperationalAuditEvents(
  pool: Pool,
  actor: OperationalAuditActor,
): Promise<readonly OperationalAuditEvent[]> {
  if (actor.role !== "ADMINISTRATOR") throw new OperationalAuditAuthorizationError();
  const authorization = await pool.query(
    `SELECT 1 FROM insight.users
     WHERE id = $1 AND role = 'ADMINISTRATOR' AND status <> 'DISABLED'`,
    [actor.id],
  );
  if (authorization.rowCount !== 1) throw new OperationalAuditAuthorizationError();

  const result = await pool.query<OperationalAuditRow>(`
    SELECT id, event_type, actor_user_id, 'USER' AS target_type,
           subject_user_id::text AS target_id, target_version::text,
           before_metadata, after_metadata, request_id, occurred_at
    FROM insight.security_audit_events
    UNION ALL
    SELECT id, event_type, actor_user_id, 'DEPLOYMENT_EVIDENCE' AS target_type,
           evidence_version::text AS target_id, evidence_version::text AS target_version,
           NULL::jsonb AS before_metadata,
           jsonb_build_object('environmentStatus', environment_status) AS after_metadata,
           request_id, occurred_at
    FROM insight.operational_audit_events
    ORDER BY occurred_at, id
  `);

  return result.rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    target: row.target_id
      ? { type: row.target_type, id: row.target_id, version: row.target_version }
      : null,
    beforeMetadata: row.before_metadata,
    afterMetadata: row.after_metadata,
    requestId: row.request_id,
    occurredAt: row.occurred_at.toISOString(),
  }));
}
