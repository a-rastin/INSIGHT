import { createHash } from "node:crypto";

import { stableSerialize, type JsonValue, type Role } from "@insight/contracts";
import type { Pool, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";

export const BN_ROUTING_ARTIFACT_VERSION = "1.0.0";

export interface BnRoutingFacts {
  readonly demographics: { readonly age: number; readonly sex: "MALE" | "FEMALE" };
  readonly presentationStatus: "FIRST_PRESENTATION" | "KNOWN_SCHIZOPHRENIA" | null;
  readonly assessments: readonly {
    readonly type: "DSM5TR" | "PANSS" | "CSSRS_RECENT";
    readonly state: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "BYPASSED";
    readonly result?: string;
  }[];
  readonly comorbidityTermIds: readonly string[];
  readonly medicationHistory: readonly {
    readonly canonicalMedicationId?: string;
    readonly response?: string;
  }[];
  readonly currentRegimen: readonly { readonly canonicalMedicationId: string }[];
}

export type BnRoutingCondition =
  | { readonly fact: "AGE_BETWEEN"; readonly minimum: number; readonly maximum: number }
  | { readonly fact: "SEX_IN"; readonly values: readonly BnRoutingFacts["demographics"]["sex"][] }
  | {
      readonly fact: "PRESENTATION_STATUS_IN";
      readonly values: readonly Exclude<BnRoutingFacts["presentationStatus"], null>[];
    }
  | {
      readonly fact: "ASSESSMENT_STATE_IN";
      readonly assessmentType: BnRoutingFacts["assessments"][number]["type"];
      readonly values: readonly BnRoutingFacts["assessments"][number]["state"][];
    }
  | {
      readonly fact: "ASSESSMENT_RESULT_IN";
      readonly assessmentType: BnRoutingFacts["assessments"][number]["type"];
      readonly values: readonly string[];
    }
  | { readonly fact: "COMORBIDITY_ANY"; readonly values: readonly string[] }
  | { readonly fact: "PRIOR_MEDICATION_ANY"; readonly values: readonly string[] }
  | { readonly fact: "PRIOR_RESPONSE_IN"; readonly values: readonly string[] }
  | { readonly fact: "CURRENT_MEDICATION_ANY"; readonly values: readonly string[] };

export interface BnRoutingRule {
  readonly ref: string;
  readonly routeGroup: string;
  readonly pathwayIdentity: string;
  readonly all: readonly BnRoutingCondition[];
}

export interface BnRoutingArtifact {
  readonly version: string;
  readonly approvalRef: string;
  readonly requiredRouteGroups: readonly string[];
  readonly rules: readonly BnRoutingRule[];
}

export interface ActiveBnModel {
  readonly modelId: string;
  readonly pathwayIdentity: string;
  readonly version: number;
  readonly contentSha256: string;
  readonly semanticSha256: string;
  readonly sourceReference: string;
}

export interface BnRoutingDecision {
  readonly routingArtifactVersion: string;
  readonly approvalRef: string;
  readonly matchedRuleRefs: readonly string[];
  readonly selectedModels: readonly ActiveBnModel[];
}

export const INITIAL_BN_ROUTING_ARTIFACT: BnRoutingArtifact = {
  version: BN_ROUTING_ARTIFACT_VERSION,
  approvalRef: "ADR-022:ADR-023:INITIAL-PHARMACOTHERAPY-SLICE",
  requiredRouteGroups: ["PRIMARY_TREATMENT"],
  rules: [
    {
      ref: "BN-ROUTE-PHARMACOTHERAPY-001",
      routeGroup: "PRIMARY_TREATMENT",
      pathwayIdentity: "PHARMACOTHERAPY",
      all: [
        {
          fact: "PRESENTATION_STATUS_IN",
          values: ["FIRST_PRESENTATION", "KNOWN_SCHIZOPHRENIA"],
        },
      ],
    },
  ],
};

export class BnRoutingError extends Error {
  constructor(
    readonly code:
      | "INVALID_ROUTING_ARTIFACT"
      | "INVALID_ROUTING_FACTS"
      | "AMBIGUOUS_ROUTE"
      | "MISSING_REQUIRED_ROUTE"
      | "MISSING_ACTIVE_MODEL"
      | "PINNED_MODEL_MISMATCH",
  ) {
    super(code);
    this.name = "BnRoutingError";
  }
}

export class BnRoutingAuthorizationError extends Error {
  constructor() {
    super("Role is not permitted to route Bayesian models.");
    this.name = "BnRoutingAuthorizationError";
  }
}

export function evaluateBnRouting(
  facts: BnRoutingFacts,
  artifact: BnRoutingArtifact,
  activeModels: readonly ActiveBnModel[],
): BnRoutingDecision {
  validateFacts(facts);
  validateArtifact(artifact);
  const matched = artifact.rules.filter((rule) =>
    rule.all.every((condition) => matches(facts, condition)),
  );
  const selectedRules = artifact.requiredRouteGroups.map((routeGroup) => {
    const groupMatches = matched.filter((rule) => rule.routeGroup === routeGroup);
    if (groupMatches.length === 0) throw new BnRoutingError("MISSING_REQUIRED_ROUTE");
    if (groupMatches.length !== 1) throw new BnRoutingError("AMBIGUOUS_ROUTE");
    return groupMatches[0]!;
  });
  const selectedModels = selectedRules.map((rule) => {
    const models = activeModels.filter(
      ({ pathwayIdentity }) => pathwayIdentity === rule.pathwayIdentity,
    );
    if (models.length !== 1) throw new BnRoutingError("MISSING_ACTIVE_MODEL");
    return models[0]!;
  });
  return {
    routingArtifactVersion: artifact.version,
    approvalRef: artifact.approvalRef,
    matchedRuleRefs: matched.map(({ ref }) => ref).sort(),
    selectedModels: [...selectedModels].sort((left, right) =>
      left.pathwayIdentity.localeCompare(right.pathwayIdentity),
    ),
  };
}

interface ActiveModelRow extends QueryResultRow {
  model_id: string;
  pathway_identity: string;
  version: number;
  content_sha256: string;
  semantic_sha256: string;
  source_reference: string;
}

export async function routeAndRecordBnModels(
  pool: Pool,
  actor: { readonly id: string; readonly role: Role },
  input: {
    readonly researchCaseId: string;
    readonly researchCaseRevision: number;
    readonly facts: BnRoutingFacts;
    readonly artifact?: BnRoutingArtifact;
    readonly now?: Date;
  },
): Promise<BnRoutingDecision & { readonly evaluationId: string }> {
  if (actor.role !== "PSYCHIATRIST") throw new BnRoutingAuthorizationError();
  const artifact = input.artifact ?? INITIAL_BN_ROUTING_ARTIFACT;
  return withTransaction(pool, async (client) => {
    const active = await client.query<ActiveModelRow>(
      `SELECT model.id AS model_id, model.pathway_identity, model.version,
              artifact.content_sha256, artifact.semantic_sha256,
              initial.event_reference AS source_reference
       FROM insight.bn_active_models active
       JOIN insight.bn_model_versions model ON model.id = active.model_version_id
       JOIN insight.bn_model_artifacts artifact ON artifact.id = model.artifact_id
       JOIN LATERAL (
         SELECT event_reference FROM insight.bn_model_lifecycle_events event
         WHERE event.model_version_id = model.id ORDER BY sequence LIMIT 1
       ) initial ON true
       WHERE (model.validation_report->>'softwareCompatible')::boolean
         AND artifact.semantic_sha256 IS NOT NULL`,
    );
    const decision = evaluateBnRouting(
      input.facts,
      artifact,
      active.rows.map((row) => ({
        modelId: row.model_id,
        pathwayIdentity: row.pathway_identity,
        version: Number(row.version),
        contentSha256: row.content_sha256,
        semanticSha256: row.semantic_sha256,
        sourceReference: row.source_reference,
      })),
    );
    const inputSha256 = createHash("sha256")
      .update(stableSerialize(input.facts as unknown as JsonValue))
      .digest("hex");
    for (const model of decision.selectedModels) {
      const pin = await client.query(
        `INSERT INTO insight.bn_research_case_model_pins (
           research_case_id, pathway_identity, model_version_id, model_version,
           content_sha256, semantic_sha256, pinned_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (research_case_id, pathway_identity) DO NOTHING`,
        [
          input.researchCaseId,
          model.pathwayIdentity,
          model.modelId,
          model.version,
          model.contentSha256,
          model.semanticSha256,
          input.now ?? new Date(),
        ],
      );
      if (pin.rowCount === 0) {
        const existing = await client.query<{ model_version_id: string }>(
          `SELECT model_version_id FROM insight.bn_research_case_model_pins
           WHERE research_case_id = $1 AND pathway_identity = $2`,
          [input.researchCaseId, model.pathwayIdentity],
        );
        if (existing.rows[0]?.model_version_id !== model.modelId) {
          throw new BnRoutingError("PINNED_MODEL_MISMATCH");
        }
      }
    }
    const recorded = await client.query<{ id: string }>(
      `INSERT INTO insight.bn_routing_evaluations (
         research_case_id, research_case_revision, routing_artifact_version,
         routing_approval_ref, input_sha256, matched_rule_refs, selected_models,
         evaluated_by_user_id, evaluated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        input.researchCaseId,
        input.researchCaseRevision,
        decision.routingArtifactVersion,
        decision.approvalRef,
        inputSha256,
        JSON.stringify(decision.matchedRuleRefs),
        JSON.stringify(decision.selectedModels),
        actor.id,
        input.now ?? new Date(),
      ],
    );
    return { ...decision, evaluationId: recorded.rows[0]!.id };
  });
}

function validateArtifact(artifact: BnRoutingArtifact): void {
  const refs = new Set(artifact.rules.map(({ ref }) => ref));
  const groups = new Set(artifact.requiredRouteGroups);
  if (
    !artifact.version ||
    !artifact.approvalRef ||
    refs.size !== artifact.rules.length ||
    groups.size !== artifact.requiredRouteGroups.length ||
    artifact.requiredRouteGroups.length === 0 ||
    artifact.rules.some((rule) => !groups.has(rule.routeGroup) || rule.all.length === 0)
  ) {
    throw new BnRoutingError("INVALID_ROUTING_ARTIFACT");
  }
}

function validateFacts(facts: BnRoutingFacts): void {
  const assessmentTypes = ["DSM5TR", "PANSS", "CSSRS_RECENT"];
  const assessmentStates = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "BYPASSED"];
  const token = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,199}$/.test(value);
  if (
    !facts ||
    !Number.isInteger(facts.demographics?.age) ||
    facts.demographics.age < 0 ||
    facts.demographics.age > 130 ||
    !["MALE", "FEMALE"].includes(facts.demographics.sex) ||
    !["FIRST_PRESENTATION", "KNOWN_SCHIZOPHRENIA", null].includes(facts.presentationStatus) ||
    !Array.isArray(facts.assessments) ||
    facts.assessments.length !== assessmentTypes.length ||
    new Set(facts.assessments.map(({ type }) => type)).size !== assessmentTypes.length ||
    facts.assessments.some(
      ({ type, state, result }) =>
        !assessmentTypes.includes(type) ||
        !assessmentStates.includes(state) ||
        (result !== undefined && !token(result)),
    ) ||
    !Array.isArray(facts.comorbidityTermIds) ||
    facts.comorbidityTermIds.some((value) => !token(value)) ||
    !Array.isArray(facts.medicationHistory) ||
    facts.medicationHistory.some(
      ({ canonicalMedicationId, response }) =>
        (canonicalMedicationId !== undefined && !token(canonicalMedicationId)) ||
        (response !== undefined && !token(response)),
    ) ||
    !Array.isArray(facts.currentRegimen) ||
    facts.currentRegimen.some(({ canonicalMedicationId }) => !token(canonicalMedicationId))
  ) {
    throw new BnRoutingError("INVALID_ROUTING_FACTS");
  }
}

function matches(facts: BnRoutingFacts, condition: BnRoutingCondition): boolean {
  switch (condition.fact) {
    case "AGE_BETWEEN":
      return (
        facts.demographics.age >= condition.minimum && facts.demographics.age <= condition.maximum
      );
    case "SEX_IN":
      return condition.values.includes(facts.demographics.sex);
    case "PRESENTATION_STATUS_IN":
      return (
        facts.presentationStatus !== null && condition.values.includes(facts.presentationStatus)
      );
    case "ASSESSMENT_STATE_IN": {
      const assessment = facts.assessments.find(({ type }) => type === condition.assessmentType);
      return assessment !== undefined && condition.values.includes(assessment.state);
    }
    case "ASSESSMENT_RESULT_IN": {
      const assessment = facts.assessments.find(({ type }) => type === condition.assessmentType);
      return assessment?.result !== undefined && condition.values.includes(assessment.result);
    }
    case "COMORBIDITY_ANY":
      return facts.comorbidityTermIds.some((value) => condition.values.includes(value));
    case "PRIOR_MEDICATION_ANY":
      return facts.medicationHistory.some(
        ({ canonicalMedicationId }) =>
          canonicalMedicationId !== undefined && condition.values.includes(canonicalMedicationId),
      );
    case "PRIOR_RESPONSE_IN":
      return facts.medicationHistory.some(
        ({ response }) => response !== undefined && condition.values.includes(response),
      );
    case "CURRENT_MEDICATION_ANY":
      return facts.currentRegimen.some(({ canonicalMedicationId }) =>
        condition.values.includes(canonicalMedicationId),
      );
  }
}
