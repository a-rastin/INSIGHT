import { useEffect, useState } from "react";

import {
  Badge,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
} from "./components/primitives";

export type DdiStatus = "NOT_STARTED" | "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "STALE";
type DdiMode = "PRIMARY_FILTER" | "FINAL_RECHECK";

type RegimenMedication = {
  medicationEntryRef: string;
  kind: "CURRENT" | "PROPOSED";
  normalizationState: "NORMALIZED" | "UNKNOWN";
  canonicalId?: string;
};

type Finding = {
  leftCanonicalId: string;
  rightCanonicalId: string;
  severity: string;
  mechanism?: string;
  clinicalEffect?: string;
  recommendedAction?: string;
  sourceRecordRef: string;
};

export type DdiStatusResponse = {
  schemaVersion: "1";
  status: DdiStatus;
  mode: DdiMode;
  canRerun: boolean;
  progress: { code: string; completedUnits: number | null; totalUnits: number | null } | null;
  failure: { code: string; message: string } | null;
  execution: {
    executionRef: string;
    sourceVersion: string;
    exactRegimen: RegimenMedication[];
    findings: Finding[];
    hasUnknownMedication: boolean;
    executedAt: string;
  } | null;
};

const terminal = new Set<DdiStatus>(["SUCCEEDED", "FAILED", "STALE", "NOT_STARTED"]);

function statusLabel(status: DdiStatus) {
  return status === "NOT_STARTED"
    ? "Not started"
    : status.charAt(0) + status.slice(1).toLowerCase();
}

function severityLabel(value: string) {
  return value.replaceAll("_", " ").toLocaleLowerCase("en-US");
}

async function requestStatus(patientId: string, csrfToken?: string) {
  const response = await fetch(`/api/v1/patients/${patientId}/research-case/ddi`, {
    method: csrfToken ? "POST" : "GET",
    headers: csrfToken ? { "content-type": "application/json", "x-csrf-token": csrfToken } : {},
    body: csrfToken ? "{}" : undefined,
  });
  if (!response.ok) throw new Error("DDI status request failed.");
  const body = (await response.json()) as DdiStatusResponse;
  if (
    body.schemaVersion !== "1" ||
    (!terminal.has(body.status) && !["QUEUED", "RUNNING"].includes(body.status))
  ) {
    throw new Error("DDI status response is invalid.");
  }
  return body;
}

