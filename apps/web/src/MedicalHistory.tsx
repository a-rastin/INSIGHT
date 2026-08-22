import { type FormEvent, useEffect, useMemo, useState } from "react";

import { Badge, Banner, Button, ErrorState, LoadingState } from "./components/primitives";
import { apiClient } from "./generated/api-client";
import type { operations } from "./generated/api-types";

type HistoryInput =
  operations["saveMedicalHistory"]["requestBody"]["content"]["application/json"]["history"];
type HistoryRecord = NonNullable<
  operations["getMedicalHistory"]["responses"][200]["content"]["application/json"]["medicalHistory"]
>;
type TrialInput = NonNullable<HistoryInput["priorTrials"]>[number];
type MedicationInput = HistoryInput["currentMedications"][number];
type ComorbidityInput = HistoryInput["comorbidities"][number];
type AdverseCatalog = NonNullable<
  operations["getActiveAdverseEffectCatalog"]["responses"][200]["content"]["application/json"]["catalog"]
>;
type ComorbidityKnowledge = NonNullable<
  operations["getActiveComorbidityKnowledge"]["responses"][200]["content"]["application/json"]["knowledge"]
>;
type PresentationStatus = HistoryInput["presentationStatus"];
type ResponseValue = NonNullable<TrialInput["response"]>;

type DraftTrial = Omit<TrialInput, "adverseEffects"> & {
  adverseEffects: NonNullable<TrialInput["adverseEffects"]>;
  adverseEffectLabels: Record<string, string>;
};
type DraftComorbidity = ComorbidityInput & { label: string };

const RESPONSES: readonly [ResponseValue, string][] = [
  ["FULL_RESPONSE", "Full"],
  ["PARTIAL_RESPONSE", "Partial"],
  ["NO_RESPONSE", "None"],
  ["WORSENED", "Worsened"],
  ["UNKNOWN", "Unknown"],
];

const emptyTrial = (): DraftTrial => ({
  medication: "",
  adverseEffects: [],
  adverseEffectLabels: {},
});
const emptyMedication = (): MedicationInput => ({ rawMedication: "" });
const pinKey = (catalogVersionId: string, termId: string) => `${catalogVersionId}\0${termId}`;
const optional = (value: string | undefined) => value?.trim() || undefined;

