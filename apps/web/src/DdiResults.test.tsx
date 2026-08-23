import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DdiResultsView, type DdiStatus, type DdiStatusResponse } from "./DdiResults";

const execution = {
  executionRef: "ddi-execution-accepted",
  sourceVersion: "ddi-source-set-1",
  exactRegimen: [
    {
      medicationEntryRef: "current-1",
      kind: "CURRENT" as const,
      normalizationState: "NORMALIZED" as const,
      canonicalId: "DRUG-A",
    },
    {
      medicationEntryRef: "current-2",
      kind: "CURRENT" as const,
      normalizationState: "NORMALIZED" as const,
      canonicalId: "DRUG-B",
    },
  ],
  findings: [],
  hasUnknownMedication: false,
  executedAt: "2026-08-23T12:00:00.000Z",
};

function result(status: DdiStatus, overrides: Partial<DdiStatusResponse> = {}): DdiStatusResponse {
  return {
    schemaVersion: "1",
    status,
    mode: "PRIMARY_FILTER",
    canRerun: ["NOT_STARTED", "FAILED", "STALE"].includes(status),
    progress: null,
    failure: null,
    execution: ["SUCCEEDED", "STALE"].includes(status) ? execution : null,
    ...overrides,
  };
}

describe("DDI results states", () => {
  it("renders a successful no-finding result from accepted domain data", () => {
    render(<DdiResultsView result={result("SUCCEEDED")} onRerun={vi.fn()} />);
    expect(screen.getByText("No interactions were found in evaluated pairs.")).toBeTruthy();
    expect(screen.getByText("Execution: ddi-execution-accepted")).toBeTruthy();
    expect(screen.queryByText(/coverage is incomplete/i)).toBeNull();
  });

  it("renders every finding as a text, icon, and warning without blocking continuation", () => {
    render(
      <DdiResultsView
        result={result("SUCCEEDED", {
          execution: {
            ...execution,
            findings: [
              {
                leftCanonicalId: "DRUG-A",
                rightCanonicalId: "DRUG-B",
                severity: "contraindicated",
                mechanism: "CYP inhibition",
                clinicalEffect: "Increased exposure",
                recommendedAction: "Monitor closely",
                sourceRecordRef: "ddi-record-source-L42",
              },
            ],
          },
        })}
        onRerun={vi.fn()}
      />,
    );
    expect(screen.getByText("contraindicated warning")).toBeTruthy();
    expect(screen.getByText(/Findings remain warnings only/)).toBeTruthy();
    expect(screen.getByText(/ddi-record-source-L42/)).toBeTruthy();
    expect(document.querySelector(".ddi-finding-icon")?.textContent).toBe("!");
  });

  it("shows one generic unknown warning without medication references or omitted pairs", () => {
    render(
      <DdiResultsView
        result={result("SUCCEEDED", {
          execution: {
            ...execution,
            exactRegimen: [
              {
                medicationEntryRef: "sensitive-medication-entry",
                kind: "CURRENT",
                normalizationState: "UNKNOWN",
              },
            ],
            hasUnknownMedication: true,
          },
        })}
        onRerun={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/coverage is incomplete/i)).toHaveLength(1);
    expect(screen.queryByText(/sensitive-medication-entry/i)).toBeNull();
    expect(screen.queryByText(/omitted pair/i)).toBeNull();
    expect(screen.getByText("Unresolved medication")).toBeTruthy();
  });

  it("distinguishes blocking failure and offers rerun", () => {
    const onRerun = vi.fn();
    render(
      <DdiResultsView
        result={result("FAILED", {
          canRerun: true,
          failure: { code: "DEPENDENCY_UNAVAILABLE", message: "DDI source unavailable." },
        })}
        onRerun={onRerun}
      />,
    );
    expect(screen.getByRole("heading", { name: "DDI check failed" })).toBeTruthy();
    expect(screen.getByText(/Next workflow state is blocked/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rerun DDI check" }));
    expect(onRerun).toHaveBeenCalledOnce();
  });

  it("marks stale output blocked and labels final-recheck mode", () => {
    render(
      <DdiResultsView
        result={result("STALE", { mode: "FINAL_RECHECK", canRerun: true })}
        onRerun={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Final-regimen recheck" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "DDI result is stale" })).toBeTruthy();
    expect(screen.getByText(/Next workflow state is blocked/)).toBeTruthy();
  });

  it("does not treat a success status without result provenance as completion", () => {
    render(
      <DdiResultsView
        result={result("SUCCEEDED", { execution: null, canRerun: true })}
        onRerun={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "DDI result unavailable" })).toBeTruthy();
    expect(screen.queryByText("DDI check completed")).toBeNull();
  });
});
