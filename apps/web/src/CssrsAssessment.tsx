import { useEffect, useMemo, useRef, useState } from "react";

import { CSSRS_BANDS, calculateCssrs, type CssrsAnswers } from "@insight/contracts";

import { Badge, Banner, Button, ErrorState, LoadingState } from "./components/primitives";
import { apiClient } from "./generated/api-client";
import type { operations } from "./generated/api-types";

type AssessmentResponse =
  operations["getCssrsRecentAssessment"]["responses"][200]["content"]["application/json"];
type SaveState = "idle" | "saving" | "saved" | "error";
type AnswerKey = keyof CssrsAnswers;

const EMPTY_ANSWERS: CssrsAnswers = {};

export function CssrsAssessment({
  patientId,
  csrfToken,
}: {
  patientId: string;
  csrfToken: string;
}) {
  const [data, setData] = useState<AssessmentResponse | null>(null);
  const [workflowRevision, setWorkflowRevision] = useState<number | null>(null);
  const [answers, setAnswers] = useState<CssrsAnswers>(EMPTY_ANSWERS);
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
      apiClient.GET("/api/v1/patients/{patientId}/research-case/cssrs-recent", {
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
        setData(assessmentResult.data);
        setWorkflowRevision(workflowResult.data.researchCase.revision);
        setAnswers((assessmentResult.data.assessment.answers as CssrsAnswers | null) ?? {});
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [patientId, reload]);

  const calculation = useMemo(() => calculateCssrs(answers), [answers]);

  function persist(nextAnswers: CssrsAnswers) {
    if (workflowRevision === null) return;
    setSaveState("saving");
    saveQueue.current = saveQueue.current.then(async () => {
      const result = await apiClient.PUT(
        "/api/v1/patients/{patientId}/research-case/cssrs-recent",
        {
          params: { path: { patientId } },
          headers: { "x-csrf-token": csrfToken },
          body: {
            schemaVersion: "1",
            mode: "SAVE",
            expectedRevision: workflowRevision,
            answers: nextAnswers,
          },
        },
      );
      if (!result.data) throw new Error("C-SSRS save failed");
      setData(result.data);
      setSaveState("saved");
    });
    saveQueue.current.catch(() => setSaveState("error"));
  }

  function setAnswer(key: AnswerKey, value: boolean) {
    const next = { ...answers, [key]: value };
    if (key === "q2SuicidalThoughts" && !value) {
      delete next.q3Method;
      delete next.q4Intent;
      delete next.q5Plan;
    }
    if (key === "q6Behavior" && !value) delete next.q6WithinThreeMonths;
    setAnswers(next);
    persist(next);
  }

  async function complete() {
    if (workflowRevision === null || calculation.status !== "COMPLETE") return;
    await saveQueue.current.catch(() => undefined);
    setSaveState("saving");
    const result = await apiClient.PUT("/api/v1/patients/{patientId}/research-case/cssrs-recent", {
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
      setData(result.data);
      setSaveState("saved");
    } else setSaveState("error");
  }

  async function bypass() {
    if (workflowRevision === null) return;
    await saveQueue.current.catch(() => undefined);
    setSaveState("saving");
    const result = await apiClient.PUT("/api/v1/patients/{patientId}/research-case/cssrs-recent", {
      params: { path: { patientId } },
      headers: { "x-csrf-token": csrfToken },
      body: { schemaVersion: "1", mode: "BYPASS", expectedRevision: workflowRevision },
    });
    if (result.data) {
      setData(result.data);
      setAnswers({});
      setSaveState("saved");
    } else setSaveState("error");
  }

  if (!data && !loadFailed) return <LoadingState label="Loading C-SSRS assessment" />;
  if (loadFailed || !data) {
    return (
      <ErrorState
        title="C-SSRS assessment unavailable"
        description="Assessment data could not be loaded."
        action={<Button onClick={() => setReload((value) => value + 1)}>Try again</Button>}
      />
    );
  }

  const question = Object.fromEntries(data.definition.questions.map((item) => [item.id, item]));
  const resultBand = calculation.band ? CSSRS_BANDS[calculation.band] : null;

  return (
    <section className="card assessment-card" aria-labelledby="cssrs-title">
      <div className="section-heading">
        <div>
          <p className="kicker">Step 4 of 10</p>
          <h2 id="cssrs-title">{data.definition.title}</h2>
        </div>
        <Badge tone={data.assessment.status === "COMPLETED" ? "normal" : "warning"}>
          {data.assessment.status.replace("_", " ")}
        </Badge>
      </div>
      <Banner title="Research activation inactive" tone="warning">
        Permission, training, governed transcription, and clinical-review evidence are incomplete.
      </Banner>
      <Banner title="Informational screen result" tone="info">
        This local score does not predict suicide, replace clinical evaluation, require
        acknowledgement, or block finalization.
      </Banner>
      {data.assessment.status === "BYPASSED" ? (
        <Banner title="C-SSRS assessment bypassed" tone="warning">
          Bypass discards partial answers and is not a negative result. Selecting an answer resumes
          the assessment.
        </Banner>
      ) : null}

      <form className="assessment-form" onSubmit={(event) => event.preventDefault()}>
        <p className="field-hint">{data.definition.instruction}</p>
        <p className="timeframe-label">Questions 1–5: past month</p>
        <BinaryQuestion
          item={question.Q1}
          value={answers.q1WishDead}
          onChange={(value) => setAnswer("q1WishDead", value)}
        />
        <BinaryQuestion
          item={question.Q2}
          value={answers.q2SuicidalThoughts}
          onChange={(value) => setAnswer("q2SuicidalThoughts", value)}
        />
        {answers.q2SuicidalThoughts === true ? (
          <>
            <BinaryQuestion
              item={question.Q3}
              value={answers.q3Method}
              onChange={(value) => setAnswer("q3Method", value)}
            />
            <BinaryQuestion
              item={question.Q4}
              value={answers.q4Intent}
              onChange={(value) => setAnswer("q4Intent", value)}
            />
            <BinaryQuestion
              item={question.Q5}
              value={answers.q5Plan}
              onChange={(value) => setAnswer("q5Plan", value)}
            />
          </>
        ) : null}
        <p className="timeframe-label">Question 6: lifetime</p>
        <BinaryQuestion
          item={question.Q6}
          value={answers.q6Behavior}
          onChange={(value) => setAnswer("q6Behavior", value)}
        />
        {answers.q6Behavior === true ? (
          <BinaryQuestion
            item={{
              id: data.definition.recencyFollowUp.id,
              number: null,
              text: data.definition.recencyFollowUp.text,
            }}
            value={answers.q6WithinThreeMonths}
            onChange={(value) => setAnswer("q6WithinThreeMonths", value)}
          />
        ) : null}

        <section className="calculation-panel" aria-live="polite" aria-atomic="true">
          <h3>C-SSRS screen result</h3>
          {data.assessment.status === "BYPASSED" ? (
            <p className="calculation-result">Bypassed: no result</p>
          ) : resultBand ? (
            <p className="cssrs-result">
              <span
                className="cssrs-result__marker"
                style={{ backgroundColor: resultBand.color }}
                aria-hidden="true"
              />
              <strong>{resultBand.label}</strong>
            </p>
          ) : (
            <p className="calculation-result">Incomplete</p>
          )}
          <p className="field-hint">
            Local calculation {data.assessment.instrumentPin.calculationVersion}; source SHA-256{" "}
            {data.assessment.instrumentPin.sourceSha256}.
          </p>
        </section>

        {saveState === "error" ? (
          <p className="field-error" role="alert">
            C-SSRS assessment could not be saved. Try again.
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
            Complete C-SSRS screen
          </Button>
          <Button type="button" variant="secondary" onClick={() => void bypass()}>
            Bypass C-SSRS screen
          </Button>
        </div>
      </form>
    </section>
  );
}

function BinaryQuestion({
  item,
  value,
  onChange,
}: {
  item: { id: string; number: number | null; text: string };
  value: boolean | undefined;
  onChange: (value: boolean) => void;
}) {
  return (
    <fieldset className="binary-question">
      <legend>
        {item.number ? `${item.number}. ` : ""}
        {item.text}
      </legend>
      <label>
        <input
          type="radio"
          name={`cssrs-${item.id}`}
          checked={value === true}
          onChange={() => onChange(true)}
        />
        Yes
      </label>
      <label>
        <input
          type="radio"
          name={`cssrs-${item.id}`}
          checked={value === false}
          onChange={() => onChange(false)}
        />
        No
      </label>
    </fieldset>
  );
}
