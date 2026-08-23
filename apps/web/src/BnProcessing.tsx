import { useEffect, useState } from "react";

import {
  Badge,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
} from "./components/primitives";

export type BnProcessingStatus =
  | "NOT_STARTED"
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "STALE";

type RouteStatus = "ACTIVE" | "INACTIVE" | "FAILED";
type ReviewStatus = "DOCUMENTED" | "NOT_DOCUMENTED" | "PENDING";
type BnFailureCode =
  | "ROUTE_INACTIVE"
  | "ROUTING_FAILED"
  | "CPT_GENERATION_FAILED"
  | "CPT_SNAPSHOT_STALE"
  | "DEPENDENCY_UNAVAILABLE";

type RoutedPathway = {
  pathway: string;
  modelVersion: string;
  modelHash: string;
  source: { label: string; version: string };
  evidenceStatus: ReviewStatus;
  calibrationStatus: ReviewStatus;
  clinicalReviewStatus: ReviewStatus;
};

type BnOutput = {
  label: string;
  value: string;
  evidence: string[];
};

export type BnProcessingResponse = {
  schemaVersion: "1";
  status: BnProcessingStatus;
  canRerun: boolean;
  route: {
    status: RouteStatus;
    routingVersion: string;
    matchedRules: string[];
    pathways: RoutedPathway[];
  };
  progress: { code: string; completedUnits: number | null; totalUnits: number | null } | null;
  failure: { code: BnFailureCode; message: string; retryable: boolean } | null;
  snapshot: {
    snapshotHash: string;
    promptVersion: string;
    schemaVersion: string;
    generatedAt: string;
    validationStatus: "MATHEMATICALLY_VALID";
    outputs: BnOutput[];
  } | null;
};

type RerunFailure = { code: string; message: string };
const activeStatuses = new Set<BnProcessingStatus>(["QUEUED", "RUNNING"]);

function words(value: string) {
  return value.replaceAll("_", " ").toLocaleLowerCase("en-US");
}

