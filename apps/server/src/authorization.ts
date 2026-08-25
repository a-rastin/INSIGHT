import { MODEL_TOOL_NAMES } from "./mcp/gateway.js";
import { MODEL_TOOLS_BY_STATE, WORKFLOW_TRANSITIONS } from "./patient/workflow.js";

export const AUTHORIZATION_PRINCIPALS = [
  "ANONYMOUS",
  "ADMINISTRATOR",
  "PSYCHIATRIST",
  "SYSTEM",
  "MAINTENANCE_OPERATOR",
] as const;

export type AuthorizationPrincipal = (typeof AUTHORIZATION_PRINCIPALS)[number];
export type AuthorizationSurface =
  | "REST"
  | "SSE"
  | "JOB"
  | "MCP"
  | "AUDIT"
  | "ARTIFACT"
  | "BACKUP"
  | "RESTORE"
  | "WORKFLOW";

export type ObjectAccessRule =
  | "NONE"
  | "CURRENT_ACCOUNT"
  | "TARGET_ACCOUNT"
  | "SHARED_PSYCHIATRIST_PATIENT"
  | "ARTIFACT_ACCESS_CLASS"
  | "BACKUP_ID"
  | "SYSTEM_INTERNAL";

export type DataClass = "PUBLIC" | "ACCOUNT" | "SYSTEM_ADMIN" | "KNOWLEDGE" | "CLINICAL";

export interface AuthorizationMatrixRow {
  readonly id: string;
  readonly surface: AuthorizationSurface;
  readonly allowed: readonly AuthorizationPrincipal[];
  readonly denied: readonly AuthorizationPrincipal[];
  readonly objectAccess: ObjectAccessRule;
  readonly dataClass: DataClass;
  readonly workflowStates: readonly string[];
}

const publicRest = ["getHealth", "getReadiness", "login", "getOpenApiDocument"] as const;
const accountRest = ["getSession", "logout", "replacePassword"] as const;
const administratorRest = [
  "listUsers",
  "createUser",
  "renameUser",
  "enableUser",
  "disableUser",
  "setUserPassword",
  "resetUserPassword",
  "revokeUserSessions",
  "getDeploymentEvidence",
  "recordDeploymentEvidence",
  "activateIdentifiedResearchMode",
  "listOperationalAudit",
  "getAdverseEffectCatalogHistory",
  "saveAdverseEffectCatalog",
  "getComorbidityKnowledgeHistory",
  "saveComorbidityKnowledge",
  "getMedicationCatalogHistory",
  "saveMedicationCatalog",
  "getDdiSourceHistory",
  "importDdiSource",
  "reviewDdiSource",
  "activateDdiSource",
  "getBnModelHistory",
  "getBnModelSource",
  "createBnModelCandidate",
  "importBnModel",
  "disableBnModel",
  "rollbackBnModel",
  "getModelEndpointConfiguration",
  "replaceModelEndpointConfiguration",
  "clearModelEndpointCredential",
  "checkModelEndpointCompatibility",
] as const;
const backupRest = [
  "startDatabaseBackup",
  "getDatabaseBackupStatus",
  "downloadDatabaseBackup",
  "downloadDatabaseBackupManifest",
] as const;
const clinicalRest = [
  "getActiveAdverseEffectCatalog",
  "getActiveComorbidityKnowledge",
  "listClinicalAudit",
  "listPatients",
  "getPatientProfile",
  "deletePatient",
  "getResearchCaseWorkflow",
  "transitionResearchCase",
  "createOrOpenPatient",
  "savePatientDemographics",
  "getMedicationNormalization",
  "startMedicationNormalization",
  "listFinalTreatmentPlans",
  "exportFinalTreatmentPlan",
  "createFinalTreatmentPlanRevision",
  "getPrimaryTreatmentPlanReview",
  "saveClinicianRegimen",
  "finalizeTreatmentPlan",
  "getMedicalHistory",
  "saveMedicalHistory",
  "getJob",
  "getDsm5trAssessment",
  "saveDsm5trAssessment",
  "getPanssAssessment",
  "savePanssAssessment",
  "getCssrsRecentAssessment",
  "saveCssrsRecentAssessment",
  "startResearchCaseOrchestration",
] as const;

export const REST_AUTHORIZATION_OPERATION_IDS = Object.freeze([
  ...publicRest,
  ...accountRest,
  ...administratorRest,
  ...backupRest,
  "getActiveDdiSources",
  ...clinicalRest,
  "streamJobEvents",
]);

function row(
  id: string,
  surface: AuthorizationSurface,
  allowed: readonly AuthorizationPrincipal[],
  objectAccess: ObjectAccessRule,
  dataClass: DataClass,
  workflowStates: readonly string[] = [],
): AuthorizationMatrixRow {
  return Object.freeze({
    id,
    surface,
    allowed: Object.freeze([...allowed]),
    denied: Object.freeze(AUTHORIZATION_PRINCIPALS.filter((role) => !allowed.includes(role))),
    objectAccess,
    dataClass,
    workflowStates: Object.freeze([...workflowStates]),
  });
}

