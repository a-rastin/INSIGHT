import { createHash, randomBytes } from "node:crypto";

import { stableSerialize, type JsonValue } from "@insight/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool } from "pg";

import { getCssrsAssessment } from "../assessment/cssrs.js";
import { getDsm5trAssessment } from "../assessment/dsm5tr.js";
import { getPanssAssessment } from "../assessment/panss.js";
import { getMedicalHistory } from "../medical-history/medical-history.js";
import { getPatient, type PatientActor } from "../patient/patients.js";
import { getResearchCaseWorkflow, type WorkflowState } from "../patient/workflow.js";
import {
  createProjection,
  DeidentificationError,
  isSafeModelVisibleString,
  type ModelVisibleProjection,
  type ProjectionSource,
} from "./projections.js";

const TOOL_VERSION = "1.0.0";
export const GET_CONTEXT_INPUT_SCHEMA = Type.Object(
  {},
  { $id: "insight.mcp.research-case-get-context-input.v1", additionalProperties: false },
);
const SUBJECT_TTL_MILLISECONDS = 15 * 60 * 1000;
const FORBIDDEN_KEYS =
  /(?:^|_)(?:patient|research.?case|user|actor|official|name|birth|address|contact|email|phone|identifier|reidentification|database|credential|secret|diagnostic)(?:_|$)/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const SHA256 = /^[0-9a-f]{64}$/;

export interface TrustedToolContext {
  readonly executionId: string;
  readonly jobId: string;
  readonly subjectRef: string;
  readonly researchCaseRevision: number;
  readonly workflowState: WorkflowState;
  readonly actorRole: "PSYCHIATRIST";
  readonly allowedToolNames: readonly string[];
  readonly idempotencyKey: string;
}

export type ModelToolResult<T> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly provenance: {
        readonly toolName: string;
        readonly toolVersion: string;
        readonly inputHash: string;
        readonly outputHash: string;
        readonly knowledgeVersions: readonly string[];
        readonly executedAt: string;
      };
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code:
          | "INVALID_TOOL_INPUT"
          | "STALE_RESEARCH_CASE_REVISION"
          | "TOOL_NOT_ALLOWED_IN_STATE"
          | "PRIVACY_FILTER_FAILED";
        readonly retryable: false;
        readonly safeMessage: string;
      };
    };

interface SubjectBinding {
  readonly patientId: string;
  readonly researchCaseId: string;
  readonly actor: PatientActor;
  readonly executionId: string;
  readonly jobId: string;
  readonly workflowState: WorkflowState;
  readonly revision: number;
  readonly expiresAt: number;
}

type SafeFailureCode = Extract<ModelToolResult<never>, { ok: false }>["error"]["code"];

const safeFailure = (code: SafeFailureCode): ModelToolResult<never> => ({
  ok: false,
  error: {
    code,
    retryable: false,
    safeMessage:
      code === "INVALID_TOOL_INPUT"
        ? "Tool input is invalid."
        : code === "STALE_RESEARCH_CASE_REVISION"
          ? "Research Case context is stale."
          : code === "TOOL_NOT_ALLOWED_IN_STATE"
            ? "Tool is not allowed in the current state."
            : "Tool result was blocked by the privacy filter.",
  },
});

function hash(value: JsonValue): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function assertSafeToolValue(value: JsonValue, forbiddenValues: readonly string[]): void {
  const visit = (entry: JsonValue, key?: string): void => {
    if (key && FORBIDDEN_KEYS.test(key)) throw new DeidentificationError();
    if (typeof entry === "string") {
      if (key === "executedAt" && !Number.isNaN(Date.parse(entry))) return;
      if (SHA256.test(entry)) return;
      if (UUID.test(entry) || !isSafeModelVisibleString(entry, forbiddenValues)) {
        throw new DeidentificationError();
      }
      return;
    }
    if (Array.isArray(entry)) return entry.forEach((item) => visit(item));
    if (entry && typeof entry === "object") {
      Object.entries(entry).forEach(([childKey, child]) => visit(child, childKey));
    }
  };
  visit(value);
}

export function filterModelVisibleToolResult<T extends JsonValue>(
  result: ModelToolResult<T>,
  forbiddenValues: readonly string[],
): ModelToolResult<T> | ModelToolResult<never> {
  if (!result.ok) {
    return [
      "INVALID_TOOL_INPUT",
      "STALE_RESEARCH_CASE_REVISION",
      "TOOL_NOT_ALLOWED_IN_STATE",
      "PRIVACY_FILTER_FAILED",
    ].includes(result.error.code)
      ? safeFailure(result.error.code)
      : safeFailure("PRIVACY_FILTER_FAILED");
  }
  try {
    assertSafeToolValue(result as unknown as JsonValue, forbiddenValues);
    return JSON.parse(stableSerialize(result as unknown as JsonValue)) as ModelToolResult<T>;
  } catch {
    return safeFailure("PRIVACY_FILTER_FAILED");
  }
}

