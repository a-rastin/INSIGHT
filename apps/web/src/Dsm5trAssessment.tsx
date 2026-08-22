import { useEffect, useMemo, useRef, useState } from "react";

import { calculateDsm5tr, type Dsm5trAnswers } from "@insight/contracts";

import { Badge, Banner, Button, ErrorState, LoadingState } from "./components/primitives";
import { apiClient } from "./generated/api-client";
import type { operations } from "./generated/api-types";

type AssessmentResponse =
  operations["getDsm5trAssessment"]["responses"][200]["content"]["application/json"];
type Decision = NonNullable<AssessmentResponse["assessment"]["psychiatristDecision"]>;
type SaveState = "idle" | "saving" | "saved" | "error";

const EMPTY_ANSWERS: Dsm5trAnswers = { criterionA: {} };

export function Dsm5trAssessment({
  patientId,
  csrfToken,
}: {
  patientId: string;
  csrfToken: string;
}) {
  const [data, setData] = useState<AssessmentResponse | null>(null);
  const [workflowRevision, setWorkflowRevision] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Dsm5trAnswers>(EMPTY_ANSWERS);
  const [decision, setDecision] = useState<Decision>("UNDECIDED");
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
      apiClient.GET("/api/v1/patients/{patientId}/research-case/dsm5tr", {
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
        setAnswers(assessmentResult.data.assessment.answers ?? EMPTY_ANSWERS);
        setDecision(assessmentResult.data.assessment.psychiatristDecision ?? "UNDECIDED");
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [patientId, reload]);

  const calculation = useMemo(() => calculateDsm5tr(answers), [answers]);

  function persist(nextAnswers: Dsm5trAnswers, nextDecision: Decision) {
    if (workflowRevision === null) return;
    setSaveState("saving");
    saveQueue.current = saveQueue.current.then(async () => {
      const result = await apiClient.PUT("/api/v1/patients/{patientId}/research-case/dsm5tr", {
        params: { path: { patientId } },
        headers: { "x-csrf-token": csrfToken },
        body: {
          schemaVersion: "1",
          mode: "SAVE",
          expectedRevision: workflowRevision,
          answers: nextAnswers,
          psychiatristDecision: nextDecision,
        },
      });
      if (!result.data) throw new Error("Assessment save failed");
      setData(result.data);
      setSaveState("saved");
    });
    saveQueue.current.catch(() => setSaveState("error"));
  }

  function setAnswer(path: string, value: boolean) {
    const next = structuredClone(answers);
    if (path.startsWith("criterionA.")) {
      const key = path.slice("criterionA.".length) as keyof Dsm5trAnswers["criterionA"];
      next.criterionA[key] = value;
    } else {
      (next as Record<string, unknown>)[path] = value;
      if (path === "criterionFDevelopmentalHistory" && value === false) {
        delete next.criterionFProminentDelusionsOrHallucinations;
      }
    }
    setAnswers(next);
    persist(next, decision);
  }

  function setPsychiatristDecision(value: Decision) {
    setDecision(value);
    persist(answers, value);
  }

  async function complete() {
    if (workflowRevision === null) return;
    await saveQueue.current.catch(() => undefined);
    setSaveState("saving");
    const result = await apiClient.PUT("/api/v1/patients/{patientId}/research-case/dsm5tr", {
      params: { path: { patientId } },
      headers: { "x-csrf-token": csrfToken },
      body: {
        schemaVersion: "1",
        mode: "COMPLETE",
        expectedRevision: workflowRevision,
        answers,
        psychiatristDecision: decision,
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
    const result = await apiClient.PUT("/api/v1/patients/{patientId}/research-case/dsm5tr", {
      params: { path: { patientId } },
      headers: { "x-csrf-token": csrfToken },
      body: { schemaVersion: "1", mode: "BYPASS", expectedRevision: workflowRevision },
    });
    if (result.data) {
      setData(result.data);
      setAnswers(EMPTY_ANSWERS);
      setDecision("UNDECIDED");
      setSaveState("saved");
    } else setSaveState("error");
  }

  if (!data && !loadFailed) return <LoadingState label="Loading DSM-5-TR assessment" />;
  if (loadFailed || !data) {
    return (
      <ErrorState
        title="DSM-5-TR assessment unavailable"
        description="Assessment data could not be loaded."
        action={<Button onClick={() => setReload((value) => value + 1)}>Try again</Button>}
      />
    );
  }

  return (
    <section className="card assessment-card" aria-labelledby="dsm5tr-title">
      <div className="section-heading">
        <div>
          <p className="kicker">Step 2 of 10</p>
          <h2 id="dsm5tr-title">{data.definition.title}</h2>
        </div>
        <Badge tone={data.assessment.status === "COMPLETED" ? "normal" : "warning"}>
          {data.assessment.status.replace("_", " ")}
        </Badge>
      </div>
      <Banner title="Clinical authority remains with the Psychiatrist" tone="info">
        Calculated criteria status is decision support, not a diagnosis. Your recorded decision is
        stored independently and is never replaced by the calculation.
      </Banner>
      {data.assessment.status === "BYPASSED" ? (
        <Banner title="Assessment bypassed" tone="warning">
          Bypass is missing evidence, not a negative result. Selecting any answer resumes the
          assessment.
        </Banner>
      ) : null}

      <form className="assessment-form" onSubmit={(event) => event.preventDefault()}>
        {data.definition.sections.map((section) => (
          <section className="criterion-section" key={section.criterion}>
            <h3>
              Criterion {section.criterion}: {section.title}
            </h3>
            <p className="field-hint">{section.instruction}</p>
            {section.questions.map((question) => {
              if (
                question.dependsOn &&
                getAnswer(answers, question.dependsOn.answerPath) !== question.dependsOn.value
              ) {
                return null;
              }
              const value = getAnswer(answers, question.answerPath);
              return (
                <fieldset className="binary-question" key={question.id}>
                  <legend>{question.label}</legend>
                  <label>
                    <input
                      type="radio"
                      name={question.id}
                      checked={value === true}
                      onChange={() => setAnswer(question.answerPath, true)}
                    />
                    Yes
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={question.id}
                      checked={value === false}
                      onChange={() => setAnswer(question.answerPath, false)}
                    />
                    No
                  </label>
                </fieldset>
              );
            })}
          </section>
        ))}

        <section className="calculation-panel" aria-live="polite">
          <h3>Calculated criteria status</h3>
          <p className="calculation-result">{displayDisposition(calculation.disposition)}</p>
          <p className="field-hint">
            Calculation version {data.assessment.instrumentPin.calculationVersion}; instrument pin{" "}
            {data.assessment.instrumentPin.instrumentVersion}.
          </p>
        </section>

        <fieldset className="authority-fieldset">
          <legend>Psychiatrist decision</legend>
          <p className="field-hint">This authority field is independent from calculated status.</p>
          {[
            ["UNDECIDED", "Not yet decided"],
            ["SCHIZOPHRENIA_CONFIRMED", "Schizophrenia confirmed"],
            ["SCHIZOPHRENIA_NOT_CONFIRMED", "Schizophrenia not confirmed"],
          ].map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="psychiatrist-decision"
                value={value}
                checked={decision === value}
                onChange={() => setPsychiatristDecision(value as Decision)}
              />
              {label}
            </label>
          ))}
        </fieldset>

        {saveState === "error" ? (
          <p className="field-error" role="alert">
            Assessment could not be saved. Try again.
          </p>
        ) : null}
        <p className="save-status" role="status">
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}
        </p>
        <div className="form-actions">
          <Button
            type="button"
            onClick={() => void complete()}
            disabled={calculation.disposition === "INCOMPLETE" || decision === "UNDECIDED"}
          >
            Complete assessment
          </Button>
          <Button type="button" variant="secondary" onClick={() => void bypass()}>
            Bypass assessment
          </Button>
        </div>
      </form>
    </section>
  );
}

function getAnswer(answers: Dsm5trAnswers, path: string): boolean | undefined {
  if (path.startsWith("criterionA.")) {
    return answers.criterionA[
      path.slice("criterionA.".length) as keyof Dsm5trAnswers["criterionA"]
    ];
  }
  return (answers as Record<string, unknown>)[path] as boolean | undefined;
}

function displayDisposition(disposition: string): string {
  if (disposition === "CRITERIA_MET") return "Criteria met";
  if (disposition === "CRITERIA_NOT_MET") return "Criteria not met";
  return "Incomplete";
}
