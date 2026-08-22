import type { Pool, PoolClient } from "pg";

import { withTransaction } from "../database/transaction.js";

export const EXTERNAL_APPROVAL_NOTICE =
  "INSIGHT records external deployment evidence; it does not grant ethics or legal approval.";

export const SECURITY_CONTROL_KEYS = [
  "participantConsentOrWaiver",
  "administratorSeparation",
  "encryptionInTransit",
  "encryptionAtRest",
  "auditControls",
  "dataGovernanceRules",
  "modelDisclosureControls",
  "environmentSeparation",
] as const;

export type EnvironmentStatus = "SYNTHETIC_OR_DEIDENTIFIED" | "APPROVED_IDENTIFIED_RESEARCH";
export type IdentifiedMode = "DISABLED" | "ENABLED";
export type GateReason =
  | "ACTIVE"
  | "NO_EVIDENCE"
  | "EVIDENCE_CHANGED"
  | "APPROVAL_NOT_YET_VALID"
  | "APPROVAL_EXPIRED";
export type SecurityControlKey = (typeof SECURITY_CONTROL_KEYS)[number];
export type SecurityControls = Readonly<Record<SecurityControlKey, boolean>>;

export interface DeploymentEvidenceInput {
  readonly responsibleAuthority: string;
  readonly approvalBasis: string;
  readonly approvalReference: string;
  readonly approvalGrantedAt: Date;
  readonly approvalExpiresAt: Date;
  readonly environmentStatus: EnvironmentStatus;
  readonly securityControls: SecurityControls;
}

export interface DeploymentEvidence extends DeploymentEvidenceInput {
  readonly version: number;
  readonly recordedByUserId: string;
  readonly recordedAt: Date;
}

export interface DeploymentGateStatus {
  readonly identifiedMode: IdentifiedMode;
  readonly reason: GateReason;
  readonly evidence: DeploymentEvidence | null;
}

interface EvidenceRow {
  version: number;
  responsible_authority: string;
  approval_basis: string;
  approval_reference: string;
  approval_granted_at: Date;
  approval_expires_at: Date;
  environment_status: EnvironmentStatus;
  participant_consent_or_waiver: boolean;
  administrator_separation: boolean;
  encryption_in_transit: boolean;
  encryption_at_rest: boolean;
  audit_controls: boolean;
  data_governance_rules: boolean;
  model_disclosure_controls: boolean;
  environment_separation: boolean;
  recorded_by_user_id: string;
  recorded_at: Date;
}

export class DeploymentEvidenceNotFoundError extends Error {
  constructor() {
    super("Deployment evidence version was not found.");
    this.name = "DeploymentEvidenceNotFoundError";
  }
}

export class DeploymentAuthorizationError extends Error {
  constructor() {
    super("An enabled Administrator is required.");
    this.name = "DeploymentAuthorizationError";
  }
}

export class DeploymentPrerequisitesIncompleteError extends Error {
  readonly prerequisites: readonly string[];

  constructor(prerequisites: readonly string[]) {
    super("Identified research mode prerequisites are incomplete.");
    this.name = "DeploymentPrerequisitesIncompleteError";
    this.prerequisites = prerequisites;
  }
}

export class IdentifiedResearchModeDisabledError extends Error {
  readonly reason: GateReason;

  constructor(reason: GateReason) {
    super("Identified Patient creation is disabled for this deployment.");
    this.name = "IdentifiedResearchModeDisabledError";
    this.reason = reason;
  }
}

const evidenceColumns = `
  version, responsible_authority, approval_basis, approval_reference,
  approval_granted_at, approval_expires_at, environment_status,
  participant_consent_or_waiver, administrator_separation,
  encryption_in_transit, encryption_at_rest, audit_controls,
  data_governance_rules, model_disclosure_controls, environment_separation,
  recorded_by_user_id, recorded_at
`;

