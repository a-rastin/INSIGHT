import { type ReactNode, useEffect, useState } from "react";

import {
  Badge,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
} from "./components/primitives";

export type PrimaryPlanStatus =
  | "EMPTY"
  | "VALIDATION_ERROR"
  | "DEPENDENCY_UNAVAILABLE"
  | "QUEUED"
  | "RUNNING"
  | "FAILED"
  | "SUCCEEDED"
  | "STALE";

type Rationale = { kind: string; sourceRef: string; text: string };
type Medication = {
  canonicalMedicationId: string;
  dose: { value: number; unit: string };
  route: string;
  frequency: string;
  titration?: string;
  monitoring: string[];
  rationale?: Rationale[];
  warningRefs?: string[];
};
type SourceRecord = {
  sourceRef: string;
  label: string;
  category: "BN_INFERENCE" | "DDI_FINDING" | "EXECUTION";
  summary: string;
};
type Draft = {
  draftRef: string;
  draftRevision: number;
  aiImputationNoticeVisible: boolean;
  regimen: Medication[];
  generalMonitoring: string[];
  explanation: string;
  baseline: { draftRef: string; revision: number; changedFields: string[] };
  provenance: {
    schemaVersion: string;
    modelExecutionRef: string;
    primaryDdiExecutionRef: string;
    generatedAt: string;
  };
  authorizedSources: SourceRecord[];
  readiness?: {
    status: "CHECKING" | "BLOCKED" | "READY";
    reason: "PENDING" | "FAILED" | "UNPROVEN" | null;
    executionRef: string | null;
    findings: Array<{
      leftCanonicalId: string;
      rightCanonicalId: string;
      severity: string;
      recommendedAction?: string;
    }>;
  };
  catalog?: Array<{ canonicalMedicationId: string; preferredName: string }>;
};

type Review = {
  draftRef: string;
  draftRevision: number;
  aiImputationNoticeVisible: boolean;
  generatedPlan: {
    regimen: Medication[];
    generalMonitoring: string[];
    explanation: string;
    sourceExecutionRefs: string[];
  };
  regimen: Medication[];
  diff: Array<{ field: string }>;
  readiness: NonNullable<Draft["readiness"]>;
  catalog: NonNullable<Draft["catalog"]>;
  primaryDdiExecutionRef: string;
  updatedAt: string;
};

export type PrimaryPlanResponse = {
  schemaVersion: "1";
  status: PrimaryPlanStatus;
  progress: { message: string; completedUnits: number | null; totalUnits: number | null } | null;
  failure: { code: string; message: string } | null;
  draft: Draft | null;
};

async function requestPlan(patientId: string): Promise<PrimaryPlanResponse> {
  const response = await fetch(`/api/v1/patients/${patientId}/research-case/primary-plan`);
  if (response.status === 401 || response.status === 403) throw new Error("UNAUTHORIZED");
  if (!response.ok) throw new Error("UNAVAILABLE");
  const raw = (await response.json()) as Partial<PrimaryPlanResponse> & { review?: Review | null };
  const body: Partial<PrimaryPlanResponse> =
    "review" in raw
      ? {
          schemaVersion: "1",
          status: raw.review ? "SUCCEEDED" : "EMPTY",
          progress: null,
          failure: null,
          draft: raw.review ? reviewDraft(raw.review) : null,
        }
      : raw;
  if (
    body.schemaVersion !== "1" ||
    ![
      "EMPTY",
      "VALIDATION_ERROR",
      "DEPENDENCY_UNAVAILABLE",
      "QUEUED",
      "RUNNING",
      "FAILED",
      "SUCCEEDED",
      "STALE",
    ].includes(body.status ?? "")
  ) {
    return {
      schemaVersion: "1",
      status: "VALIDATION_ERROR",
      progress: null,
      failure: { code: "INVALID_RESPONSE", message: "Plan response validation failed." },
      draft: null,
    };
  }
  return body as PrimaryPlanResponse;
}

