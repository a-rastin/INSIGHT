import { useEffect, useState } from "react";

import { Badge, Button, EmptyState, ErrorState, LoadingState } from "./components/primitives";

interface FinalPlan {
  id: string;
  sequence: number;
  status: "ACTIVE" | "SUPERSEDED";
  predecessorId: string | null;
  plan: {
    subject?: {
      maskedName: string;
      identifier: { type: string; issuingAuthority: string; maskedValue: string };
      ageAtResearchCaseStart: number;
      sex: "MALE" | "FEMALE";
      researchCaseStartedAt: string;
    };
    generatedPlan?: {
      generalMonitoring?: string[];
      explanation?: string;
    };
    finalRegimen?: Medication[];
  };
  planHash: string;
  provenance: Readonly<Record<string, unknown>>;
  finalizedByUserId: string;
  finalizedAt: string;
  exportArtifact?: {
    byteLength: number;
    contentHash: string;
    mediaType: "application/json";
    createdAt: string;
  };
}

interface Medication {
  canonicalMedicationId: string;
  dose: { value: number; unit: string };
  route: string;
  frequency: string;
  titration?: string;
  monitoring: string[];
}

async function loadFinalPlans(patientId: string): Promise<FinalPlan[]> {
  const response = await fetch(`/api/v1/patients/${patientId}/research-case/final-plans`);
  if (!response.ok) throw new Error("UNAVAILABLE");
  return (await response.json()).finalPlans;
}

export function FinalPlanHistory({ patientId }: { patientId: string; csrfToken?: string }) {
  const [plans, setPlans] = useState<FinalPlan[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setPlans(null);
    setError(false);
    void loadFinalPlans(patientId)
      .then((value) => {
        if (active) setPlans(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [patientId]);

  if (!plans && !error) return <LoadingState label="Loading Final Treatment Plan history" />;
  if (error) {
    return (
      <ErrorState
        title="Final Plan history unavailable"
        description="Immutable versions and revision status could not be verified."
      />
    );
  }
  if (!plans?.length) {
    return (
      <section aria-labelledby="final-plan-history-title">
        <h2 id="final-plan-history-title">Final Treatment Plan history</h2>
        <EmptyState
          title="No Final Treatment Plan"
          description="No immutable plan version has been finalized for this Research Case."
        />
      </section>
    );
  }

  return <FinalPlanHistoryView patientId={patientId} plans={plans} />;
}

export function FinalPlanHistoryView({
  patientId,
  plans,
}: {
  patientId: string;
  plans: FinalPlan[];
}) {
  return (
    <section className="page-stack final-plan-history" aria-labelledby="final-plan-history-title">
      <div className="section-heading">
        <div>
          <p className="kicker">Immutable history</p>
          <h2 id="final-plan-history-title">Final Treatment Plan history</h2>
        </div>
        <Button className="print-hidden" variant="secondary" onClick={() => window.print()}>
          Print selected history
        </Button>
      </div>
      {plans.map((plan) => (
        <article className="card final-plan" key={plan.id}>
          <div className="section-heading">
            <div>
              <p className="kicker">Version {plan.sequence}</p>
              <h3>Final Treatment Plan</h3>
            </div>
            <Badge tone={plan.status === "ACTIVE" ? "normal" : "info"}>{plan.status}</Badge>
          </div>
          <dl className="profile-grid">
            <div>
              <dt>Version ID</dt>
              <dd>
                <code>{plan.id}</code>
              </dd>
            </div>
            <div>
              <dt>Predecessor</dt>
              <dd>
                <code>{plan.predecessorId ?? "None"}</code>
              </dd>
            </div>
            <div>
              <dt>Finalized by</dt>
              <dd>
                <code>{plan.finalizedByUserId}</code>
              </dd>
            </div>
            <div>
              <dt>Finalized at</dt>
              <dd>{new Date(plan.finalizedAt).toLocaleString()}</dd>
            </div>
          </dl>
          {plan.plan.subject ? (
            <dl className="profile-grid final-plan__subject">
              <div>
                <dt>Patient</dt>
                <dd>{plan.plan.subject.maskedName}</dd>
              </div>
              <div>
                <dt>Masked identifier</dt>
                <dd>{plan.plan.subject.identifier.maskedValue}</dd>
              </div>
              <div>
                <dt>Age at Research Case start</dt>
                <dd>{plan.plan.subject.ageAtResearchCaseStart}</dd>
              </div>
              <div>
                <dt>Sex</dt>
                <dd>{plan.plan.subject.sex === "MALE" ? "Male" : "Female"}</dd>
              </div>
            </dl>
          ) : null}
          <section aria-labelledby={`final-plan-regimen-${plan.id}`}>
            <p className="kicker">Immutable snapshot</p>
            <h4 id={`final-plan-regimen-${plan.id}`}>Exact structured regimen</h4>
            <div className="primary-plan__regimen">
              {(plan.plan.finalRegimen ?? []).map((medication, index) => (
                <article key={`${medication.canonicalMedicationId}-${index}`}>
                  <h5>{medication.canonicalMedicationId}</h5>
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
                      <dd>{medication.titration ?? "Not recorded"}</dd>
                    </div>
                  </dl>
                  <h5>Monitoring</h5>
                  <ul>
                    {medication.monitoring.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </section>
          {plan.plan.generatedPlan ? (
            <section className="final-plan__summary" aria-label="Final plan summary">
              <h4>General monitoring</h4>
              <ul>
                {(plan.plan.generatedPlan.generalMonitoring ?? []).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p>{plan.plan.generatedPlan.explanation}</p>
              <h4>Original generated plan</h4>
              <pre>{JSON.stringify(plan.plan.generatedPlan, null, 2)}</pre>
            </section>
          ) : null}
          <section className="final-plan__provenance" aria-label="Permitted provenance">
            <h4>Permitted provenance</h4>
            <pre>{JSON.stringify(permittedProvenance(plan.provenance), null, 2)}</pre>
          </section>
          <footer className="primary-plan__provenance">
            <code>Plan SHA-256 {plan.planHash}</code>
            {plan.exportArtifact ? (
              <>
                <code>Export SHA-256 {plan.exportArtifact.contentHash}</code>
                <span>{plan.exportArtifact.byteLength} bytes</span>
              </>
            ) : null}
            <a
              className="button print-hidden"
              href={`/api/v1/patients/${patientId}/research-case/final-plans/${plan.id}/export`}
            >
              Export JSON
            </a>
          </footer>
        </article>
      ))}
    </section>
  );
}

function permittedProvenance(provenance: Readonly<Record<string, unknown>>) {
  const domainResults = Array.isArray(provenance.domainResults)
    ? provenance.domainResults.filter(
        (result) =>
          typeof result !== "object" ||
          result === null ||
          (result as { result_type?: string }).result_type !== "ASSESSMENT_IMPUTATION",
      )
    : [];
  return { ...provenance, domainResults };
}
