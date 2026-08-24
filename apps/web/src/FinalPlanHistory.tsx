import { useEffect, useState } from "react";

import {
  Badge,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
} from "./components/primitives";

interface FinalPlan {
  id: string;
  sequence: number;
  status: "ACTIVE" | "SUPERSEDED";
  predecessorId: string | null;
  plan: Readonly<Record<string, unknown>>;
  planHash: string;
  finalizedByUserId: string;
  finalizedAt: string;
}

async function loadFinalPlans(patientId: string): Promise<FinalPlan[]> {
  const response = await fetch(`/api/v1/patients/${patientId}/research-case/final-plans`);
  if (!response.ok) throw new Error("UNAVAILABLE");
  return (await response.json()).finalPlans;
}

export function FinalPlanHistory({
  patientId,
  csrfToken,
}: {
  patientId: string;
  csrfToken: string;
}) {
  const [plans, setPlans] = useState<FinalPlan[] | null>(null);
  const [error, setError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revisionReady, setRevisionReady] = useState(false);

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

  async function createRevision() {
    setCreating(true);
    setError(false);
    try {
      const response = await fetch(
        `/api/v1/patients/${patientId}/research-case/final-plans/revision`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({ schemaVersion: "1" }),
        },
      );
      if (!response.ok) throw new Error("UNAVAILABLE");
      setRevisionReady(true);
    } catch {
      setError(true);
    } finally {
      setCreating(false);
    }
  }

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

  return (
    <section className="page-stack" aria-labelledby="final-plan-history-title">
      <div className="section-heading">
        <div>
          <p className="kicker">Immutable history</p>
          <h2 id="final-plan-history-title">Final Treatment Plan history</h2>
        </div>
        <Button disabled={creating || revisionReady} onClick={() => void createRevision()}>
          {creating
            ? "Creating revision..."
            : revisionReady
              ? "Revision draft ready"
              : "Create revision"}
        </Button>
      </div>
      {revisionReady ? (
        <Banner title="Revision draft created" tone="info">
          Draft was seeded from active Final Treatment Plan in this Research Case. Required checks
          must complete before finalization.
        </Banner>
      ) : null}
      {plans.map((plan) => (
        <article className="card" key={plan.id}>
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
          <details>
            <summary>Read immutable plan snapshot</summary>
            <pre>{JSON.stringify(plan.plan, null, 2)}</pre>
            <code>SHA-256 {plan.planHash}</code>
          </details>
        </article>
      ))}
    </section>
  );
}