export function MedicalHistory({ patientId, csrfToken }: { patientId: string; csrfToken: string }) {
  const [record, setRecord] = useState<HistoryRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [workflowRevision, setWorkflowRevision] = useState<number | null>(null);
  const [adverseCatalog, setAdverseCatalog] = useState<AdverseCatalog | null>(null);
  const [comorbidityKnowledge, setComorbidityKnowledge] = useState<ComorbidityKnowledge | null>(
    null,
  );
  const [presentationStatus, setPresentationStatus] = useState<PresentationStatus | "">("");
  const [previouslyTreated, setPreviouslyTreated] = useState<boolean | null>(null);
  const [trials, setTrials] = useState<DraftTrial[]>([]);
  const [medications, setMedications] = useState<MedicationInput[]>([]);
  const [comorbidities, setComorbidities] = useState<DraftComorbidity[]>([]);
  const [supplementalNotes, setSupplementalNotes] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [showErrors, setShowErrors] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setLoadFailed(false);
    void Promise.all([
      apiClient.GET("/api/v1/patients/{patientId}/research-case/medical-history", {
        params: { path: { patientId } },
      }),
      apiClient.GET("/api/v1/patients/{patientId}/research-case", {
        params: { path: { patientId } },
      }),
      apiClient.GET("/api/v1/adverse-effect-catalog"),
      apiClient.GET("/api/v1/comorbidity-knowledge"),
    ])
      .then(([historyResult, workflowResult, adverseResult, comorbidityResult]) => {
        if (!active) return;
        if (!historyResult.data || !workflowResult.data) {
          setLoadFailed(true);
          return;
        }
        const history = historyResult.data.medicalHistory;
        setRecord(history);
        setWorkflowRevision(workflowResult.data.researchCase.revision);
        setAdverseCatalog(adverseResult.data?.catalog ?? null);
        setComorbidityKnowledge(comorbidityResult.data?.knowledge ?? null);
        if (history) hydrate(history);
        setLoaded(true);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [patientId, reload]);

  function hydrate(history: HistoryRecord) {
    setPresentationStatus(history.presentationStatus);
    setPreviouslyTreated(history.previouslyTreated ?? null);
    setTrials(
      (history.priorTrials ?? []).map((trial) => ({
        ...trial,
        adverseEffects: (trial.adverseEffects ?? []).map(({ catalogVersionId, termId }) => ({
          catalogVersionId,
          termId,
        })),
        adverseEffectLabels: Object.fromEntries(
          (trial.adverseEffects ?? []).map((effect) => [
            pinKey(effect.catalogVersionId, effect.termId),
            effect.label,
          ]),
        ),
      })),
    );
    setMedications(history.currentMedications.map((medication) => ({ ...medication })));
    setComorbidities(history.comorbidities.map((item) => ({ ...item })));
    setSupplementalNotes(history.supplementalNotes ?? "");
  }

  const errors = useMemo(() => {
    const next: string[] = [];
    if (!presentationStatus) next.push("Select presentation status.");
    if (presentationStatus === "KNOWN_SCHIZOPHRENIA" && previouslyTreated === null)
      next.push("Select whether the patient was previously treated.");
    if (
      presentationStatus === "KNOWN_SCHIZOPHRENIA" &&
      previouslyTreated === true &&
      trials.length === 0
    )
      next.push("Add at least one prior antipsychotic trial.");
    trials.forEach((trial, index) => {
      if (!trial.medication.trim()) next.push(`Trial ${index + 1}: enter medication.`);
      if (trial.treatmentStart && trial.treatmentEnd && trial.treatmentEnd < trial.treatmentStart)
        next.push(`Trial ${index + 1}: treatment end cannot precede treatment start.`);
    });
    medications.forEach((medication, index) => {
      if (!medication.rawMedication.trim())
        next.push(`Current medicine ${index + 1}: enter medication.`);
    });
    return next;
  }, [medications, presentationStatus, previouslyTreated, trials]);

  function choosePresentation(value: PresentationStatus) {
    setPresentationStatus(value);
    setShowErrors(false);
    if (value === "FIRST_PRESENTATION") {
      setPreviouslyTreated(null);
      setTrials([]);
    }
  }

  function chooseTreatment(value: boolean) {
    setPreviouslyTreated(value);
    setShowErrors(false);
    if (!value) setTrials([]);
    else if (trials.length === 0) setTrials([emptyTrial()]);
  }

  function updateTrial(index: number, patch: Partial<DraftTrial>) {
    setTrials((current) =>
      current.map((trial, position) => (position === index ? { ...trial, ...patch } : trial)),
    );
  }

  function updateMedication(index: number, patch: Partial<MedicationInput>) {
    setMedications((current) =>
      current.map((medication, position) =>
        position === index ? { ...medication, ...patch } : medication,
      ),
    );
  }

  function toggleAdverseEffect(
    index: number,
    catalogVersionId: string,
    termId: string,
    label: string,
  ) {
    const trial = trials[index]!;
    const key = pinKey(catalogVersionId, termId);
    const selected = trial.adverseEffects.some(
      (effect) => pinKey(effect.catalogVersionId, effect.termId) === key,
    );
    updateTrial(index, {
      adverseEffects: selected
        ? trial.adverseEffects.filter(
            (effect) => pinKey(effect.catalogVersionId, effect.termId) !== key,
          )
        : [...trial.adverseEffects, { catalogVersionId, termId }],
      adverseEffectLabels: { ...trial.adverseEffectLabels, [key]: label },
    });
  }

  function toggleComorbidity(catalogVersionId: string, termId: string, label: string) {
    const key = pinKey(catalogVersionId, termId);
    const selected = comorbidities.some(
      (item) => pinKey(item.catalogVersionId, item.termId) === key,
    );
    setComorbidities((current) =>
      selected
        ? current.filter((item) => pinKey(item.catalogVersionId, item.termId) !== key)
        : [...current, { catalogVersionId, termId, label }],
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setShowErrors(true);
    if (errors.length || !presentationStatus || workflowRevision === null) return;
    setSaveState("saving");
    const history: HistoryInput = {
      presentationStatus,
      ...(presentationStatus === "KNOWN_SCHIZOPHRENIA"
        ? {
            previouslyTreated: previouslyTreated!,
            ...(previouslyTreated ? { priorTrials: trials.map(materializeTrial) } : {}),
          }
        : {}),
      currentMedications: medications.map(materializeMedication),
      comorbidities: comorbidities.map(({ catalogVersionId, termId, supplementalText }) => ({
        catalogVersionId,
        termId,
        ...(optional(supplementalText) ? { supplementalText: optional(supplementalText) } : {}),
      })),
      ...(optional(supplementalNotes) ? { supplementalNotes: optional(supplementalNotes) } : {}),
    };
    try {
      const result = await apiClient.PUT(
        "/api/v1/patients/{patientId}/research-case/medical-history",
        {
          params: { path: { patientId } },
          headers: { "x-csrf-token": csrfToken },
          body: { schemaVersion: "1", expectedRevision: workflowRevision, history },
        },
      );
      if (!result.data) throw new Error("Medical history save failed");
      setRecord(result.data.medicalHistory);
      setWorkflowRevision((revision) => (revision === null ? null : revision + 1));
      hydrate(result.data.medicalHistory!);
      setSaveState("saved");
      setShowErrors(false);
    } catch {
      setSaveState("error");
    }
  }

  if (!loaded && !loadFailed) return <LoadingState label="Loading medical history" />;
  if (loadFailed) {
    return (
      <ErrorState
        title="Medical history unavailable"
        description="Persisted medical-history data could not be loaded."
        action={<Button onClick={() => setReload((value) => value + 1)}>Try again</Button>}
      />
    );
  }

  const selectedComorbidityVersions = new Set(comorbidities.map((item) => item.catalogVersionId));
  const staleComorbiditySelected =
    selectedComorbidityVersions.size > 0 &&
    (!comorbidityKnowledge || !selectedComorbidityVersions.has(comorbidityKnowledge.id));

  return (
    <section className="card medical-history" aria-labelledby="medical-history-title">
      <div className="section-heading">
        <div>
          <p className="kicker">Step 5 of 10</p>
          <h2 id="medical-history-title">Medical history</h2>
        </div>
        <Badge tone={record ? "normal" : "warning"}>{record ? "Saved" : "Not started"}</Badge>
      </div>
      <Banner title="Clinician-entered history" tone="info">
        Record available history. Optional fields may remain blank; cautions below are deterministic
        catalog results, not clinical orders.
      </Banner>

      <form className="medical-history__form" onSubmit={submit} noValidate>
        {showErrors && errors.length ? (
          <section
            className="validation-summary"
            role="alert"
            aria-labelledby="history-errors-title"
          >
            <h3 id="history-errors-title">Resolve before saving</h3>
            <ul>
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <fieldset className="authority-fieldset">
          <legend>Presentation status (required)</legend>
          <label>
            <input
              type="radio"
              name="presentation-status"
              checked={presentationStatus === "FIRST_PRESENTATION"}
              onChange={() => choosePresentation("FIRST_PRESENTATION")}
            />
            First presentation
          </label>
          <label>
            <input
              type="radio"
              name="presentation-status"
              checked={presentationStatus === "KNOWN_SCHIZOPHRENIA"}
              onChange={() => choosePresentation("KNOWN_SCHIZOPHRENIA")}
            />
            Known schizophrenia
          </label>
        </fieldset>

        {presentationStatus === "KNOWN_SCHIZOPHRENIA" ? (
          <fieldset className="authority-fieldset">
            <legend>Previously treated with an antipsychotic? (required)</legend>
            <label>
              <input
                type="radio"
                name="previously-treated"
                checked={previouslyTreated === true}
                onChange={() => chooseTreatment(true)}
              />
              Yes
            </label>
            <label>
              <input
                type="radio"
                name="previously-treated"
                checked={previouslyTreated === false}
                onChange={() => chooseTreatment(false)}
              />
              No
            </label>
          </fieldset>
        ) : null}

        {presentationStatus === "KNOWN_SCHIZOPHRENIA" && previouslyTreated === true ? (
          <section className="history-section" aria-labelledby="prior-trials-title">
            <div className="section-heading">
              <div>
                <h3 id="prior-trials-title">Prior antipsychotic trials</h3>
                <p className="field-hint">Only medication is required for each trial.</p>
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setTrials((current) => [...current, emptyTrial()])}
              >
                Add trial
              </Button>
            </div>
            <div className="history-list">
              {trials.map((trial, index) => (
                <TrialEditor
                  key={index}
                  index={index}
                  trial={trial}
                  adverseCatalog={adverseCatalog}
                  onChange={(patch) => updateTrial(index, patch)}
                  onToggleEffect={(versionId, termId, label) =>
                    toggleAdverseEffect(index, versionId, termId, label)
                  }
                  onRemove={() =>
                    setTrials((current) => current.filter((_, position) => position !== index))
                  }
                />
              ))}
            </div>
          </section>
        ) : null}

        <RepeatingMedicationSection
          medications={medications}
          onAdd={() => setMedications((current) => [...current, emptyMedication()])}
          onChange={updateMedication}
          onRemove={(index) =>
            setMedications((current) => current.filter((_, position) => position !== index))
          }
        />

        <section className="history-section" aria-labelledby="comorbidities-title">
          <h3 id="comorbidities-title">Comorbidities</h3>
          <p className="field-hint">Select all known comorbidities. Selection is optional.</p>
          {staleComorbiditySelected ? (
            <Banner title="Earlier catalog selection" tone="warning">
              Saved labels remain readable and removable. Remove earlier-version selections before
              choosing terms from active version {comorbidityKnowledge?.version ?? "unavailable"}.
            </Banner>
          ) : null}
          <div className="choice-grid">
            {mergeComorbidityOptions(comorbidities, comorbidityKnowledge).map((term) => {
              const checked = comorbidities.some(
                (item) =>
                  pinKey(item.catalogVersionId, item.termId) ===
                  pinKey(term.catalogVersionId, term.termId),
              );
              const isActive = term.catalogVersionId === comorbidityKnowledge?.id;
              return (
                <label key={pinKey(term.catalogVersionId, term.termId)}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && staleComorbiditySelected && isActive}
                    onChange={() =>
                      toggleComorbidity(term.catalogVersionId, term.termId, term.label)
                    }
                  />
                  <span>
                    {term.label}
                    {isActive ? "" : " (saved earlier version)"}
                  </span>
                </label>
              );
            })}
          </div>
          {!comorbidityKnowledge && comorbidities.length === 0 ? (
            <p className="field-hint">No active comorbidity catalog is available.</p>
          ) : null}
        </section>

        <section className="history-section" aria-labelledby="notes-title">
          <label className="field-label" htmlFor="medical-history-notes" id="notes-title">
            Supplemental notes (optional)
          </label>
          <textarea
            id="medical-history-notes"
            className="text-input history-textarea"
            maxLength={10000}
            value={supplementalNotes}
            onChange={(event) => setSupplementalNotes(event.target.value)}
          />
        </section>

        <section className="validation-panel" aria-live="polite">
          <h3>Validation summary</h3>
          <p>
            {errors.length === 0
              ? "Ready to save."
              : `${errors.length} required item${errors.length === 1 ? "" : "s"} incomplete.`}
          </p>
          <p className="field-hint">
            Optional detail, including OTHER adverse-effect detail, may remain blank.
          </p>
        </section>

        {record?.ruleEvaluation ? <CautionSummary record={record} /> : null}
        {saveState === "error" ? (
          <p className="field-error" role="alert">
            Medical history could not be saved. Reload and try again if another edit changed this
            Research Case.
          </p>
        ) : null}
        <div className="form-actions">
          <Button type="submit" loading={saveState === "saving"}>
            Save medical history
          </Button>
          <p className="save-status" role="status" aria-live="polite">
            {saveState === "saved" ? "Medical history saved." : ""}
          </p>
        </div>
      </form>
    </section>
  );
}

function TrialEditor({
  index,
  trial,
  adverseCatalog,
  onChange,
  onToggleEffect,
  onRemove,
}: {
  index: number;
  trial: DraftTrial;
  adverseCatalog: AdverseCatalog | null;
  onChange: (patch: Partial<DraftTrial>) => void;
  onToggleEffect: (versionId: string, termId: string, label: string) => void;
  onRemove: () => void;
}) {
  const options = mergeAdverseOptions(trial, adverseCatalog);
  const otherSelected = trial.adverseEffects.some((effect) => effect.termId === "OTHER");
  return (
    <fieldset className="history-entry">
      <legend>Trial {index + 1}</legend>
      <div className="history-grid">
        <label className="history-field">
          Medication (required)
          <input
            className="text-input"
            required
            value={trial.medication}
            onChange={(event) => onChange({ medication: event.target.value })}
          />
        </label>
        <label className="history-field">
          Dose (optional)
          <input
            className="text-input"
            value={trial.dose ?? ""}
            onChange={(event) => onChange({ dose: event.target.value })}
          />
        </label>
        <label className="history-field">
          Dose unit (optional)
          <input
            className="text-input"
            value={trial.doseUnit ?? ""}
            onChange={(event) => onChange({ doseUnit: event.target.value })}
          />
        </label>
        <label className="history-field">
          Treatment start (optional)
          <input
            className="text-input"
            type="date"
            value={trial.treatmentStart ?? ""}
            onChange={(event) => onChange({ treatmentStart: event.target.value })}
          />
        </label>
        <label className="history-field">
          Treatment end (optional)
          <input
            className="text-input"
            type="date"
            value={trial.treatmentEnd ?? ""}
            onChange={(event) => onChange({ treatmentEnd: event.target.value })}
          />
        </label>
        <label className="history-field">
          Approximate period (optional)
          <input
            className="text-input"
            value={trial.approximatePeriod ?? ""}
            onChange={(event) => onChange({ approximatePeriod: event.target.value })}
          />
        </label>
        <label className="history-field">
          Response (optional)
          <select
            className="text-input"
            value={trial.response ?? ""}
            onChange={(event) =>
              onChange({ response: (event.target.value || undefined) as ResponseValue | undefined })
            }
          >
            <option value="">Not recorded</option>
            {RESPONSES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="history-field">
          Discontinuation reason (optional)
          <input
            className="text-input"
            value={trial.discontinuationReason ?? ""}
            onChange={(event) => onChange({ discontinuationReason: event.target.value })}
          />
        </label>
      </div>
      <fieldset className="choice-fieldset">
        <legend>Adverse effects (optional)</legend>
        <div className="choice-grid">
          {options.map((effect) => {
            const checked = trial.adverseEffects.some(
              (item) =>
                pinKey(item.catalogVersionId, item.termId) ===
                pinKey(effect.catalogVersionId, effect.termId),
            );
            return (
              <label key={pinKey(effect.catalogVersionId, effect.termId)}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    onToggleEffect(effect.catalogVersionId, effect.termId, effect.label)
                  }
                />
                <span>
                  {effect.label}
                  {effect.catalogVersionId === adverseCatalog?.id ? "" : " (saved earlier version)"}
                </span>
              </label>
            );
          })}
        </div>
        {!adverseCatalog && options.length === 0 ? (
          <p className="field-hint">No active adverse-effect catalog is available.</p>
        ) : null}
      </fieldset>
      {otherSelected ? (
        <label className="history-field">
          OTHER detail (optional)
          <input
            className="text-input"
            value={trial.otherAdverseEffectDetail ?? ""}
            onChange={(event) => onChange({ otherAdverseEffectDetail: event.target.value })}
          />
        </label>
      ) : null}
      <label className="history-field">
        Trial notes (optional)
        <textarea
          className="text-input history-textarea"
          value={trial.notes ?? ""}
          onChange={(event) => onChange({ notes: event.target.value })}
        />
      </label>
      <Button type="button" variant="danger" onClick={onRemove}>
        Remove trial {index + 1}
      </Button>
    </fieldset>
  );
}

function RepeatingMedicationSection({
  medications,
  onAdd,
  onChange,
  onRemove,
}: {
  medications: MedicationInput[];
  onAdd: () => void;
  onChange: (index: number, patch: Partial<MedicationInput>) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <section className="history-section" aria-labelledby="current-medicines-title">
      <div className="section-heading">
        <div>
          <h3 id="current-medicines-title">Current medicines</h3>
          <p className="field-hint">Add medicines currently taken. Section is optional.</p>
        </div>
        <Button type="button" variant="secondary" onClick={onAdd}>
          Add current medicine
        </Button>
      </div>
      <div className="history-list">
        {medications.map((medication, index) => (
          <fieldset className="history-entry" key={index}>
            <legend>Current medicine {index + 1}</legend>
            <div className="history-grid">
              <label className="history-field">
                Medication (required)
                <input
                  className="text-input"
                  required
                  value={medication.rawMedication}
                  onChange={(event) => onChange(index, { rawMedication: event.target.value })}
                />
              </label>
              <label className="history-field">
                Dose (optional)
                <input
                  className="text-input"
                  value={medication.dose ?? ""}
                  onChange={(event) => onChange(index, { dose: event.target.value })}
                />
              </label>
              <label className="history-field">
                Dose unit (optional)
                <input
                  className="text-input"
                  value={medication.doseUnit ?? ""}
                  onChange={(event) => onChange(index, { doseUnit: event.target.value })}
                />
              </label>
              <label className="history-field">
                Route (optional)
                <input
                  className="text-input"
                  value={medication.route ?? ""}
                  onChange={(event) => onChange(index, { route: event.target.value })}
                />
              </label>
              <label className="history-field">
                Frequency (optional)
                <input
                  className="text-input"
                  value={medication.frequency ?? ""}
                  onChange={(event) => onChange(index, { frequency: event.target.value })}
                />
              </label>
            </div>
            <Button type="button" variant="danger" onClick={() => onRemove(index)}>
              Remove current medicine {index + 1}
            </Button>
          </fieldset>
        ))}
      </div>
    </section>
  );
}

function CautionSummary({ record }: { record: HistoryRecord }) {
  const evaluation = record.ruleEvaluation!;
  return (
    <section className="caution-summary" aria-labelledby="cautions-title">
      <h3 id="cautions-title">Deterministic cautions and routing facts</h3>
      {evaluation.results.length === 0 ? (
        <p>No catalog rules matched selected comorbidities.</p>
      ) : (
        <ul>
          {evaluation.results.map((result) => (
            <li key={`${result.ruleId}-${result.kind}-${result.targetId}`}>
              <Badge
                tone={
                  result.kind === "CONTRAINDICATION"
                    ? "urgent"
                    : result.kind === "CAUTION"
                      ? "warning"
                      : "info"
                }
              >
                {result.kind.replaceAll("_", " ")}
              </Badge>
              <strong>
                {result.targetId}: {result.value}
              </strong>
              <p>{result.explanation}</p>
              <small>
                Provenance: knowledge version {result.knowledgeVersion}; rule {result.ruleId};
                matched terms {result.matchedTermIds.join(", ")}.
              </small>
            </li>
          ))}
        </ul>
      )}
      <p className="field-hint">
        Evaluation ID {evaluation.knowledgeVersionId}; results are deterministic outputs from the
        pinned governed knowledge version.
      </p>
    </section>
  );
}

function materializeTrial(trial: DraftTrial): TrialInput {
  return {
    medication: trial.medication.trim(),
    ...(trial.normalizationState ? { normalizationState: trial.normalizationState } : {}),
    ...(optional(trial.canonicalMedicationId)
      ? { canonicalMedicationId: optional(trial.canonicalMedicationId) }
      : {}),
    ...(optional(trial.dose) ? { dose: optional(trial.dose) } : {}),
    ...(optional(trial.doseUnit) ? { doseUnit: optional(trial.doseUnit) } : {}),
    ...(optional(trial.treatmentStart) ? { treatmentStart: optional(trial.treatmentStart) } : {}),
    ...(optional(trial.treatmentEnd) ? { treatmentEnd: optional(trial.treatmentEnd) } : {}),
    ...(optional(trial.approximatePeriod)
      ? { approximatePeriod: optional(trial.approximatePeriod) }
      : {}),
    ...(trial.response ? { response: trial.response } : {}),
    ...(trial.adverseEffects.length ? { adverseEffects: trial.adverseEffects } : {}),
    ...(trial.otherAdverseEffectDetail !== undefined
      ? { otherAdverseEffectDetail: trial.otherAdverseEffectDetail.trim() }
      : {}),
    ...(optional(trial.discontinuationReason)
      ? { discontinuationReason: optional(trial.discontinuationReason) }
      : {}),
    ...(optional(trial.notes) ? { notes: optional(trial.notes) } : {}),
  };
}

function materializeMedication(medication: MedicationInput): MedicationInput {
  return {
    rawMedication: medication.rawMedication.trim(),
    ...(medication.normalizationState ? { normalizationState: medication.normalizationState } : {}),
    ...(optional(medication.canonicalMedicationId)
      ? { canonicalMedicationId: optional(medication.canonicalMedicationId) }
      : {}),
    ...(optional(medication.dose) ? { dose: optional(medication.dose) } : {}),
    ...(optional(medication.doseUnit) ? { doseUnit: optional(medication.doseUnit) } : {}),
    ...(optional(medication.route) ? { route: optional(medication.route) } : {}),
    ...(optional(medication.frequency) ? { frequency: optional(medication.frequency) } : {}),
  };
}

function mergeAdverseOptions(trial: DraftTrial, catalog: AdverseCatalog | null) {
  const options = (catalog?.terms ?? []).map((term) => ({
    ...term,
    catalogVersionId: catalog!.id,
  }));
  for (const effect of trial.adverseEffects) {
    if (
      !options.some(
        (item) =>
          pinKey(item.catalogVersionId, item.termId) ===
          pinKey(effect.catalogVersionId, effect.termId),
      )
    )
      options.push({
        ...effect,
        label:
          trial.adverseEffectLabels[pinKey(effect.catalogVersionId, effect.termId)] ??
          effect.termId,
      });
  }
  return options;
}

function mergeComorbidityOptions(
  selected: DraftComorbidity[],
  knowledge: ComorbidityKnowledge | null,
) {
  const options = (knowledge?.terms ?? []).map((term) => ({
    ...term,
    catalogVersionId: knowledge!.id,
  }));
  for (const item of selected)
    if (
      !options.some(
        (term) =>
          pinKey(term.catalogVersionId, term.termId) === pinKey(item.catalogVersionId, item.termId),
      )
    )
      options.push({
        catalogVersionId: item.catalogVersionId,
        termId: item.termId,
        label: item.label,
      });
  return options;
}