function evidenceFromRow(row: EvidenceRow): DeploymentEvidence {
  return {
    version: row.version,
    responsibleAuthority: row.responsible_authority,
    approvalBasis: row.approval_basis,
    approvalReference: row.approval_reference,
    approvalGrantedAt: row.approval_granted_at,
    approvalExpiresAt: row.approval_expires_at,
    environmentStatus: row.environment_status,
    securityControls: {
      participantConsentOrWaiver: row.participant_consent_or_waiver,
      administratorSeparation: row.administrator_separation,
      encryptionInTransit: row.encryption_in_transit,
      encryptionAtRest: row.encryption_at_rest,
      auditControls: row.audit_controls,
      dataGovernanceRules: row.data_governance_rules,
      modelDisclosureControls: row.model_disclosure_controls,
      environmentSeparation: row.environment_separation,
    },
    recordedByUserId: row.recorded_by_user_id,
    recordedAt: row.recorded_at,
  };
}

function incompletePrerequisites(evidence: DeploymentEvidence, now: Date): string[] {
  const incomplete: string[] = SECURITY_CONTROL_KEYS.filter(
    (key) => !evidence.securityControls[key],
  );
  if (evidence.environmentStatus !== "APPROVED_IDENTIFIED_RESEARCH") {
    incomplete.push("approvedIdentifiedResearchEnvironment");
  }
  if (evidence.approvalGrantedAt > now) {
    incomplete.push("approvalEffective");
  }
  if (evidence.approvalExpiresAt <= now) {
    incomplete.push("approvalUnexpired");
  }
  return incomplete;
}

async function latestEvidence(database: Pool | PoolClient): Promise<DeploymentEvidence | null> {
  const result = await database.query<EvidenceRow>(
    `SELECT ${evidenceColumns}
     FROM insight.deployment_evidence_versions
     ORDER BY version DESC
     LIMIT 1`,
  );
  return result.rows[0] ? evidenceFromRow(result.rows[0]) : null;
}

async function audit(
  client: PoolClient,
  eventType:
    | "DEPLOYMENT_EVIDENCE_RECORDED"
    | "IDENTIFIED_MODE_ACTIVATED"
    | "IDENTIFIED_MODE_DISABLED",
  actorUserId: string | null,
  evidence: DeploymentEvidence,
  requestId?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO insight.operational_audit_events
       (event_type, actor_user_id, evidence_version, environment_status, request_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [eventType, actorUserId, evidence.version, evidence.environmentStatus, requestId ?? null],
  );
}

async function assertAdministrator(client: PoolClient, actorUserId: string): Promise<void> {
  const result = await client.query(
    `SELECT 1
     FROM insight.users
     WHERE id = $1 AND role = 'ADMINISTRATOR' AND status <> 'DISABLED'`,
    [actorUserId],
  );
  if (result.rowCount !== 1) throw new DeploymentAuthorizationError();
}

export async function recordDeploymentEvidence(
  pool: Pool,
  actorUserId: string,
  input: DeploymentEvidenceInput,
  requestId?: string,
): Promise<DeploymentEvidence> {
  return withTransaction(pool, async (client) => {
    await assertAdministrator(client, actorUserId);
    const state = await client.query<{ active_evidence_version: number | null }>(
      `SELECT active_evidence_version
       FROM insight.deployment_mode_state
       WHERE singleton = true
       FOR UPDATE`,
    );
    const previous = await latestEvidence(client);
    const version = (previous?.version ?? 0) + 1;
    const controls = input.securityControls;
    const inserted = await client.query<EvidenceRow>(
      `INSERT INTO insight.deployment_evidence_versions (
         version, schema_version, responsible_authority, approval_basis, approval_reference,
         approval_granted_at, approval_expires_at, environment_status,
         participant_consent_or_waiver, administrator_separation,
         encryption_in_transit, encryption_at_rest, audit_controls,
         data_governance_rules, model_disclosure_controls, environment_separation,
         recorded_by_user_id
       ) VALUES (
         $1, 1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14, $15, $16
       )
       RETURNING ${evidenceColumns}`,
      [
        version,
        input.responsibleAuthority,
        input.approvalBasis,
        input.approvalReference,
        input.approvalGrantedAt,
        input.approvalExpiresAt,
        input.environmentStatus,
        controls.participantConsentOrWaiver,
        controls.administratorSeparation,
        controls.encryptionInTransit,
        controls.encryptionAtRest,
        controls.auditControls,
        controls.dataGovernanceRules,
        controls.modelDisclosureControls,
        controls.environmentSeparation,
        actorUserId,
      ],
    );
    const evidence = evidenceFromRow(inserted.rows[0]!);
    if (state.rows[0]?.active_evidence_version !== null) {
      await client.query(
        `UPDATE insight.deployment_mode_state
         SET active_evidence_version = NULL, activated_by_user_id = NULL, activated_at = NULL
         WHERE singleton = true`,
      );
      if (previous) {
        await audit(client, "IDENTIFIED_MODE_DISABLED", actorUserId, previous, requestId);
      }
    }
    await audit(client, "DEPLOYMENT_EVIDENCE_RECORDED", actorUserId, evidence, requestId);
    return evidence;
  });
}

