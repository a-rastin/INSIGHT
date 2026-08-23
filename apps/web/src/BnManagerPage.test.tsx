import axe from "axe-core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BnManagerPage } from "./BnManagerPage";

const model = {
  id: "20000000-0000-4000-8000-000000000001",
  pathwayIdentity: "PHARMACOTHERAPY",
  version: 2,
  lifecycle: "REJECTED",
  quarantineReason: null,
  source: {
    fileName: "pharmacotherapy-invalid.xml",
    mediaType: "application/xml",
    byteLength: 412,
    contentSha256: "a".repeat(64),
    semanticSha256: null,
    topologySha256: null,
    importerVersion: "1.0.0",
    importedByUserId: "10000000-0000-4000-8000-000000000001",
    importedAt: "2026-08-23T12:00:00.000Z",
  },
  validation: {
    softwareCompatible: false,
    clinicalValidity: "NOT_ESTABLISHED",
    checks: [
      { code: "SECURE_PARSE", passed: true, detail: "XML parsed within configured limits." },
      {
        code: "MODEL_VALIDATION",
        passed: false,
        detail: "Structure or tables fail software validation.",
      },
    ],
    diagnostics: [
      {
        code: "CPT_DISTRIBUTION_NOT_NORMALIZED",
        severity: "error",
        category: "probability",
        message: "CPT distribution for Choice sums to 0.4, not 1",
        variableName: "Choice",
      },
    ],
  },
  evidence: { status: "UNREVIEWED", reference: "NO-EVIDENCE-REVIEW" },
  calibration: { status: "UNCALIBRATED", reference: "NO-CALIBRATION-REPORT" },
  clinicalReview: { status: "UNREVIEWED", reference: "NO-CLINICAL-REVIEW" },
  networks: [
    {
      name: "MedicationChoice",
      nodes: [
        {
          id: "Input",
          type: "nature",
          outcomes: ["yes", "no"],
          parents: [],
          properties: [],
          tableValueCount: 2,
          position: null,
        },
        {
          id: "Choice",
          type: "nature",
          outcomes: ["first", "second"],
          parents: ["Input"],
          properties: [],
          tableValueCount: 4,
          position: null,
        },
      ],
      edges: [{ source: "Input", target: "Choice" }],
    },
  ],
} as const;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ schemaVersion: "1", models: [model] })),
  );
});

describe("BN Manager", () => {
  it("keeps software diagnostics separate from evidence and inspects graph nodes", async () => {
    render(<BnManagerPage csrfToken="csrf-token" />);

    expect(await screen.findByText(/CPT_DISTRIBUTION_NOT_NORMALIZED/)).toBeTruthy();
    expect(screen.getByText("Software invalid")).toBeTruthy();
    expect(screen.getByText("Clinical validity NOT ESTABLISHED")).toBeTruthy();
    expect(screen.getByText("UNCALIBRATED")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Choice nature/ }));
    expect(screen.getByRole("complementary", { name: "Node inspector" }).textContent).toContain(
      "Input",
    );
    expect(screen.getByRole("complementary", { name: "Node inspector" }).textContent).toContain(
      "first, second",
    );
  });

  it("has no detectable WCAG A or AA violations", async () => {
    const { container } = render(<BnManagerPage csrfToken="csrf-token" />);
    await screen.findByRole("heading", { name: "Immutable versions" });
    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