function reviewDraft(review: Review): Draft {
  const generatedById = new Map(
    review.generatedPlan.regimen.map((medication) => [
      medication.canonicalMedicationId,
      medication,
    ]),
  );
  const sources = new Map<string, SourceRecord>();
  for (const medication of review.generatedPlan.regimen) {
    for (const rationale of medication.rationale ?? []) {
      sources.set(rationale.sourceRef, {
        sourceRef: rationale.sourceRef,
        label: rationale.kind.replaceAll("_", " ").toLocaleLowerCase("en-US"),
        category: rationale.kind === "BN_INFERENCE" ? "BN_INFERENCE" : "EXECUTION",
        summary: rationale.text,
      });
    }
  }
  return {
    draftRef: review.draftRef,
    draftRevision: review.draftRevision,
    aiImputationNoticeVisible: review.aiImputationNoticeVisible,
    regimen: review.regimen.map((medication) => ({
      ...medication,
      rationale: generatedById.get(medication.canonicalMedicationId)?.rationale ?? [],
      warningRefs: generatedById.get(medication.canonicalMedicationId)?.warningRefs ?? [],
    })),
    generalMonitoring: review.generatedPlan.generalMonitoring,
    explanation: review.generatedPlan.explanation,
    baseline: {
      draftRef: review.draftRef,
      revision: 1,
      changedFields: review.diff.map(({ field }) => field),
    },
    provenance: {
      schemaVersion: "1.0.0",
      modelExecutionRef: review.generatedPlan.sourceExecutionRefs[0] ?? "unavailable",
      primaryDdiExecutionRef: review.primaryDdiExecutionRef,
      generatedAt: review.updatedAt,
    },
    authorizedSources: [...sources.values()],
    readiness: review.readiness,
    catalog: review.catalog,
  };
}

function completeDraft(draft: Draft): boolean {
  try {
    const sources = new Set(draft.authorizedSources.map(({ sourceRef }) => sourceRef));
    return Boolean(
      draft.draftRef &&
        draft.explanation &&
        draft.generalMonitoring.length &&
        draft.provenance.schemaVersion &&
        draft.provenance.modelExecutionRef &&
        draft.provenance.primaryDdiExecutionRef &&
        draft.provenance.generatedAt &&
        draft.regimen.length &&
        draft.regimen.every(
          (medication) =>
            medication.canonicalMedicationId &&
            Number.isFinite(medication.dose.value) &&
            medication.dose.unit &&
            medication.route &&
            medication.frequency &&
            Array.isArray(medication.monitoring) &&
            (medication.rationale ?? []).every(
              ({ sourceRef, text }) => sourceRef && text && sources.has(sourceRef),
            ) &&
            (medication.warningRefs ?? []).every((sourceRef) => sources.has(sourceRef)),
        ),
    );
  } catch {
    return false;
  }
}

export function PrimaryTreatmentPlan({
  patientId,
  csrfToken,
}: {
  patientId: string;
  csrfToken: string;
}) {
  const [result, setResult] = useState<PrimaryPlanResponse | null>(null);
  const [error, setError] = useState<"unauthorized" | "unavailable" | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setResult(null);
    setError(null);
    void requestPlan(patientId)
      .then((next) => {
        if (active) setResult(next);
      })
      .catch((reason: Error) => {
        if (active) setError(reason.message === "UNAUTHORIZED" ? "unauthorized" : "unavailable");
      });
    return () => {
      active = false;
    };
  }, [patientId]);

  useEffect(() => {
    if (result?.draft?.readiness?.status !== "CHECKING") return;
    let active = true;
    const timer = window.setInterval(() => {
      void requestPlan(patientId)
        .then((next) => {
          if (active) setResult(next);
        })
        .catch(() => {
          if (active) setError("unavailable");
        });
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [patientId, result?.draft?.readiness?.status]);

  if (!result && !error) return <LoadingState label="Loading Primary Treatment Plan draft" />;
  if (error) {
    return (
      <ErrorState
        title={error === "unauthorized" ? "Primary plan access denied" : "Primary plan unavailable"}
        description={
          error === "unauthorized"
            ? "Your session is not authorized to access this Research Case draft."
            : "Draft status and provenance could not be verified. No ready result is assumed."
        }
      />
    );
  }
  async function save(regimen: Medication[]) {
    setSaving(true);
    try {
      const response = await fetch(`/api/v1/patients/${patientId}/research-case/primary-plan`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          schemaVersion: "1",
          regimen: regimen.map((item) => ({
            canonicalMedicationId: item.canonicalMedicationId,
            dose: item.dose,
            route: item.route,
            frequency: item.frequency,
            ...(item.titration ? { titration: item.titration } : {}),
            monitoring: item.monitoring,
          })),
        }),
      });
      if (!response.ok) throw new Error("UNAVAILABLE");
      setResult(await requestPlan(patientId));
    } catch {
      setError("unavailable");
    } finally {
      setSaving(false);
    }
  }
  return result ? (
    <PrimaryTreatmentPlanView
      result={result}
      saving={saving}
      onSave={(regimen) => void save(regimen)}
    />
  ) : null;
}