export async function activateIdentifiedResearchMode(
  pool: Pool,
  actorUserId: string,
  version: number,
  requestId?: string,
  now = new Date(),
): Promise<DeploymentGateStatus> {
  return withTransaction(pool, async (client) => {
    await assertAdministrator(client, actorUserId);
    await client.query(
      `SELECT active_evidence_version
       FROM insight.deployment_mode_state
       WHERE singleton = true
       FOR UPDATE`,
    );
    const evidence = await latestEvidence(client);
    if (!evidence || evidence.version !== version) throw new DeploymentEvidenceNotFoundError();
    const incomplete = incompletePrerequisites(evidence, now);
    if (incomplete.length > 0) throw new DeploymentPrerequisitesIncompleteError(incomplete);

    await client.query(
      `UPDATE insight.deployment_mode_state
       SET active_evidence_version = $1, activated_by_user_id = $2, activated_at = $3
       WHERE singleton = true`,
      [version, actorUserId, now],
    );
    await audit(client, "IDENTIFIED_MODE_ACTIVATED", actorUserId, evidence, requestId);
    return { identifiedMode: "ENABLED", reason: "ACTIVE", evidence };
  });
}

export async function getDeploymentGateStatus(
  pool: Pool,
  now = new Date(),
): Promise<DeploymentGateStatus> {
  return withTransaction(pool, async (client) => {
    const state = await client.query<{ active_evidence_version: number | null }>(
      `SELECT active_evidence_version
       FROM insight.deployment_mode_state
       WHERE singleton = true
       FOR UPDATE`,
    );
    const evidence = await latestEvidence(client);
    if (!evidence) return { identifiedMode: "DISABLED", reason: "NO_EVIDENCE", evidence: null };
    if (state.rows[0]?.active_evidence_version !== evidence.version) {
      return { identifiedMode: "DISABLED", reason: "EVIDENCE_CHANGED", evidence };
    }
    if (evidence.approvalGrantedAt > now) {
      return { identifiedMode: "DISABLED", reason: "APPROVAL_NOT_YET_VALID", evidence };
    }
    if (evidence.approvalExpiresAt <= now) {
      await client.query(
        `UPDATE insight.deployment_mode_state
         SET active_evidence_version = NULL, activated_by_user_id = NULL, activated_at = NULL
         WHERE singleton = true`,
      );
      await audit(client, "IDENTIFIED_MODE_DISABLED", null, evidence);
      return { identifiedMode: "DISABLED", reason: "APPROVAL_EXPIRED", evidence };
    }
    return { identifiedMode: "ENABLED", reason: "ACTIVE", evidence };
  });
}

export async function assertIdentifiedPatientCreationAllowed(
  pool: Pool,
  now = new Date(),
): Promise<void> {
  const status = await getDeploymentGateStatus(pool, now);
  if (status.identifiedMode !== "ENABLED") {
    throw new IdentifiedResearchModeDisabledError(status.reason);
  }
}
