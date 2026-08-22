import type {
  AntipsychoticTrialInput,
  ComorbiditySelectionInput,
  ContraindicationOutputInput,
  CurrentMedicationInput,
  MedicalHistoryInput,
  MedicalHistoryRecord,
} from "@insight/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";
import type { PatientActor } from "../patient/patients.js";
import { invalidateResearchCaseInputsInTransaction } from "../patient/workflow.js";

interface CaseRow extends QueryResultRow {
  id: string;
  patient_id: string;
  workflow_revision: string;
}

interface HistoryRow extends QueryResultRow {
  research_case_id: string;
  presentation_status: MedicalHistoryInput["presentationStatus"];
  previously_treated: boolean | null;
  supplemental_notes: string | null;
  revision: string;
  created_by_user_id: string;
  updated_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

interface TrialRow extends QueryResultRow {
  medication: string;
  normalization_state: AntipsychoticTrialInput["normalizationState"] | null;
  canonical_medication_id: string | null;
  dose: string | null;
  dose_unit: string | null;
  treatment_start: string | null;
  treatment_end: string | null;
  approximate_period: string | null;
  response: AntipsychoticTrialInput["response"] | null;
  adverse_effects: AntipsychoticTrialInput["adverseEffects"] | null;
  other_adverse_effect_detail: string | null;
  discontinuation_reason: string | null;
  notes: string | null;
}

interface CurrentMedicationRow extends QueryResultRow {
  raw_medication: string;
  normalization_state: CurrentMedicationInput["normalizationState"] | null;
  canonical_medication_id: string | null;
  dose: string | null;
  dose_unit: string | null;
  route: string | null;
  frequency: string | null;
}

interface ComorbidityRow extends QueryResultRow {
  catalog_version_id: string;
  term_id: string;
  supplemental_text: string | null;
}

interface ContraindicationRow extends QueryResultRow {
  rule_version_id: string;
  rule_id: string;
  outcome: ContraindicationOutputInput["outcome"];
  explanation: string | null;
}

export class MedicalHistoryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MedicalHistoryInputError";
  }
}

export class MedicalHistoryNotFoundError extends Error {
  constructor() {
    super("Research Case was not found.");
    this.name = "MedicalHistoryNotFoundError";
  }
}

export class MedicalHistoryConflictError extends Error {
  constructor(message = "Research Case revision is stale.") {
    super(message);
    this.name = "MedicalHistoryConflictError";
  }
}

export function validateMedicalHistoryInput(input: MedicalHistoryInput): MedicalHistoryInput {
  const hasPreviouslyTreated = Object.hasOwn(input, "previouslyTreated");
  const hasPriorTrials = Object.hasOwn(input, "priorTrials");
  const priorTrials = input.priorTrials ?? [];

  if (input.presentationStatus === "FIRST_PRESENTATION") {
    if (hasPreviouslyTreated || hasPriorTrials) {
      throw new MedicalHistoryInputError(
        "First presentation must omit previouslyTreated and priorTrials.",
      );
    }
  } else if (input.presentationStatus === "KNOWN_SCHIZOPHRENIA") {
    if (!hasPreviouslyTreated || typeof input.previouslyTreated !== "boolean") {
      throw new MedicalHistoryInputError("Known schizophrenia requires previouslyTreated.");
    }
    if (input.previouslyTreated && priorTrials.length === 0) {
      throw new MedicalHistoryInputError("Previously treated cases require at least one trial.");
    }
    if (!input.previouslyTreated && priorTrials.length > 0) {
      throw new MedicalHistoryInputError("Untreated cases cannot contain prior trials.");
    }
  } else {
    throw new MedicalHistoryInputError("Presentation status is invalid.");
  }

  const currentMedications = input.currentMedications.map(validateCurrentMedication);
  const validatedTrials = priorTrials.map(validateTrial);
  const comorbidities = input.comorbidities.map(validateComorbidity);
  const contraindications = input.contraindications.map(validateContraindication);
  rejectDuplicateKeys(
    comorbidities.map(({ catalogVersionId, termId }) => `${catalogVersionId}\0${termId}`),
    "comorbidity",
  );
  rejectDuplicateKeys(
    contraindications.map(({ ruleVersionId, ruleId }) => `${ruleVersionId}\0${ruleId}`),
    "contraindication",
  );

  return {
    presentationStatus: input.presentationStatus,
    ...(input.presentationStatus === "KNOWN_SCHIZOPHRENIA"
      ? {
          previouslyTreated: input.previouslyTreated,
          ...(hasPriorTrials ? { priorTrials: validatedTrials } : {}),
        }
      : {}),
    currentMedications,
    comorbidities,
    contraindications,
    ...(input.supplementalNotes === undefined
      ? {}
      : { supplementalNotes: requiredText(input.supplementalNotes, "Supplemental notes") }),
  };
}

