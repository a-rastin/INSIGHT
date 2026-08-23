import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  BnProcessingView,
  type BnProcessingResponse,
  type BnProcessingStatus,
} from "./BnProcessing";

const pathway = {
  pathway: "Pharmacotherapy",
  modelVersion: "7",
  modelHash: "sha256-model-safe",
  source: { label: "Governed pharmacotherapy XMLBIF", version: "2026.08" },
  evidenceStatus: "DOCUMENTED" as const,
  calibrationStatus: "NOT_DOCUMENTED" as const,
  clinicalReviewStatus: "PENDING" as const,
};

const snapshot = {
  snapshotHash: "sha256-snapshot-safe",
  promptVersion: "cpt-prompt-1.0.0",
  schemaVersion: "cpt-schema-1.0.0",
  generatedAt: "2026-08-24T10:00:00.000Z",
  validationStatus: "MATHEMATICALLY_VALID" as const,
  outputs: [
    {
      label: "Candidate A suitability",
      value: "0.62 research score",
      evidence: ["Model source section 4", "Matched rule: initial pharmacotherapy"],
    },
  ],
};

function result(
  status: BnProcessingStatus,
  overrides: Partial<BnProcessingResponse> = {},
): BnProcessingResponse {
  return {
    schemaVersion: "1",
    status,
    canRerun: ["NOT_STARTED", "FAILED", "STALE"].includes(status),
    route: {
      status: "ACTIVE",
      routingVersion: "bn-routing-1.0.0",
      matchedRules: ["Initial pharmacotherapy"],
      pathways: [pathway],
    },
    progress: null,
    failure: null,
    snapshot: ["SUCCEEDED", "STALE"].includes(status) ? snapshot : null,
    ...overrides,
  };
}

describe("Bayesian processing states", () => {
  it("renders accepted snapshot provenance without claiming calibration", () => {
    render(<BnProcessingView result={result("SUCCEEDED")} onRerun={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: "LLM-generated patient-specific research values" }),
    ).toBeTruthy();
    expect(screen.getByText("sha256-model-safe")).toBeTruthy();
    expect(screen.getByText("Not documented")).toBeTruthy();
    expect(screen.getByText(/does not establish Bayesian calibration/i)).toBeTruthy();
    expect(screen.getByText("0.62 research score")).toBeTruthy();
    expect(screen.queryByText(/chain-of-thought payload|patient-internal-id/i)).toBeNull();
  });

  it("blocks an inactive route with text, not color alone", () => {
    render(
      <BnProcessingView
        result={result("FAILED", {
          route: {
            status: "INACTIVE",
            routingVersion: "bn-routing-1.0.0",
            matchedRules: [],
            pathways: [],
          },
          failure: {
            code: "ROUTE_INACTIVE",
            message: "Selected route is inactive.",
            retryable: false,
          },
        })}
        onRerun={vi.fn()}
      />,
    );
    expect(screen.getByText("Progression blocked")).toBeTruthy();
    expect(screen.getByText("Inactive or failed routing blocks progression.")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Bayesian processing failed (ROUTE_INACTIVE)" }),
    ).toBeTruthy();
  });

  it("renders typed CPT failure and invokes rerun", () => {
    const onRerun = vi.fn();
    render(
      <BnProcessingView
        result={result("FAILED", {
          failure: {
            code: "CPT_GENERATION_FAILED",
            message: "Generated CPTs remained invalid after three attempts.",
            retryable: true,
          },
        })}
        onRerun={onRerun}
      />,
    );
    expect(screen.getByText(/Generated CPTs remained invalid/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rerun Bayesian processing" }));
    expect(onRerun).toHaveBeenCalledOnce();
  });

  it("keeps stale snapshot inspectable while blocking progression", () => {
    render(<BnProcessingView result={result("STALE")} onRerun={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Bayesian snapshot is stale" })).toBeTruthy();
    expect(screen.getByText(/Prior output remains inspectable/)).toBeTruthy();
    expect(screen.getByText("sha256-snapshot-safe", { exact: false })).toBeTruthy();
  });

  it("renders a typed rerun transport failure", () => {
    render(
      <BnProcessingView
        result={result("FAILED")}
        rerunFailure={{
          code: "MODEL_ENDPOINT_UNAVAILABLE",
          message: "Configured endpoint is unavailable.",
        }}
        onRerun={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Rerun failed (MODEL_ENDPOINT_UNAVAILABLE)" }),
    ).toBeTruthy();
    expect(screen.getByText(/Configured endpoint is unavailable/)).toBeTruthy();
  });
});
