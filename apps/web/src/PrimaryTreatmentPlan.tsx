import { type ReactNode, useEffect, useState } from "react";

import { Badge, Banner, EmptyState, ErrorState, LoadingState } from "./components/primitives";

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
  titration: string;
  monitoring: string[];
  rationale: Rationale[];
  warningRefs: string[];
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
  const body = (await response.json()) as Partial<PrimaryPlanResponse>;
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
            medication.titration &&
            medication.monitoring.length > 0 &&
            medication.rationale.length > 0 &&
            medication.rationale.every(
              ({ sourceRef, text }) => sourceRef && text && sources.has(sourceRef),
            ) &&
            medication.warningRefs.every((sourceRef) => sources.has(sourceRef)),
        ),
    );
  } catch {
    return false;
  }
}

export function PrimaryTreatmentPlan({ patientId }: { patientId: string }) {
  const [result, setResult] = useState<PrimaryPlanResponse | null>(null);
  const [error, setError] = useState<"unauthorized" | "unavailable" | null>(null);

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
  return result ? <PrimaryTreatmentPlanView result={result} /> : null;
}

export function PrimaryTreatmentPlanView({ result }: { result: PrimaryPlanResponse }) {
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
                {medication.rationale.map((item) => {
                  const resolved = sources.get(item.sourceRef)!;
                  return (
                    <li key={`${item.sourceRef}-${item.text}`}>
                      {item.text}{" "}
                      <a href={`#primary-plan-source-${resolved.index}`}>{resolved.source.label}</a>
                    </li>
                  );
                })}
              </ul>
              {medication.warningRefs.length ? (
                <div className="primary-plan__warnings">
                  <h5>Warnings</h5>
                  <ul>
                    {medication.warningRefs.map((sourceRef) => {
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