export async function getMedicalHistory(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
): Promise<MedicalHistoryRecord | null> {
  requirePsychiatrist(actor);
  const researchCase = await caseByPatient(pool, patientId, false);
  if (!researchCase) throw new MedicalHistoryNotFoundError();
  return loadHistory(pool, researchCase.id);
}

export async function saveMedicalHistory(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
  input: MedicalHistoryInput,
  expectedRevision: number,
  requestId: string,
  now = new Date(),
): Promise<MedicalHistoryRecord> {
  requirePsychiatrist(actor);
  const history = validateMedicalHistoryInput(input);
  return withTransaction(pool, async (client) => {
    const researchCase = await caseByPatient(client, patientId, true);
    if (!researchCase) throw new MedicalHistoryNotFoundError();
    if (Number(researchCase.workflow_revision) !== expectedRevision) {
      throw new MedicalHistoryConflictError();
    }

    const existing = await client.query<HistoryRow>(
      "SELECT * FROM insight.medical_histories WHERE research_case_id = $1 FOR UPDATE",
      [researchCase.id],
    );
    const revision = Number(existing.rows[0]?.revision ?? 0) + 1;
    await client.query("SELECT set_config('insight.medical_history_write', 'allowed', true)");
    await client.query(
      `INSERT INTO insight.medical_histories (
         research_case_id, presentation_status, previously_treated, supplemental_notes,
         revision, created_by_user_id, updated_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7)
       ON CONFLICT (research_case_id) DO UPDATE SET
         presentation_status = EXCLUDED.presentation_status,
         previously_treated = EXCLUDED.previously_treated,
         supplemental_notes = EXCLUDED.supplemental_notes,
         revision = EXCLUDED.revision,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = EXCLUDED.updated_at`,
      [
        researchCase.id,
        history.presentationStatus,
        history.previouslyTreated ?? null,
        history.supplementalNotes ?? null,
        revision,
        actor.id,
        now,
      ],
    );
    for (const table of [
      "prior_antipsychotic_trials",
      "current_medication_entries",
      "comorbidity_selections",
      "contraindication_outputs",
    ]) {
      await client.query(`DELETE FROM insight.${table} WHERE research_case_id = $1`, [
        researchCase.id,
      ]);
    }
    await insertTrials(client, researchCase.id, history.priorTrials ?? []);
    await insertCurrentMedications(client, researchCase.id, history.currentMedications);
    await insertComorbidities(client, researchCase.id, history.comorbidities);
    await insertContraindications(client, researchCase.id, history.contraindications);
    await client.query(
      `INSERT INTO insight.medical_history_save_events (
         research_case_id, patient_id, revision, presentation_status,
         actor_user_id, request_id, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        researchCase.id,
        researchCase.patient_id,
        revision,
        history.presentationStatus,
        actor.id,
        requestId,
        now,
      ],
    );
    await invalidateResearchCaseInputsInTransaction(
      client,
      actor,
      patientId,
      "Medical history changed.",
      requestId,
      now,
    );
    return (await loadHistory(client, researchCase.id))!;
  });
}

function validateCurrentMedication(input: CurrentMedicationInput): CurrentMedicationInput {
  validateNormalization(input.normalizationState, input.canonicalMedicationId);
  return compact({
    rawMedication: requiredText(input.rawMedication, "Current medication"),
    normalizationState: input.normalizationState,
    canonicalMedicationId: optionalText(input.canonicalMedicationId, "Canonical medication"),
    dose: optionalText(input.dose, "Dose"),
    doseUnit: optionalText(input.doseUnit, "Dose unit"),
    route: optionalText(input.route, "Route"),
    frequency: optionalText(input.frequency, "Frequency"),
  });
}

function validateTrial(input: AntipsychoticTrialInput): AntipsychoticTrialInput {
  validateNormalization(input.normalizationState, input.canonicalMedicationId);
  if (input.treatmentStart) validateDate(input.treatmentStart, "Treatment start");
  if (input.treatmentEnd) validateDate(input.treatmentEnd, "Treatment end");
  if (input.treatmentStart && input.treatmentEnd && input.treatmentEnd < input.treatmentStart) {
    throw new MedicalHistoryInputError("Treatment end cannot precede treatment start.");
  }
  const adverseEffects = input.adverseEffects?.map((effect) => ({
    catalogVersionId: requiredText(effect.catalogVersionId, "Adverse-effect catalog version"),
    termId: requiredText(effect.termId, "Adverse-effect term"),
  }));
  if (adverseEffects) {
    rejectDuplicateKeys(
      adverseEffects.map(({ catalogVersionId, termId }) => `${catalogVersionId}\0${termId}`),
      "adverse effect",
    );
  }
  return compact({
    medication: requiredText(input.medication, "Trial medication"),
    normalizationState: input.normalizationState,
    canonicalMedicationId: optionalText(input.canonicalMedicationId, "Canonical medication"),
    dose: optionalText(input.dose, "Dose"),
    doseUnit: optionalText(input.doseUnit, "Dose unit"),
    treatmentStart: input.treatmentStart,
    treatmentEnd: input.treatmentEnd,
    approximatePeriod: optionalText(input.approximatePeriod, "Approximate period"),
    response: input.response,
    adverseEffects,
    otherAdverseEffectDetail: optionalText(input.otherAdverseEffectDetail, "Other adverse effect"),
    discontinuationReason: optionalText(input.discontinuationReason, "Discontinuation reason"),
    notes: optionalText(input.notes, "Trial notes"),
  });
}

function validateComorbidity(input: ComorbiditySelectionInput): ComorbiditySelectionInput {
  return compact({
    catalogVersionId: requiredText(input.catalogVersionId, "Comorbidity catalog version"),
    termId: requiredText(input.termId, "Comorbidity term"),
    supplementalText: optionalText(input.supplementalText, "Comorbidity supplemental text"),
  });
}

function validateContraindication(input: ContraindicationOutputInput): ContraindicationOutputInput {
  return compact({
    ruleVersionId: requiredText(input.ruleVersionId, "Contraindication rule version"),
    ruleId: requiredText(input.ruleId, "Contraindication rule"),
    outcome: input.outcome,
    explanation: optionalText(input.explanation, "Contraindication explanation"),
  });
}

function validateNormalization(
  state: CurrentMedicationInput["normalizationState"],
  canonicalId: string | undefined,
): void {
  if ((state === "NORMALIZED") !== (canonicalId !== undefined)) {
    throw new MedicalHistoryInputError(
      "Canonical medication is required only for NORMALIZED medication entries.",
    );
  }
}

function validateDate(value: string, label: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new MedicalHistoryInputError(`${label} must use YYYY-MM-DD.`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== value) {
    throw new MedicalHistoryInputError(`${label} is not a valid calendar date.`);
  }
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new MedicalHistoryInputError(`${label} cannot be blank.`);
  return trimmed;
}

function optionalText(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : requiredText(value, label);
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function rejectDuplicateKeys(keys: readonly string[], label: string): void {
  if (new Set(keys).size !== keys.length) {
    throw new MedicalHistoryInputError(`Duplicate ${label} entries are not allowed.`);
  }
}

function requirePsychiatrist(actor: PatientActor): void {
  if (actor.role !== "PSYCHIATRIST")
    throw new MedicalHistoryConflictError("Psychiatrist required.");
}

async function caseByPatient(
  database: Pool | PoolClient,
  patientId: string,
  lock: boolean,
): Promise<CaseRow | undefined> {
  const result = await database.query<CaseRow>(
    `SELECT id, patient_id, workflow_revision FROM insight.research_cases
     WHERE patient_id = $1${lock ? " FOR UPDATE" : ""}`,
    [patientId],
  );
  return result.rows[0];
}

async function insertTrials(
  client: PoolClient,
  researchCaseId: string,
  trials: readonly AntipsychoticTrialInput[],
): Promise<void> {
  for (const [position, trial] of trials.entries()) {
    await client.query(
      `INSERT INTO insight.prior_antipsychotic_trials (
         research_case_id, position, medication, normalization_state, canonical_medication_id,
         dose, dose_unit, treatment_start, treatment_end, approximate_period, response,
         adverse_effects, other_adverse_effect_detail, discontinuation_reason, notes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        researchCaseId,
        position,
        trial.medication,
        trial.normalizationState ?? null,
        trial.canonicalMedicationId ?? null,
        trial.dose ?? null,
        trial.doseUnit ?? null,
        trial.treatmentStart ?? null,
        trial.treatmentEnd ?? null,
        trial.approximatePeriod ?? null,
        trial.response ?? null,
        trial.adverseEffects ?? null,
        trial.otherAdverseEffectDetail ?? null,
        trial.discontinuationReason ?? null,
        trial.notes ?? null,
      ],
    );
  }
}

async function insertCurrentMedications(
  client: PoolClient,
  researchCaseId: string,
  medications: readonly CurrentMedicationInput[],
): Promise<void> {
  for (const [position, medication] of medications.entries()) {
    await client.query(
      `INSERT INTO insight.current_medication_entries (
         research_case_id, position, raw_medication, normalization_state,
         canonical_medication_id, dose, dose_unit, route, frequency
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        researchCaseId,
        position,
        medication.rawMedication,
        medication.normalizationState ?? null,
        medication.canonicalMedicationId ?? null,
        medication.dose ?? null,
        medication.doseUnit ?? null,
        medication.route ?? null,
        medication.frequency ?? null,
      ],
    );
  }
}

async function insertComorbidities(
  client: PoolClient,
  researchCaseId: string,
  comorbidities: readonly ComorbiditySelectionInput[],
): Promise<void> {
  for (const [position, selection] of comorbidities.entries()) {
    await client.query(
      `INSERT INTO insight.comorbidity_selections (
         research_case_id, position, catalog_version_id, term_id, supplemental_text
       ) VALUES ($1, $2, $3, $4, $5)`,
      [
        researchCaseId,
        position,
        selection.catalogVersionId,
        selection.termId,
        selection.supplementalText ?? null,
      ],
    );
  }
}

async function insertContraindications(
  client: PoolClient,
  researchCaseId: string,
  contraindications: readonly ContraindicationOutputInput[],
): Promise<void> {
  for (const [position, output] of contraindications.entries()) {
    await client.query(
      `INSERT INTO insight.contraindication_outputs (
         research_case_id, position, rule_version_id, rule_id, outcome, explanation
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        researchCaseId,
        position,
        output.ruleVersionId,
        output.ruleId,
        output.outcome,
        output.explanation ?? null,
      ],
    );
  }
}

async function loadHistory(
  database: Pool | PoolClient,
  researchCaseId: string,
): Promise<MedicalHistoryRecord | null> {
  const historyResult = await database.query<HistoryRow>(
    "SELECT * FROM insight.medical_histories WHERE research_case_id = $1",
    [researchCaseId],
  );
  const row = historyResult.rows[0];
  if (!row) return null;
  const [trials, medications, comorbidities, contraindications] = await Promise.all([
    database.query<TrialRow>(
      "SELECT * FROM insight.prior_antipsychotic_trials WHERE research_case_id = $1 ORDER BY position",
      [researchCaseId],
    ),
    database.query<CurrentMedicationRow>(
      "SELECT * FROM insight.current_medication_entries WHERE research_case_id = $1 ORDER BY position",
      [researchCaseId],
    ),
    database.query<ComorbidityRow>(
      "SELECT * FROM insight.comorbidity_selections WHERE research_case_id = $1 ORDER BY position",
      [researchCaseId],
    ),
    database.query<ContraindicationRow>(
      "SELECT * FROM insight.contraindication_outputs WHERE research_case_id = $1 ORDER BY position",
      [researchCaseId],
    ),
  ]);

  return {
    researchCaseId,
    presentationStatus: row.presentation_status,
    ...(row.previously_treated === null ? {} : { previouslyTreated: row.previously_treated }),
    ...(row.presentation_status === "KNOWN_SCHIZOPHRENIA"
      ? { priorTrials: trials.rows.map(materializeTrial) }
      : {}),
    currentMedications: medications.rows.map((entry) =>
      compact({
        rawMedication: entry.raw_medication,
        normalizationState: entry.normalization_state ?? undefined,
        canonicalMedicationId: entry.canonical_medication_id ?? undefined,
        dose: entry.dose ?? undefined,
        doseUnit: entry.dose_unit ?? undefined,
        route: entry.route ?? undefined,
        frequency: entry.frequency ?? undefined,
      }),
    ),
    comorbidities: comorbidities.rows.map((entry) =>
      compact({
        catalogVersionId: entry.catalog_version_id,
        termId: entry.term_id,
        supplementalText: entry.supplemental_text ?? undefined,
      }),
    ),
    contraindications: contraindications.rows.map((entry) =>
      compact({
        ruleVersionId: entry.rule_version_id,
        ruleId: entry.rule_id,
        outcome: entry.outcome,
        explanation: entry.explanation ?? undefined,
      }),
    ),
    ...(row.supplemental_notes === null ? {} : { supplementalNotes: row.supplemental_notes }),
    revision: Number(row.revision),
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function materializeTrial(row: TrialRow): AntipsychoticTrialInput {
  return compact({
    medication: row.medication,
    normalizationState: row.normalization_state ?? undefined,
    canonicalMedicationId: row.canonical_medication_id ?? undefined,
    dose: row.dose ?? undefined,
    doseUnit: row.dose_unit ?? undefined,
    treatmentStart: row.treatment_start ?? undefined,
    treatmentEnd: row.treatment_end ?? undefined,
    approximatePeriod: row.approximate_period ?? undefined,
    response: row.response ?? undefined,
    adverseEffects: row.adverse_effects ?? undefined,
    otherAdverseEffectDetail: row.other_adverse_effect_detail ?? undefined,
    discontinuationReason: row.discontinuation_reason ?? undefined,
    notes: row.notes ?? undefined,
  });
}
