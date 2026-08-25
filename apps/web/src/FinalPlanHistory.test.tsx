import axe from "axe-core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FinalPlanHistoryView } from "./FinalPlanHistory";

const plans = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    sequence: 2,
    status: "ACTIVE" as const,
    predecessorId: "22222222-2222-4222-8222-222222222222",
    plan: {
      subject: {
        maskedName: "S******* P******",
        identifier: {
          type: "RESEARCH_ID",
          issuingAuthority: "INSIGHT_TEST",
          maskedValue: "********0981",
        },
        ageAtResearchCaseStart: 35,
        sex: "FEMALE" as const,
        researchCaseStartedAt: "2026-08-24T12:00:00.000Z",
      },
      generatedPlan: {
        generalMonitoring: ["Review response."],
        explanation: "Immutable plan explanation.",
      },
      finalRegimen: [
        {
          canonicalMedicationId: "rx-risperidone",
          dose: { value: 2, unit: "mg" },
          route: "oral",
          frequency: "once daily",
          titration: "Reassess before change.",
          monitoring: ["Monitor tolerability."],
        },
      ],
    },
    planHash: "a".repeat(64),
    provenance: {
      sourceDraft: { ref: "draft-2", revision: 2 },
      domainResults: [
        { result_type: "BN_INFERENCE", result_reference: "bn-safe" },
        { result_type: "ASSESSMENT_IMPUTATION", details: "must stay hidden" },
      ],
    },
    finalizedByUserId: "33333333-3333-4333-8333-333333333333",
    finalizedAt: "2026-08-24T12:00:00.000Z",
    exportArtifact: {
      byteLength: 1024,
      contentHash: "b".repeat(64),
      mediaType: "application/json" as const,
      createdAt: "2026-08-24T12:00:00.000Z",
    },
  },
];

describe("Final Treatment Plan history", () => {
  it("renders immutable structured content, masked subject, status, and pinned export", () => {
    vi.spyOn(window, "print").mockImplementation(() => undefined);
    render(<FinalPlanHistoryView patientId="patient-safe" plans={plans} />);

    expect(screen.getByText("ACTIVE")).toBeTruthy();
    expect(screen.getByText(plans[0].predecessorId)).toBeTruthy();
    expect(screen.getByText("S******* P******")).toBeTruthy();
    expect(screen.getByText("********0981")).toBeTruthy();
    expect(screen.getByText("2 mg")).toBeTruthy();
    expect(screen.getByText(/Export SHA-256/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Export JSON" }).getAttribute("href")).toContain(
      `${plans[0].id}/export`,
    );
    expect(document.body.textContent).not.toMatch(
      /ASSESSMENT_IMPUTATION|must stay hidden|UNKNOWN/i,
    );
    expect(screen.queryByRole("button", { name: /revision|save|finalize/i })).toBeNull();
  });

  it("has no serious accessibility violations", async () => {
    const { container } = render(<FinalPlanHistoryView patientId="patient-safe" plans={plans} />);
    expect(
      (await axe.run(container)).violations.filter(({ impact }) => impact === "serious"),
    ).toEqual([]);
  });
});