function statusLabel(value: string) {
  const label = words(value);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

async function requestStatus(patientId: string, csrfToken?: string) {
  const response = await fetch(`/api/v1/patients/${patientId}/research-case/bn-processing`, {
    method: csrfToken ? "POST" : "GET",
    headers: csrfToken ? { "content-type": "application/json", "x-csrf-token": csrfToken } : {},
    body: csrfToken ? "{}" : undefined,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw {
      code: body?.error?.code ?? "BN_RERUN_FAILED",
      message: body?.error?.message ?? "Bayesian processing rerun could not be started.",
    } satisfies RerunFailure;
  }
  const body = (await response.json()) as BnProcessingResponse;
  if (body.schemaVersion !== "1" || !body.route || !body.status) {
    throw { code: "INVALID_RESPONSE", message: "Bayesian processing status is invalid." };
  }
  return body;
}

export function BnProcessing({ patientId, csrfToken }: { patientId: string; csrfToken: string }) {
  const [result, setResult] = useState<BnProcessingResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [rerunFailure, setRerunFailure] = useState<RerunFailure | null>(null);

  useEffect(() => {
    let active = true;
    setResult(null);
    setLoadFailed(false);
    void requestStatus(patientId)
      .then((next) => {
        if (active) setResult(next);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [patientId]);

  useEffect(() => {
    if (!result || !activeStatuses.has(result.status)) return;
    let active = true;
    const timer = window.setInterval(() => {
      void requestStatus(patientId)
        .then((next) => {
          if (active) {
            setResult(next);
            setLoadFailed(false);
          }
        })
        .catch(() => {
          if (active) setLoadFailed(true);
        });
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [patientId, result?.status]);

  async function rerun() {
    setRerunning(true);
    setRerunFailure(null);
    try {
      setResult(await requestStatus(patientId, csrfToken));
    } catch (error) {
      const failure = error as Partial<RerunFailure>;
      setRerunFailure({
        code: failure.code ?? "BN_RERUN_FAILED",
        message: failure.message ?? "Bayesian processing rerun could not be started.",
      });
    } finally {
      setRerunning(false);
    }
  }

  if (!result && !loadFailed) return <LoadingState label="Loading Bayesian processing status" />;
  if (loadFailed) {
    return (
      <ErrorState
        title="Bayesian processing status unavailable"
        description="Route and snapshot status could not be verified. Progression remains blocked."
        action={<Button onClick={() => window.location.reload()}>Reload</Button>}
      />
    );
  }
  if (!result) return null;
  return (
    <BnProcessingView
      result={result}
      rerunning={rerunning}
      rerunFailure={rerunFailure}
      onRerun={() => void rerun()}
    />
  );
}

export function BnProcessingView({
  result,
  rerunning = false,
  rerunFailure = null,
  onRerun,
}: {
  result: BnProcessingResponse;
  rerunning?: boolean;
  rerunFailure?: RerunFailure | null;
  onRerun: () => void;
}) {
  const blocked = result.status !== "SUCCEEDED" || result.route.status !== "ACTIVE";
  const rerun = result.canRerun ? (
    <Button onClick={onRerun} loading={rerunning}>
      {result.status === "NOT_STARTED" ? "Run Bayesian processing" : "Rerun Bayesian processing"}
    </Button>
  ) : undefined;

  return (
    <section className="bn-processing" aria-labelledby="bn-processing-title">
      <div className="section-heading bn-processing__heading">
        <div>
          <p className="kicker">AI and Bayesian processing</p>
          <h2 id="bn-processing-title">Routed pathways and evidence</h2>
        </div>
        <Badge
          tone={
            result.status === "FAILED" || result.route.status === "FAILED"
              ? "urgent"
              : result.status === "STALE" || result.route.status === "INACTIVE"
                ? "warning"
                : result.status === "SUCCEEDED"
                  ? "normal"
                  : "info"
          }
        >
          {statusLabel(result.status)}
        </Badge>
      </div>

      {rerunFailure ? (
        <Banner title={`Rerun failed (${rerunFailure.code})`} tone="urgent">
          {rerunFailure.message} Progression remains blocked.
        </Banner>
      ) : null}

      <RouteSummary result={result} />

      {result.status === "NOT_STARTED" ? (
        <EmptyState
          title="Bayesian processing not started"
          description="No routed CPT snapshot or deterministic output is available."
          action={rerun}
        />
      ) : null}

      {activeStatuses.has(result.status) ? <Progress result={result} /> : null}

      {result.status === "FAILED" ? (
        <ErrorState
          title={`Bayesian processing failed (${result.failure?.code ?? "DEPENDENCY_UNAVAILABLE"})`}
          description={`${result.failure?.message ?? "A required Bayesian dependency failed."} Progression is blocked until a successful rerun.`}
          action={rerun}
        />
      ) : null}

      {result.status === "STALE" ? (
        <Banner title="Bayesian snapshot is stale" tone="warning">
          Inputs or dependencies changed after this snapshot. Prior output remains inspectable, but
          progression is blocked until a new snapshot succeeds. {rerun}
        </Banner>
      ) : null}

      {result.snapshot ? <Snapshot result={result} /> : null}

      {result.status === "SUCCEEDED" && !result.snapshot ? (
        <ErrorState
          title="Bayesian result unavailable"
          description="Success cannot be verified without accepted snapshot provenance. Progression remains blocked."
          action={rerun}
        />
      ) : null}

      <p className="bn-processing__boundary">
        Raw model responses, chain-of-thought, and internal Patient or execution identifiers are not
        displayed.
      </p>
      <p className="sr-only" aria-live="polite">
        {blocked ? "Bayesian progression blocked." : "Bayesian processing complete."}
      </p>
    </section>
  );
}

function RouteSummary({ result }: { result: BnProcessingResponse }) {
  const blocked = result.route.status !== "ACTIVE";
  return (
    <section className="card" aria-labelledby="bn-route-title">
      <div className="section-heading">
        <div>
          <p className="kicker">Deterministic backend routing</p>
          <h3 id="bn-route-title">Route status: {statusLabel(result.route.status)}</h3>
        </div>
        <Badge
          tone={blocked ? (result.route.status === "FAILED" ? "urgent" : "warning") : "normal"}
        >
          {blocked ? "Progression blocked" : "Active route"}
        </Badge>
      </div>
      <p>
        Routing table <code>{result.route.routingVersion}</code>
      </p>
      {result.route.matchedRules.length ? (
        <p>Matched rules: {result.route.matchedRules.join(", ")}</p>
      ) : (
        <p>No eligible pathway rule matched.</p>
      )}
      {blocked ? (
        <p className="field-error">Inactive or failed routing blocks progression.</p>
      ) : null}
    </section>
  );
}

function Progress({ result }: { result: BnProcessingResponse }) {
  const completed = result.progress?.completedUnits;
  const total = result.progress?.totalUnits;
  return (
    <div className="card bn-processing__progress" role="status" aria-live="polite">
      <span className="spinner spinner--large" aria-hidden="true" />
      <div>
        <h3>
          {result.status === "QUEUED"
            ? "Bayesian processing queued"
            : "Bayesian processing in progress"}
        </h3>
        <p>{result.progress ? statusLabel(result.progress.code) : "Waiting for progress"}</p>
        {completed !== null && completed !== undefined && total ? (
          <progress value={completed} max={total} aria-label="Bayesian processing progress" />
        ) : null}
      </div>
    </div>
  );
}

function Snapshot({ result }: { result: BnProcessingResponse }) {
  const snapshot = result.snapshot!;
  return (
    <>
      <Banner title="LLM-generated patient-specific research values" tone="warning">
        CPTs passed mathematical shape and normalization checks. This does not establish Bayesian
        calibration, clinical validity, or effectiveness. Inference outputs below are deterministic
        only when replaying this accepted snapshot.
      </Banner>
      <section className="card" aria-labelledby="bn-pathways-title">
        <p className="kicker">Model and governance provenance</p>
        <h3 id="bn-pathways-title">Routed model versions</h3>
        <div className="bn-pathway-list">
          {result.route.pathways.map((pathway) => (
            <details key={`${pathway.pathway}-${pathway.modelHash}`} open>
              <summary>{pathway.pathway}</summary>
              <dl className="profile-grid">
                <div>
                  <dt>Model version</dt>
                  <dd>{pathway.modelVersion}</dd>
                </div>
                <div>
                  <dt>Model hash</dt>
                  <dd>
                    <code>{pathway.modelHash}</code>
                  </dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{pathway.source.label}</dd>
                </div>
                <div>
                  <dt>Source version</dt>
                  <dd>{pathway.source.version}</dd>
                </div>
                <div>
                  <dt>Evidence status</dt>
                  <dd>{statusLabel(pathway.evidenceStatus)}</dd>
                </div>
                <div>
                  <dt>Calibration status</dt>
                  <dd>{statusLabel(pathway.calibrationStatus)}</dd>
                </div>
                <div>
                  <dt>Clinical review status</dt>
                  <dd>{statusLabel(pathway.clinicalReviewStatus)}</dd>
                </div>
              </dl>
            </details>
          ))}
        </div>
      </section>
      <section className="card" aria-labelledby="bn-output-title">
        <div className="section-heading">
          <div>
            <p className="kicker">Replayable snapshot output</p>
            <h3 id="bn-output-title">Deterministic outputs and evidence</h3>
          </div>
          <time dateTime={snapshot.generatedAt}>
            {new Date(snapshot.generatedAt).toLocaleString()}
          </time>
        </div>
        <ul className="bn-output-list">
          {snapshot.outputs.map((output) => (
            <li key={output.label}>
              <div>
                <strong>{output.label}</strong>
                <span>{output.value}</span>
              </div>
              <p>
                <b>Evidence:</b>{" "}
                {output.evidence.length
                  ? output.evidence.join("; ")
                  : "No evidence reference documented"}
              </p>
            </li>
          ))}
        </ul>
        <footer className="bn-provenance">
          <span>Snapshot hash: {snapshot.snapshotHash}</span>
          <span>Prompt: {snapshot.promptVersion}</span>
          <span>Schema: {snapshot.schemaVersion}</span>
          <span>Validation: {statusLabel(snapshot.validationStatus)}</span>
        </footer>
      </section>
    </>
  );
}
