import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MedicalHistory } from "./MedicalHistory";

const patientId = "20000000-0000-4000-8000-000000000001";
const staleVersionId = "40000000-0000-4000-8000-000000000001";
const activeAdverseId = "40000000-0000-4000-8000-000000000002";
const activeKnowledgeId = "50000000-0000-4000-8000-000000000002";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    presentationStatus: "FIRST_PRESENTATION",
    currentMedications: [],
    comorbidities: [],
    ruleEvaluation: null,
    researchCaseId: "30000000-0000-4000-8000-000000000001",
    revision: 1,
    createdByUserId: "10000000-0000-4000-8000-000000000002",
    updatedByUserId: "10000000-0000-4000-8000-000000000002",
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

function installApi(history: ReturnType<typeof record> | null, onSave = vi.fn()) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/medical-history")) {
        if (request.method === "PUT") {
          const body = await request.clone().json();
          onSave(body);
          return json({ schemaVersion: "1", medicalHistory: record(body.history) });
        }
        return json({ schemaVersion: "1", medicalHistory: history });
      }
      if (path.endsWith("/research-case")) {
        return json({ schemaVersion: "1", researchCase: { revision: 7 } });
      }
      if (path.endsWith("/adverse-effect-catalog")) {
        return json({
          schemaVersion: "1",
          catalog: {
            id: activeAdverseId,
            version: 2,
            terms: [
              { termId: "AKATHISIA", label: "Akathisia" },
              { termId: "OTHER", label: "Other" },
            ],
            createdByUserId: "10000000-0000-4000-8000-000000000001",
            createdAt: "2026-08-22T10:00:00.000Z",
            active: true,
          },
        });
      }
      if (path.endsWith("/comorbidity-knowledge")) {
        return json({
          schemaVersion: "1",
          knowledge: {
            id: activeKnowledgeId,
            version: 2,
            sourceReference: "Governed source",
            reviewerRecord: {
              reviewerId: "reviewer",
              reviewedAt: "2026-08-22T10:00:00.000Z",
              recordReference: "review-2",
            },
            terms: [{ termId: "DIABETES", label: "Diabetes" }],
            rules: [],
            createdByUserId: "10000000-0000-4000-8000-000000000001",
            createdAt: "2026-08-22T10:00:00.000Z",
            active: true,
          },
        });
      }
      return json({}, 404);
    }),
  );
}

beforeEach(() => vi.restoreAllMocks());

describe("MedicalHistory", () => {
  it("matches presentation branches and saves a medication-only prior trial", async () => {
    const onSave = vi.fn();
    installApi(null, onSave);
    render(<MedicalHistory patientId={patientId} csrfToken="csrf" />);

    expect(await screen.findByRole("heading", { name: "Medical history" })).toBeTruthy();
    expect(screen.queryByText("Prior antipsychotic trials")).toBeNull();
    fireEvent.click(screen.getByLabelText("Known schizophrenia"));
    expect(screen.getByRole("group", { name: /Previously treated/ })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Yes"));
    expect(screen.getByText("Only medication is required for each trial.")).toBeTruthy();

    const response = screen.getByLabelText("Response (optional)");
    expect([...response.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "Not recorded",
      "Full",
      "Partial",
      "None",
      "Worsened",
      "Unknown",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Save medical history" }));
    expect(screen.getByRole("heading", { name: "Resolve before saving" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Medication (required)"), {
      target: { value: "Clozapine" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save medical history" }));

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({
      expectedRevision: 7,
      history: {
        presentationStatus: "KNOWN_SCHIZOPHRENIA",
        previouslyTreated: true,
        priorTrials: [{ medication: "Clozapine" }],
        currentMedications: [],
        comorbidities: [],
      },
    });
  });

  it("restores known-untreated choices accessibly and keeps conditional trials absent", async () => {
    installApi(
      record({
        presentationStatus: "KNOWN_SCHIZOPHRENIA",
        previouslyTreated: false,
        priorTrials: [],
      }),
    );
    const { container } = render(<MedicalHistory patientId={patientId} csrfToken="csrf" />);

    expect(await screen.findByLabelText("Known schizophrenia")).toHaveProperty("checked", true);
    expect(screen.getByLabelText("No")).toHaveProperty("checked", true);
    expect(screen.queryByText("Prior antipsychotic trials")).toBeNull();
    expect(screen.getByText("Ready to save.")).toBeTruthy();
    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("renders stale pinned labels, optional OTHER detail, and sourced deterministic cautions", async () => {
    installApi(
      record({
        presentationStatus: "KNOWN_SCHIZOPHRENIA",
        previouslyTreated: true,
        priorTrials: [
          {
            medication: "Haloperidol",
            response: "PARTIAL_RESPONSE",
            adverseEffects: [
              {
                catalogVersionId: staleVersionId,
                termId: "OTHER",
                label: "Other historical effect",
              },
            ],
            otherAdverseEffectDetail: "",
          },
        ],
        comorbidities: [
          {
            catalogVersionId: staleVersionId,
            termId: "CARDIAC",
            label: "Historical cardiac condition",
          },
        ],
        ruleEvaluation: {
          knowledgeVersionId: staleVersionId,
          knowledgeVersion: 1,
          results: [
            {
              knowledgeVersionId: staleVersionId,
              knowledgeVersion: 1,
              ruleId: "CARDIAC_CAUTION",
              kind: "CAUTION",
              targetId: "QT_RISK",
              value: "Review",
              explanation: "Review QT-prolongation risk.",
              matchedTermIds: ["CARDIAC"],
            },
          ],
        },
      }),
    );
    render(<MedicalHistory patientId={patientId} csrfToken="csrf" />);

    expect(await screen.findByText("Other historical effect (saved earlier version)")).toBeTruthy();
    expect((screen.getByLabelText("OTHER detail (optional)") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Historical cardiac condition (saved earlier version)")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Earlier catalog selection" })).toBeTruthy();
    expect(screen.getByText("CAUTION")).toBeTruthy();
    expect(screen.getByText("Review QT-prolongation risk.")).toBeTruthy();
    expect(
      screen.getByText(/knowledge version 1; rule CARDIAC_CAUTION; matched terms CARDIAC/),
    ).toBeTruthy();
  });
});