export function DdiResults({ patientId, csrfToken }: { patientId: string; csrfToken: string }) {
  const [result, setResult] = useState<DdiStatusResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [rerunning, setRerunning] = useState(false);

  useEffect(() => {
    let active = true;
    setResult(null);
    setFailed(false);
    void requestStatus(patientId)
      .then((next) => {
        if (active) setResult(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [patientId]);

  useEffect(() => {
    if (!result || !["QUEUED", "RUNNING"].includes(result.status)) return;
    let active = true;
    const timer = window.setInterval(() => {
      void requestStatus(patientId)
        .then((next) => {
          if (active) {
            setResult(next);
            setFailed(false);
          }
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [patientId, result?.status]);

  async function rerun() {
    setRerunning(true);
    setFailed(false);
    try {
      setResult(await requestStatus(patientId, csrfToken));
    } catch {
      setFailed(true);
    } finally {
      setRerunning(false);
    }
  }

  if (!result && !failed) return <LoadingState label="Loading DDI status" />;
  if (failed) {
    return (
      <ErrorState
        title="DDI status unavailable"
        description="DDI status could not be verified. No successful check is assumed."
        action={<Button onClick={() => window.location.reload()}>Reload</Button>}
      />
    );
  }
  if (!result) return null;
  return <DdiResultsView result={result} rerunning={rerunning} onRerun={() => void rerun()} />;
}

export function DdiResultsView({
  result,
  rerunning = false,
  onRerun,
}: {
  result: DdiStatusResponse;
  rerunning?: boolean;
  onRerun: () => void;
}) {
  const modeLabel =
    result.mode === "FINAL_RECHECK" ? "Final-regimen recheck" : "Primary regimen check";
  const rerun = result.canRerun ? (
    <Button onClick={onRerun} loading={rerunning}>
      {result.status === "NOT_STARTED" ? "Run DDI check" : "Rerun DDI check"}
    </Button>
  ) : undefined;

  if (result.status === "NOT_STARTED") {
    return (
      <section className="ddi-results" aria-labelledby="ddi-results-title">
        <DdiHeading modeLabel={modeLabel} status={result.status} />
        <EmptyState
          title="DDI check not started"
          description="No DDI result is available for this regimen."
          action={rerun}
        />
      </section>
    );
  }

  if (result.status === "QUEUED" || result.status === "RUNNING") {
    const completed = result.progress?.completedUnits;
    const total = result.progress?.totalUnits;
    return (
      <section className="ddi-results" aria-labelledby="ddi-results-title">
        <DdiHeading modeLabel={modeLabel} status={result.status} />
        <div className="card ddi-progress" role="status" aria-live="polite">
          <span className="spinner spinner--large" aria-hidden="true" />
          <div>
            <h3>{result.status === "QUEUED" ? "DDI check queued" : "DDI check in progress"}</h3>
            <p>{result.progress ? severityLabel(result.progress.code) : "Waiting for progress"}</p>
            {completed !== null && completed !== undefined && total ? (
              <progress value={completed} max={total} aria-label="DDI check progress" />
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  if (result.status === "FAILED") {
    return (
      <section className="ddi-results" aria-labelledby="ddi-results-title">
        <DdiHeading modeLabel={modeLabel} status={result.status} />
        <ErrorState
          title="DDI check failed"
          description={`${result.failure?.message ?? "A required DDI dependency failed."} Next workflow state is blocked until a successful rerun.`}
          action={rerun}
        />
      </section>
    );
  }

  if (!result.execution) {
    return (
      <section className="ddi-results" aria-labelledby="ddi-results-title">
        <DdiHeading modeLabel={modeLabel} status={result.status} />
        <ErrorState
          title="DDI result unavailable"
          description="Completion cannot be verified without result and provenance records."
          action={rerun}
        />
      </section>
    );
  }

  const { execution } = result;
  return (
    <section className="ddi-results" aria-labelledby="ddi-results-title">
      <DdiHeading modeLabel={modeLabel} status={result.status} />
      {result.status === "STALE" ? (
        <Banner title="DDI result is stale" tone="warning">
          Regimen inputs changed after this check. Next workflow state is blocked until a new check
          succeeds. {rerun}
        </Banner>
      ) : (
        <Banner title="DDI check completed" tone="info">
          Result and provenance were accepted. Findings remain warnings only and do not block the
          next workflow state.
        </Banner>
      )}
      {execution.hasUnknownMedication ? (
        <p className="ddi-unknown-warning" role="status">
          <span aria-hidden="true">!</span> Interaction coverage is incomplete because one or more
          medications could not be normalized.
        </p>
      ) : null}
      <section className="card" aria-labelledby="ddi-regimen-title">
        <div className="section-heading">
          <div>
            <p className="kicker">Evaluated input</p>
            <h3 id="ddi-regimen-title">Exact regimen snapshot</h3>
          </div>
          <time dateTime={execution.executedAt}>
            {new Date(execution.executedAt).toLocaleString()}
          </time>
        </div>
        <ul className="ddi-regimen-list">
          {execution.exactRegimen.map((medication) => (
            <li key={medication.medicationEntryRef}>
              <span>{medication.kind === "CURRENT" ? "Current" : "Proposed"}</span>
              <strong>
                {medication.normalizationState === "NORMALIZED" && medication.canonicalId
                  ? medication.canonicalId
                  : "Unresolved medication"}
              </strong>
              <Badge tone={medication.normalizationState === "UNKNOWN" ? "warning" : "info"}>
                {medication.normalizationState === "UNKNOWN" ? "Unknown" : "Normalized"}
              </Badge>
            </li>
          ))}
        </ul>
      </section>
      <section className="card" aria-labelledby="ddi-findings-title">
        <p className="kicker">Warning-only results</p>
        <h3 id="ddi-findings-title">Findings and evidence</h3>
        {execution.findings.length === 0 ? (
          <p className="ddi-none">
            <span aria-hidden="true">✓</span> No interactions were found in evaluated pairs.
          </p>
        ) : (
          <ul className="ddi-finding-list">
            {execution.findings.map((finding) => (
              <li
                key={`${finding.leftCanonicalId}-${finding.rightCanonicalId}-${finding.sourceRecordRef}`}
              >
                <div className="ddi-finding-icon" aria-hidden="true">
                  !
                </div>
                <div>
                  <div className="ddi-finding-title">
                    <strong>
                      {finding.leftCanonicalId} + {finding.rightCanonicalId}
                    </strong>
                    <Badge tone="warning">{severityLabel(finding.severity)} warning</Badge>
                  </div>
                  {finding.mechanism ? (
                    <p>
                      <b>Mechanism:</b> {finding.mechanism}
                    </p>
                  ) : null}
                  {finding.clinicalEffect ? (
                    <p>
                      <b>Clinical effect:</b> {finding.clinicalEffect}
                    </p>
                  ) : null}
                  {finding.recommendedAction ? (
                    <p>
                      <b>Recommended action:</b> {finding.recommendedAction}
                    </p>
                  ) : null}
                  <p className="ddi-evidence">
                    <b>Evidence:</b> {finding.sourceRecordRef}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <footer className="ddi-provenance">
        <span>Execution: {execution.executionRef}</span>
        <span>Source: {execution.sourceVersion}</span>
      </footer>
    </section>
  );
}

function DdiHeading({ modeLabel, status }: { modeLabel: string; status: DdiStatus }) {
  const tone =
    status === "FAILED"
      ? "urgent"
      : status === "STALE"
        ? "warning"
        : status === "SUCCEEDED"
          ? "normal"
          : "info";
  return (
    <div className="section-heading ddi-heading">
      <div>
        <p className="kicker">Drug-drug interaction workflow</p>
        <h2 id="ddi-results-title">{modeLabel}</h2>
      </div>
      <Badge tone={tone}>{statusLabel(status)}</Badge>
    </div>
  );
}