export function PrimaryTreatmentPlanView({
  result,
  saving = false,
  onSave,
}: {
  result: PrimaryPlanResponse;
  saving?: boolean;
  onSave?: (regimen: Medication[]) => void;
}) {
  if (result.status === "EMPTY") {
    return (
      <PlanSection status={result.status}>
        <EmptyState
          title="No Primary Treatment Plan draft"
          description="Structured plan generation has not produced a draft for psychiatrist review."
        />
      </PlanSection>
    );
  }
  if (result.status === "QUEUED" || result.status === "RUNNING") {
    return (
      <PlanSection status={result.status}>
        <div className="card primary-plan__progress" role="status" aria-live="polite">
          <span className="spinner spinner--large" aria-hidden="true" />
          <div>
            <h3>
              {result.status === "QUEUED" ? "Plan generation queued" : "Plan generation running"}
            </h3>
            <p>{result.progress?.message ?? "Waiting for durable job progress."}</p>
            {result.progress?.completedUnits != null && result.progress.totalUnits ? (
              <progress
                value={result.progress.completedUnits}
                max={result.progress.totalUnits}
                aria-label="Primary plan generation progress"
              />
            ) : null}
          </div>
        </div>
      </PlanSection>
    );
  }
  if (["FAILED", "DEPENDENCY_UNAVAILABLE", "VALIDATION_ERROR"].includes(result.status)) {
    const title =
      result.status === "VALIDATION_ERROR"
        ? "Primary plan validation failed"
        : result.status === "DEPENDENCY_UNAVAILABLE"
          ? "Primary plan dependency unavailable"
          : "Primary plan generation failed";
    return (
      <PlanSection status={result.status}>
        <ErrorState
          title={title}
          description={`${result.failure?.message ?? "A complete structured draft is unavailable."} Psychiatrist review cannot begin.`}
        />
      </PlanSection>
    );
  }
  if (!result.draft || !completeDraft(result.draft)) {
    return (
      <PlanSection status="VALIDATION_ERROR">
        <ErrorState
          title="Primary plan validation failed"
          description="Draft fields, authorized rationale sources, or provenance are incomplete. Psychiatrist review cannot begin."
        />
      </PlanSection>
    );
  }

  const draft = result.draft;
  const sources = new Map(
    draft.authorizedSources.map((source, index) => [source.sourceRef, { source, index }]),
  );
  return (
    <PlanSection status={result.status}>
      {result.status === "STALE" ? (
        <Banner title="Primary plan draft is stale" tone="warning">
          Research Case inputs changed after generation. Prior draft remains readable, but it is not
          ready for review until generation succeeds against current inputs.
        </Banner>
      ) : (
        <Banner title="Ready for psychiatrist review" tone="info">
          Complete structured draft and authorized source records are available.
        </Banner>
      )}
      <Banner title="Psychiatrist controls every treatment decision" tone="warning">
        INSIGHT provides a system-generated research draft only. Psychiatrist must review every
        field, modify it when needed, and explicitly approve the final clinical decision.
      </Banner>
      {draft.aiImputationNoticeVisible ? (
        <p className="primary-plan__imputation" role="status">
          AI imputation was used for one or more bypassed assessments. Synthesized details are not
          displayed.
        </p>
      ) : null}
      {draft.readiness ? <FinalReadiness readiness={draft.readiness} /> : null}
      {onSave && draft.catalog ? (
        <RegimenEditor
          key={draft.draftRevision}
          draft={draft}
          saving={saving}
          onSave={onSave}
        />
      ) : null}
      <section className="card" aria-labelledby="primary-plan-regimen-title">
        <p className="kicker">Generated baseline</p>
        <h3 id="primary-plan-regimen-title">Structured regimen</h3>
        <div className="primary-plan__regimen">
          {draft.regimen.map((medication, medicationIndex) => (
            <article key={`${medication.canonicalMedicationId}-${medicationIndex}`}>
              <div className="primary-plan__medication-heading">
                <h4>{medication.canonicalMedicationId}</h4>
                <Badge tone="info">Draft item {medicationIndex + 1}</Badge>
              </div>
              <dl className="primary-plan__fields">
                <div>
                  <dt>Dose</dt>
                  <dd>
                    {medication.dose.value} {medication.dose.unit}
                  </dd>
                </div>
                <div>
                  <dt>Route</dt>
                  <dd>{medication.route}</dd>
                </div>
                <div>
                  <dt>Frequency</dt>
                  <dd>{medication.frequency}</dd>
                </div>
                <div>
                  <dt>Titration</dt>
                  <dd>{medication.titration}</dd>
                </div>
              </dl>
              <h5>Monitoring</h5>
              <ul>
                {medication.monitoring.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <h5>Rationale</h5>
              <ul className="primary-plan__rationale">
                {(medication.rationale ?? []).map((item) => {
                  const resolved = sources.get(item.sourceRef)!;
                  return (
                    <li key={`${item.sourceRef}-${item.text}`}>
                      {item.text}{" "}
                      <a href={`#primary-plan-source-${resolved.index}`}>{resolved.source.label}</a>
                    </li>
                  );
                })}
              </ul>
              {(medication.warningRefs ?? []).length ? (
                <div className="primary-plan__warnings">
                  <h5>Warnings</h5>
                  <ul>
                    {(medication.warningRefs ?? []).map((sourceRef) => {
                      const resolved = sources.get(sourceRef)!;
                      return (
                        <li key={sourceRef}>
                          <a href={`#primary-plan-source-${resolved.index}`}>
                            {resolved.source.label}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </section>
      <div className="primary-plan__columns">
        <section className="card" aria-labelledby="primary-plan-monitoring-title">
          <p className="kicker">Across regimen</p>
          <h3 id="primary-plan-monitoring-title">General monitoring</h3>
          <ul>
            {draft.generalMonitoring.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p>{draft.explanation}</p>
        </section>
        <section className="card" aria-labelledby="primary-plan-baseline-title">
          <p className="kicker">Difference baseline</p>
          <h3 id="primary-plan-baseline-title">Psychiatrist changes</h3>
          {draft.baseline.changedFields.length ? (
            <ul>
              {draft.baseline.changedFields.map((field) => (
                <li key={field}>{field}</li>
              ))}
            </ul>
          ) : (
            <p>No psychiatrist changes from generated baseline.</p>
          )}
          <p className="primary-plan__mono">
            Baseline {draft.baseline.draftRef}, revision {draft.baseline.revision}
          </p>
        </section>
      </div>
      <section className="card" aria-labelledby="primary-plan-sources-title">
        <p className="kicker">Authorized Research Case records</p>
        <h3 id="primary-plan-sources-title">Rationale and warning sources</h3>
        <ol className="primary-plan__sources">
          {draft.authorizedSources.map((source, index) => (
            <li id={`primary-plan-source-${index}`} key={source.sourceRef} tabIndex={-1}>
              <div>
                <strong>{source.label}</strong>
                <Badge tone={source.category === "DDI_FINDING" ? "warning" : "info"}>
                  {source.category.replaceAll("_", " ").toLocaleLowerCase("en-US")}
                </Badge>
              </div>
              <p>{source.summary}</p>
              <code>{source.sourceRef}</code>
            </li>
          ))}
        </ol>
      </section>
      <footer className="primary-plan__provenance">
        <span>
          Draft: {draft.draftRef} / revision {draft.draftRevision}
        </span>
        <span>Schema: {draft.provenance.schemaVersion}</span>
        <span>Model execution: {draft.provenance.modelExecutionRef}</span>
        <span>Primary DDI: {draft.provenance.primaryDdiExecutionRef}</span>
        <time dateTime={draft.provenance.generatedAt}>
          {new Date(draft.provenance.generatedAt).toLocaleString()}
        </time>
      </footer>
    </PlanSection>
  );
}

function PlanSection({ children, status }: { children: ReactNode; status: PrimaryPlanStatus }) {
  const tone =
    status === "SUCCEEDED"
      ? "normal"
      : status === "FAILED" || status === "VALIDATION_ERROR" || status === "DEPENDENCY_UNAVAILABLE"
        ? "urgent"
        : status === "STALE"
          ? "warning"
          : "info";
  return (
    <section className="primary-plan" aria-labelledby="primary-plan-title">
      <div className="section-heading primary-plan__heading">
        <div>
          <p className="kicker">Primary Treatment Plan</p>
          <h2 id="primary-plan-title">Explainable draft review</h2>
        </div>
        <Badge tone={tone}>{status.replaceAll("_", " ").toLocaleLowerCase("en-US")}</Badge>
      </div>
      {children}
    </section>
  );
}

function FinalReadiness({ readiness }: { readiness: NonNullable<Draft["readiness"]> }) {
  if (readiness.status === "READY") {
    return (
      <Banner
        title="Final regimen DDI recheck complete"
        tone={readiness.findings.length ? "warning" : "info"}
      >
        <p>Exact regimen is ready to finalize. Findings are warnings and do not block readiness.</p>
        {readiness.findings.map((finding) => (
          <p key={`${finding.leftCanonicalId}-${finding.rightCanonicalId}-${finding.severity}`}>
            Warning: {finding.leftCanonicalId} + {finding.rightCanonicalId} ({finding.severity})
            {finding.recommendedAction ? `: ${finding.recommendedAction}` : ""}
          </p>
        ))}
      </Banner>
    );
  }
  return (
    <Banner
      title={
        readiness.status === "CHECKING"
          ? "Final regimen DDI recheck running"
          : "Finalization blocked"
      }
      tone={readiness.status === "CHECKING" ? "info" : "urgent"}
    >
      {readiness.reason === "FAILED"
        ? "Final-regimen DDI recheck failed. A successful exact-regimen check is required."
        : readiness.reason === "UNPROVEN"
          ? "No proven final-regimen DDI result is bound to this draft."
          : "Medication safety check is pending."}
    </Banner>
  );
}

function RegimenEditor({
  draft,
  saving,
  onSave,
}: {
  draft: Draft;
  saving: boolean;
  onSave: (regimen: Medication[]) => void;
}) {
  const [regimen, setRegimen] = useState(draft.regimen);
  const catalog = draft.catalog!;
  const update = (index: number, patch: Partial<Medication>) =>
    setRegimen((current) =>
      current.map((medication, position) =>
        position === index ? { ...medication, ...patch } : medication,
      ),
    );
  return (
    <section className="card primary-plan__editor" aria-labelledby="primary-plan-editor-title">
      <p className="kicker">Clinician edit</p>
      <h3 id="primary-plan-editor-title">Final structured regimen</h3>
      <p>Any canonical medication may be selected. DDI findings remain warning-only.</p>
      {regimen.map((medication, index) => (
        <fieldset key={index}>
          <legend>Medication {index + 1}</legend>
          <label>
            Canonical medication
            <select
              value={medication.canonicalMedicationId}
              onChange={(event) => update(index, { canonicalMedicationId: event.target.value })}
            >
              {catalog.map((entry) => (
                <option key={entry.canonicalMedicationId} value={entry.canonicalMedicationId}>
                  {entry.preferredName} ({entry.canonicalMedicationId})
                </option>
              ))}
            </select>
          </label>
          <label>
            Dose
            <input
              type="number"
              min="0.01"
              step="any"
              value={medication.dose.value}
              onChange={(event) =>
                update(index, { dose: { ...medication.dose, value: Number(event.target.value) } })
              }
            />
          </label>
          <label>
            Unit
            <input
              value={medication.dose.unit}
              onChange={(event) =>
                update(index, { dose: { ...medication.dose, unit: event.target.value } })
              }
            />
          </label>
          <label>
            Route
            <input
              value={medication.route}
              onChange={(event) => update(index, { route: event.target.value })}
            />
          </label>
          <label>
            Frequency
            <input
              value={medication.frequency}
              onChange={(event) => update(index, { frequency: event.target.value })}
            />
          </label>
          <Button
            variant="secondary"
            onClick={() =>
              setRegimen((current) => current.filter((_, position) => position !== index))
            }
          >
            Remove medication
          </Button>
        </fieldset>
      ))}
      <div className="primary-plan__editor-actions">
        <Button
          variant="secondary"
          disabled={!catalog.length || regimen.length >= 100}
          onClick={() => {
            const entry = catalog.find(
              ({ canonicalMedicationId }) =>
                !regimen.some((item) => item.canonicalMedicationId === canonicalMedicationId),
            );
            if (entry)
              setRegimen((current) => [
                ...current,
                {
                  canonicalMedicationId: entry.canonicalMedicationId,
                  dose: { value: 1, unit: "mg" },
                  route: "oral",
                  frequency: "once daily",
                  titration: "Reassess before change.",
                  monitoring: [],
                  rationale: [],
                  warningRefs: [],
                },
              ]);
          }}
        >
          Add medication
        </Button>
        <Button disabled={!regimen.length} loading={saving} onClick={() => onSave(regimen)}>
          Save regimen and recheck DDI
        </Button>
      </div>
    </section>
  );
}