export class DeidentificationGateway {
  readonly #bindings = new Map<string, SubjectBinding>();

  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issueSubject(
    input: {
      readonly patientId: string;
      readonly executionId: string;
      readonly jobId: string;
    },
    actor: PatientActor,
  ): Promise<TrustedToolContext> {
    if (actor.role !== "PSYCHIATRIST") throw new DeidentificationError("Psychiatrist required.");
    const workflow = await getResearchCaseWorkflow(this.pool, actor, input.patientId);
    if (!workflow.modelAllowedTools.includes("research_case.get_context")) {
      throw new DeidentificationError("Context is unavailable in the current state.");
    }
    this.removeExpiredBindings();
    const subjectRef = randomBytes(18).toString("base64url");
    this.#bindings.set(subjectRef, {
      patientId: input.patientId,
      researchCaseId: workflow.id,
      actor,
      executionId: input.executionId,
      jobId: input.jobId,
      workflowState: workflow.state,
      revision: workflow.revision,
      expiresAt: this.now().getTime() + SUBJECT_TTL_MILLISECONDS,
    });
    return {
      executionId: input.executionId,
      jobId: input.jobId,
      subjectRef,
      researchCaseRevision: workflow.revision,
      workflowState: workflow.state,
      actorRole: "PSYCHIATRIST",
      allowedToolNames: workflow.modelAllowedTools,
      idempotencyKey: randomBytes(18).toString("base64url"),
    };
  }

  revokeSubject(subjectRef: string): void {
    this.#bindings.delete(subjectRef);
  }

  async getContext(
    trusted: TrustedToolContext,
    input: Readonly<Record<string, never>>,
  ): Promise<ModelToolResult<ModelVisibleProjection & JsonValue> | ModelToolResult<never>> {
    if (
      !input ||
      Object.getPrototypeOf(input) !== Object.prototype ||
      !Value.Check(GET_CONTEXT_INPUT_SCHEMA, input)
    ) {
      return safeFailure("INVALID_TOOL_INPUT");
    }
    const binding = this.#bindings.get(trusted.subjectRef);
    if (
      !binding ||
      binding.expiresAt <= this.now().getTime() ||
      binding.executionId !== trusted.executionId ||
      binding.jobId !== trusted.jobId
    ) {
      return safeFailure("STALE_RESEARCH_CASE_REVISION");
    }
    if (
      trusted.actorRole !== "PSYCHIATRIST" ||
      !trusted.allowedToolNames.includes("research_case.get_context") ||
      trusted.workflowState !== binding.workflowState
    ) {
      return safeFailure("TOOL_NOT_ALLOWED_IN_STATE");
    }

    try {
      const workflow = await getResearchCaseWorkflow(this.pool, binding.actor, binding.patientId);
      if (
        workflow.id !== binding.researchCaseId ||
        workflow.state !== binding.workflowState ||
        workflow.revision !== binding.revision ||
        trusted.researchCaseRevision !== binding.revision
      ) {
        this.revokeSubject(trusted.subjectRef);
        return safeFailure("STALE_RESEARCH_CASE_REVISION");
      }
      const [patient, dsm5tr, panss, cssrs, medicalHistory, domainResults] = await Promise.all([
        getPatient(this.pool, binding.actor, binding.patientId),
        getDsm5trAssessment(this.pool, binding.actor, binding.patientId),
        getPanssAssessment(this.pool, binding.actor, binding.patientId),
        getCssrsAssessment(this.pool, binding.actor, binding.patientId),
        getMedicalHistory(this.pool, binding.actor, binding.patientId),
        this.pool.query<{ result_type: string }>(
          `SELECT DISTINCT result_type FROM insight.research_case_domain_results
           WHERE research_case_id = $1 AND input_revision = $2
             AND status = 'SUCCEEDED' AND invalidated_at IS NULL`,
          [binding.researchCaseId, workflow.inputRevision],
        ),
      ]);
      if (patient.researchCase.id !== binding.researchCaseId) throw new DeidentificationError();
      const source: ProjectionSource = {
        patient,
        dsm5tr,
        panss,
        cssrs,
        medicalHistory,
        availableDomainResults: new Set(domainResults.rows.map(({ result_type }) => result_type)),
      };
      const projection = createProjection(trusted.subjectRef, workflow.state, source);
      const result = {
        ok: true,
        data: projection,
        provenance: {
          toolName: "research_case.get_context",
          toolVersion: TOOL_VERSION,
          inputHash: hash({}),
          outputHash: hash(projection as unknown as JsonValue),
          knowledgeVersions: [],
          executedAt: this.now().toISOString(),
        },
        warnings: projection.omittedFieldClasses,
      } as const;
      return filterModelVisibleToolResult(
        result as unknown as ModelToolResult<JsonValue>,
        [],
      ) as ModelToolResult<ModelVisibleProjection & JsonValue>;
    } catch {
      return safeFailure("PRIVACY_FILTER_FAILED");
    }
  }

  private removeExpiredBindings(): void {
    const now = this.now().getTime();
    for (const [subjectRef, binding] of this.#bindings) {
      if (binding.expiresAt <= now) this.#bindings.delete(subjectRef);
    }
  }
}
