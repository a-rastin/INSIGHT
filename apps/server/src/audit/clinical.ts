import type { Pool } from "pg";

import {
  listPatientAuditEvents,
  type PatientActor,
  type PatientAuditEvent,
} from "../patient/patients.js";
import {
  listResearchCaseTransitionAuditEvents,
  type ResearchCaseTransitionAuditEvent,
} from "../patient/workflow.js";
import type { AuditPage, AuditQuery } from "./operational.js";

export type ClinicalAuditKind = "PATIENT" | "WORKFLOW";

export interface ClinicalAuditQuery extends AuditQuery {
  readonly patientId: string;
  readonly kind?: ClinicalAuditKind;
}

export interface ClinicalAuditEvent {
  readonly id: string;
  readonly kind: ClinicalAuditKind;
  readonly eventType: string;
  readonly patientLink: { readonly patientId: string; readonly researchCaseId: string };
  readonly targetVersion: number;
  readonly before: Readonly<object> | null;
  readonly after: Readonly<object> | null;
  readonly provenance: {
    readonly payloadReference: string | null;
    readonly domainResultIds: readonly string[];
    readonly details: Readonly<Record<string, unknown>> | null;
  };
  readonly actorUserId: string | null;
  readonly requestId: string;
  readonly occurredAt: string;
}

export async function queryClinicalAuditEvents(
  pool: Pool,
  actor: PatientActor,
  query: ClinicalAuditQuery,
): Promise<AuditPage<ClinicalAuditEvent>> {
  const [patientEvents, workflowEvents] = await Promise.all([
    query.kind === "WORKFLOW"
      ? Promise.resolve([])
      : listPatientAuditEvents(pool, actor, query.patientId),
    query.kind === "PATIENT"
      ? Promise.resolve([])
      : listResearchCaseTransitionAuditEvents(pool, actor, query.patientId),
  ]);
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 25;
  const events = [
    ...patientEvents.map(materializePatientEvent),
    ...workflowEvents.map(materializeWorkflowEvent),
  ]
    .filter((event) => !query.eventType || event.eventType === query.eventType)
    .filter((event) => !query.from || event.occurredAt >= query.from)
    .filter((event) => !query.to || event.occurredAt <= query.to)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));

  return { events: events.slice(offset, offset + limit), offset, limit, total: events.length };
}

function materializePatientEvent(event: PatientAuditEvent): ClinicalAuditEvent {
  return {
    id: `patient:${event.requestId}:${event.targetVersion}`,
    kind: "PATIENT",
    eventType: event.eventType,
    patientLink: event.patientLink,
    targetVersion: event.targetVersion,
    before: event.before,
    after: event.after,
    provenance: {
      payloadReference: event.payloadReference,
      domainResultIds: [],
      details: null,
    },
    actorUserId: event.actorUserId,
    requestId: event.requestId,
    occurredAt: event.occurredAt,
  };
}

function materializeWorkflowEvent(event: ResearchCaseTransitionAuditEvent): ClinicalAuditEvent {
  return {
    id: `workflow:${event.requestId}:${event.toRevision}`,
    kind: "WORKFLOW",
    eventType: event.command,
    patientLink: event.patientLink,
    targetVersion: event.toRevision,
    before: { state: event.fromState, revision: event.fromRevision },
    after: { state: event.toState, revision: event.toRevision, inputRevision: event.inputRevision },
    provenance: {
      payloadReference: null,
      domainResultIds: event.domainResultIds,
      details: event.provenance,
    },
    actorUserId: event.actorUserId,
    requestId: event.requestId,
    occurredAt: event.occurredAt,
  };
}