const workflowRows = WORKFLOW_TRANSITIONS.map((transition) =>
  row(transition.command, "WORKFLOW", ["PSYCHIATRIST"], "SHARED_PSYCHIATRIST_PATIENT", "CLINICAL", [
    transition.from,
  ]),
);

const mcpRows = MODEL_TOOL_NAMES.map((tool) =>
  row(
    tool,
    "MCP",
    ["PSYCHIATRIST"],
    "SHARED_PSYCHIATRIST_PATIENT",
    "CLINICAL",
    Object.entries(MODEL_TOOLS_BY_STATE)
      .filter(([, tools]) => tools.includes(tool))
      .map(([state]) => state),
  ),
);

export const AUTHORIZATION_MATRIX: readonly AuthorizationMatrixRow[] = Object.freeze([
  ...publicRest.map((id) => row(id, "REST", [...AUTHORIZATION_PRINCIPALS], "NONE", "PUBLIC")),
  ...accountRest.map((id) =>
    row(id, "REST", ["ADMINISTRATOR", "PSYCHIATRIST"], "CURRENT_ACCOUNT", "ACCOUNT"),
  ),
  ...administratorRest.map((id) =>
    row(
      id,
      id === "listOperationalAudit" ? "AUDIT" : "REST",
      ["ADMINISTRATOR"],
      id.includes("User") || id === "listUsers" ? "TARGET_ACCOUNT" : "SYSTEM_INTERNAL",
      id === "listOperationalAudit" ? "SYSTEM_ADMIN" : "KNOWLEDGE",
    ),
  ),
  ...backupRest.map((id) => row(id, "BACKUP", ["ADMINISTRATOR"], "BACKUP_ID", "SYSTEM_ADMIN")),
  row("getActiveDdiSources", "REST", ["ADMINISTRATOR", "PSYCHIATRIST"], "NONE", "KNOWLEDGE"),
  ...clinicalRest.map((id) =>
    row(
      id,
      id === "listClinicalAudit" ? "AUDIT" : "REST",
      ["PSYCHIATRIST"],
      "SHARED_PSYCHIATRIST_PATIENT",
      "CLINICAL",
    ),
  ),
  row("streamJobEvents", "SSE", ["PSYCHIATRIST"], "SHARED_PSYCHIATRIST_PATIENT", "CLINICAL"),
  ...["enqueueJob", "getJobStatus", "listJobEvents", "cancelJob"].map((id) =>
    row(id, "JOB", ["PSYCHIATRIST"], "SHARED_PSYCHIATRIST_PATIENT", "CLINICAL"),
  ),
  ...[
    "claimNextJob",
    "renewJobLease",
    "expireJobLease",
    "appendJobProgress",
    "settleJobFromDomainResult",
    "releaseJobAfterFailure",
  ].map((id) => row(id, "JOB", ["SYSTEM"], "SYSTEM_INTERNAL", "CLINICAL")),
  ...mcpRows,
  row("queryOperationalAuditEvents", "AUDIT", ["ADMINISTRATOR"], "SYSTEM_INTERNAL", "SYSTEM_ADMIN"),
  row(
    "queryClinicalAuditEvents",
    "AUDIT",
    ["PSYCHIATRIST"],
    "SHARED_PSYCHIATRIST_PATIENT",
    "CLINICAL",
  ),
  row(
    "storeArtifact",
    "ARTIFACT",
    ["ADMINISTRATOR", "PSYCHIATRIST"],
    "ARTIFACT_ACCESS_CLASS",
    "KNOWLEDGE",
  ),
  row(
    "readArtifact",
    "ARTIFACT",
    ["ADMINISTRATOR", "PSYCHIATRIST"],
    "ARTIFACT_ACCESS_CLASS",
    "KNOWLEDGE",
  ),
  row("restoreDatabase", "RESTORE", ["MAINTENANCE_OPERATOR"], "SYSTEM_INTERNAL", "SYSTEM_ADMIN"),
  row(
    "rollbackDatabaseRestore",
    "RESTORE",
    ["MAINTENANCE_OPERATOR"],
    "SYSTEM_INTERNAL",
    "SYSTEM_ADMIN",
  ),
  ...workflowRows,
]);

const MATRIX_BY_ID = new Map(AUTHORIZATION_MATRIX.map((entry) => [entry.id, entry]));

export function authorizationRow(id: string): AuthorizationMatrixRow | undefined {
  return MATRIX_BY_ID.get(id);
}

export function isSurfaceAuthorized(
  id: string,
  principal: AuthorizationPrincipal,
  workflowState?: string,
): boolean {
  const policy = authorizationRow(id);
  if (!policy || !policy.allowed.includes(principal)) return false;
  return (
    policy.workflowStates.length === 0 ||
    (workflowState !== undefined && policy.workflowStates.includes(workflowState))
  );
}
