import { useEffect, useMemo, useRef, useState } from "react";

import { calculatePanss, type PanssAnswers, type PanssSubscale } from "@insight/contracts";

import { Badge, Banner, Button, ErrorState, LoadingState } from "./components/primitives";
import { apiClient } from "./generated/api-client";
import type { operations } from "./generated/api-types";

type AssessmentResponse =
  operations["getPanssAssessment"]["responses"][200]["content"]["application/json"];
type SaveState = "idle" | "saving" | "saved" | "error";

const EMPTY_ANSWERS: PanssAnswers = {};
const SUBSCALES: readonly { id: PanssSubscale; label: string }[] = [
  { id: "POSITIVE", label: "Positive scale" },
  { id: "NEGATIVE", label: "Negative scale" },
  { id: "GENERAL", label: "General psychopathology scale" },
];

export function PanssAssessment({
  patientId,
  csrfToken,
}: {
  patientId: string;
  csrfToken: string;
}) {
  const [data, setData] = useState<AssessmentResponse | null>(null);
  const [workflowRevision, setWorkflowRevision] = useState<number | null>(null);
  const [answers, setAnswers] = useState<PanssAnswers>(EMPTY_ANSWERS);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const saveQueue = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    setData(null);
    setWorkflowRevision(null);
    setLoadFailed(false);
    void Promise.all([
      apiClient.GET("/api/v1/patients/{patientId}/research-case/panss", {
        params: { path: { patientId } },
      }),
      apiClient.GET("/api/v1/patients/{patientId}/research-case", {
        params: { path: { patientId } },
      }),
    ])
      .then(([assessmentResult, workflowResult]) => {
        if (!active) return;
        if (!assessmentResult.data || !workflowResult.data) {
          setLoadFailed(true);
          return;
        }
        setData(assessmentResult.data as unknown as AssessmentResponse);
        setWorkflowRevision(workflowResult.data.researchCase.revision);
        setAnswers((assessmentResult.data.assessment.answers as PanssAnswers | null) ?? {});
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [patientId, reload]);

  const calculation = useMemo(() => calculatePanss(answers), [answers]);

  function persist(nextAnswers: PanssAnswers) {
    if (workflowRevision === null) return;
    setSaveState("saving");
    saveQueue.current = saveQueue.current.then(async () => {
      const result = await apiClient.PUT("/api/v1/patients/{patientId}/research-case/panss", {
        params: { path: { patientId } },
        headers: { "x-csrf-token": csrfToken },
        body: {
          schemaVersion: "1",
          mode: "SAVE",
          expectedRevision: workflowRevision,
          answers: nextAnswers,
        },
      });
      if (!result.data) throw new Error("PANSS save failed");
      setData(result.data as unknown as AssessmentResponse);
      setSaveState("saved");
    });
    saveQueue.current.catch(() => setSaveState("error"));
  }

  function setScore(id: keyof PanssAnswers, score: number) {
    const next = { ...answers, [id]: score };
    setAnswers(next);
    persist(next);
  }

  async function complete() {
    if (workflowRevision === null || calculation.status !== "COMPLETE") return;
    await saveQueue.current.catch(() => undefined);
    setSaveState("saving");
    const result = await apiClient.PUT("/api/v1/patients/{patientId}/research-case/panss", {
      params: { path: { patientId } },
      headers: { "x-csrf-token": csrfToken },
      body: {
        schemaVersion: "1",
        mode: "COMPLETE",
        expectedRevision: workflowRevision,
        answers,
      },
    });
    if (result.data) {
      setData(result.data as unknown as AssessmentResponse);
      setSaveState("saved");
    } else setSaveState("error");
  }

  async function bypass() {
    if (workflowRevision === null) return;
    await saveQueue.current.catch(() => undefined);
    setSaveState("saving");
    const result = await apiClient.PUT("/api/v1/patients/{patientId}/research-case/panss", {
      params: { path: { patientId } },
      headers: { "x-csrf-token": csrfToken },
      body: { schemaVersion: "1", mode: "BYPASS", expectedRevision: workflowRevision },
    });
    if (result.data) {
      setData(result.data as unknown as AssessmentResponse);
      setAnswers({});
      setSaveState("saved");
    } else setSaveState("error");
  }

  if (!data && !loadFailed) return <LoadingState label="Loading PANSS assessment" />;
  if (loadFailed || !data) {
    return (
      <ErrorState
        title="PANSS assessment unavailable"
        description="Assessment data could not be loaded."
        action={<Button onClick={() => setReload((value) => value + 1)}>Try again</Button>}
      />
    );
  }

  return (
    <section className="card assessment-card" aria-labelledby="panss-title">
      <div className="section-heading">
        <div>
          <p className="kicker">Step 3 of 10</p>
          <h2 id="panss-title">{data.definition.title}</h2>
        </div>
        <Badge tone={data.assessment.status === "COMPLETED" ? "normal" : "warning"}>
          {data.assessment.status.replace("_", " ")}
        </Badge>
      </div>
      <Banner title="Complete clinician-rated instrument required" tone="info">
        Scores are calculated only after all 30 items are rated. Partial subscale or total scores
        are never presented as completed results.
      </Banner>
      {data.assessment.status === "BYPASSED" ? (
        <Banner title="PANSS assessment bypassed" tone="warning">
          Bypass is missing evidence, not a severity score. Selecting any score resumes the
          assessment.
        </Banner>
      ) : null}

      <form className="assessment-form" onSubmit={(event) => event.preventDefault()}>
        <p className="field-hint">{data.definition.instruction}</p>
        {SUBSCALES.map((subscale) => (
          <fieldset className="criterion-section panss-subscale" key={subscale.id}>
            <legend>{subscale.label}</legend>
            {data.definition.items
              .filter((item) => item.subscale === subscale.id)
              .map((item) => {
                const id = item.id as keyof PanssAnswers;
                return (
                  <label className="panss-item" key={item.id} htmlFor={`panss-${item.id}`}>
                    <span>
                      <strong>{item.id}</strong> {item.text}
                    </span>
                    <select
                      id={`panss-${item.id}`}
                      value={answers[id] ?? ""}
                      onChange={(event) => setScore(id, Number(event.currentTarget.value))}
                      required
                    >
                      <option value="">Not rated</option>
                      {data.definition.anchors.map((anchor) => (
                        <option value={anchor.score} key={anchor.score}>
                          {anchor.score} — {anchor.label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
          </fieldset>
        ))}

        <section className="calculation-panel" aria-live="polite" aria-atomic="true">
          <h3>PANSS calculation</h3>
          {calculation.scores ? (
            <dl className="panss-scores">
              <div>
                <dt>Positive</dt>
                <dd>{calculation.scores.positive}</dd>
              </div>
              <div>
                <dt>Negative</dt>
                <dd>{calculation.scores.negative}</dd>
              </div>
              <div>
                <dt>General</dt>
                <dd>{calculation.scores.general}</dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>{calculation.scores.total}</dd>
              </div>
            </dl>
          ) : (
            <p className="calculation-result">
              Incomplete: {calculation.answeredCount} of 30 items rated
            </p>
          )}
          <p className="field-hint">
            Calculation version {data.assessment.instrumentPin.calculationVersion}; instrument pin{" "}
            {data.assessment.instrumentPin.instrumentVersion}.
          </p>
        </section>

        {saveState === "error" ? (
          <p className="field-error" role="alert">
            PANSS assessment could not be saved. Try again.
          </p>
        ) : null}
        <p className="save-status" role="status">
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}
        </p>
        <div className="form-actions">
          <Button
            type="button"
            onClick={() => void complete()}
            disabled={calculation.status !== "COMPLETE"}
          >
            Complete PANSS assessment
          </Button>
          <Button type="button" variant="secondary" onClick={() => void bypass()}>
            Bypass PANSS assessment
          </Button>
        </div>
      </form>
    </section>
  );
}
