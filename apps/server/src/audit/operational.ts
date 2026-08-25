import type { Pool, QueryResultRow } from "pg";

export interface OperationalAuditActor {
  readonly id: string;
  readonly role: "ADMINISTRATOR" | "PSYCHIATRIST";
}

export type OperationalTargetType = "USER" | "DEPLOYMENT_EVIDENCE" | "MODEL_ENDPOINT" | "BACKUP";

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

export interface AuditQuery {
  readonly offset?: number;
  readonly limit?: number;
  readonly eventType?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface AuditPage<Event> {
  readonly events: readonly Event[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
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
  total_count: string;
}

export interface OperationalAuditQuery extends AuditQuery {
  readonly targetType?: OperationalTargetType;
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
  return (await queryOperationalAuditEvents(pool, actor, { limit: 10_000 })).events;
}

export async function queryOperationalAuditEvents(
  pool: Pool,
  actor: OperationalAuditActor,
  query: OperationalAuditQuery = {},
): Promise<AuditPage<OperationalAuditEvent>> {
  if (actor.role !== "ADMINISTRATOR") throw new OperationalAuditAuthorizationError();
  const authorization = await pool.query(
    `SELECT 1 FROM insight.users
     WHERE id = $1 AND role = 'ADMINISTRATOR' AND status <> 'DISABLED'`,
    [actor.id],
  );
  if (authorization.rowCount !== 1) throw new OperationalAuditAuthorizationError();

  const offset = query.offset ?? 0;
  const limit = query.limit ?? 25;
  const result = await pool.query<OperationalAuditRow>(
    `WITH events AS (
       SELECT id, event_type, actor_user_id, 'USER'::text AS target_type,
              subject_user_id::text AS target_id, target_version::text,
              CASE WHEN before_metadata IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
                'role', before_metadata->'role', 'status', before_metadata->'status',
                'passwordPolicyVersion', before_metadata->'passwordPolicyVersion',
                'bootstrapCredentialActive', before_metadata->'bootstrapCredentialActive'
              )) END AS before_metadata,
              CASE WHEN after_metadata IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
                'role', after_metadata->'role', 'status', after_metadata->'status',
                'passwordPolicyVersion', after_metadata->'passwordPolicyVersion',
                'bootstrapCredentialActive', after_metadata->'bootstrapCredentialActive'
              )) END AS after_metadata,
              request_id, occurred_at
       FROM insight.security_audit_events
       UNION ALL
       SELECT id, event_type, actor_user_id, 'DEPLOYMENT_EVIDENCE',
              evidence_version::text, evidence_version::text, NULL::jsonb,
              jsonb_build_object('environmentStatus', environment_status), request_id, occurred_at
       FROM insight.operational_audit_events
       UNION ALL
       SELECT id, event_type, actor_user_id, 'MODEL_ENDPOINT',
              configuration_id::text, configuration_version::text,
              NULL::jsonb, NULL::jsonb, request_id, occurred_at
       FROM insight.model_endpoint_audit_events
       UNION ALL
       SELECT id, event_type, actor_user_id, 'BACKUP', backup_id::text, NULL::text,
              NULL::jsonb, metadata, request_id, occurred_at
       FROM insight.database_backup_audit_events
      )
     SELECT *, count(*) OVER()::text AS total_count
     FROM events
     WHERE ($1::text IS NULL OR event_type = $1)
       AND ($2::text IS NULL OR target_type = $2)
       AND ($3::timestamptz IS NULL OR occurred_at >= $3)
       AND ($4::timestamptz IS NULL OR occurred_at <= $4)
     ORDER BY occurred_at DESC, id DESC
     OFFSET $5 LIMIT $6`,
    [
      query.eventType ?? null,
      query.targetType ?? null,
      query.from ?? null,
      query.to ?? null,
      offset,
      limit,
    ],
  );

  return {
    events: result.rows.map(materializeOperationalEvent),
    offset,
    limit,
    total: Number(result.rows[0]?.total_count ?? 0),
  };
}

function materializeOperationalEvent(row: OperationalAuditRow): OperationalAuditEvent {
  return {
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
  };
}
