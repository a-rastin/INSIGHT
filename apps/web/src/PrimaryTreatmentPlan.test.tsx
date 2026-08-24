import axe from "axe-core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  PrimaryTreatmentPlanView,
  type PrimaryPlanResponse,
  type PrimaryPlanStatus,
} from "./PrimaryTreatmentPlan";

const draft: NonNullable<PrimaryPlanResponse["draft"]> = {
  draftRef: "primary-plan-draft-safe",
  draftRevision: 2,
  aiImputationNoticeVisible: false,
  regimen: [
    {
      canonicalMedicationId: "rx-synthetic-a",
      dose: { value: 2, unit: "mg" },
      route: "oral",
      frequency: "once daily",
      titration: "Reassess before any change.",
      monitoring: ["Review tolerability."],
      rationale: [
        {
          kind: "BN_INFERENCE",
          sourceRef: "bn-inference-safe",
          text: "Accepted pathway output supports this draft item.",
        },
      ],
      warningRefs: ["ddi-record-safe-L10"],
    },
  ],
  generalMonitoring: ["Review response at follow-up."],
  explanation: "Structured research draft assembled from accepted records.",
  baseline: { draftRef: "primary-plan-draft-safe", revision: 1, changedFields: [] },
  provenance: {
    schemaVersion: "1.0.0",
    modelExecutionRef: "model-execution-safe",
    primaryDdiExecutionRef: "ddi-execution-safe",
    generatedAt: "2026-08-24T12:00:00.000Z",
  },
  authorizedSources: [
    {
      sourceRef: "bn-inference-safe",
      label: "Pharmacotherapy pathway result",
      category: "BN_INFERENCE",
      summary: "Accepted patient-specific pathway output.",
    },
    {
      sourceRef: "ddi-record-safe-L10",
      label: "Interaction finding, evidence line 10",
      category: "DDI_FINDING",
      summary: "Warning-only finding from active governed source content.",
    },
  ],
};

function result(
  status: PrimaryPlanStatus,
  overrides: Partial<PrimaryPlanResponse> = {},
): PrimaryPlanResponse {
  return {
    schemaVersion: "1",
    status,
    progress: null,
    failure: null,
    draft: ["SUCCEEDED", "STALE"].includes(status) ? draft : null,
    ...overrides,
  };
}

describe("Primary Treatment Plan review", () => {
  it("renders complete draft fields, baseline, source links, warnings, and provenance", () => {
    render(<PrimaryTreatmentPlanView result={result("SUCCEEDED")} />);

    expect(screen.getByRole("heading", { name: "Ready for psychiatrist review" })).toBeTruthy();
    expect(screen.getByText("rx-synthetic-a")).toBeTruthy();
    expect(screen.getByText("2 mg")).toBeTruthy();
    expect(screen.getByText("Reassess before any change.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Psychiatrist changes" })).toBeTruthy();
    expect(screen.getByText(/No psychiatrist changes/)).toBeTruthy();
    const rationaleLink = screen.getByRole("link", { name: "Pharmacotherapy pathway result" });
    expect(rationaleLink.getAttribute("href")).toBe("#primary-plan-source-0");
    expect(document.querySelector("#primary-plan-source-0")).toBeTruthy();
    expect(screen.getByText("Model execution: model-execution-safe")).toBeTruthy();
    expect(screen.getByText(/Psychiatrist must review every field/)).toBeTruthy();
    expect(document.body.textContent?.toLocaleLowerCase("en-US")).not.toMatch(
      /prescri(?:be|ption)|clinical order/,
    );
    expect(screen.queryByText(/unknown medication|interaction coverage is incomplete/i)).toBeNull();
  });

  it("shows one generic imputation notice and no synthesized details", () => {
    render(
      <PrimaryTreatmentPlanView
        result={result("SUCCEEDED", {
          draft: { ...draft, aiImputationNoticeVisible: true },
        })}
      />,
    );
    expect(screen.getAllByText(/AI imputation was used/)).toHaveLength(1);
    expect(screen.queryByText(/synthetic answer: yes|imputed score: 99|high risk/i)).toBeNull();
  });

  it("never presents unresolved rationale sources as ready", () => {
    render(
      <PrimaryTreatmentPlanView
        result={result("SUCCEEDED", { draft: { ...draft, authorizedSources: [] } })}
      />,
    );
    expect(screen.getByRole("heading", { name: "Primary plan validation failed" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Ready for psychiatrist review" })).toBeNull();
  });

  it.each([
    ["EMPTY", "No Primary Treatment Plan draft"],
    ["VALIDATION_ERROR", "Primary plan validation failed"],
    ["DEPENDENCY_UNAVAILABLE", "Primary plan dependency unavailable"],
    ["FAILED", "Primary plan generation failed"],
  ] as const)("renders %s state", (status, heading) => {
    render(
      <PrimaryTreatmentPlanView
        result={result(status, { failure: { code: status, message: "Safe state detail." } })}
      />,
    );
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Ready for psychiatrist review" })).toBeNull();
  });

  it("renders durable job progress and stale output as not ready", () => {
    const { rerender } = render(
      <PrimaryTreatmentPlanView
        result={result("RUNNING", {
          progress: { message: "Validating structured fields.", completedUnits: 2, totalUnits: 3 },
        })}
      />,
    );
    expect(
      screen.getByRole("progressbar", { name: "Primary plan generation progress" }),
    ).toBeTruthy();
    rerender(<PrimaryTreatmentPlanView result={result("STALE")} />);
    expect(screen.getByRole("heading", { name: "Primary plan draft is stale" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Ready for psychiatrist review" })).toBeNull();
    expect(screen.getByText("rx-synthetic-a")).toBeTruthy();
  });

  it("has no detectable WCAG A or AA violations", async () => {
    const { container } = render(<PrimaryTreatmentPlanView result={result("SUCCEEDED")} />);
    const findings = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
    expect(findings.violations).toEqual([]);
  });
});
