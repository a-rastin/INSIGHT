import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DSM5TR_DEFINITION,
  DSM5TR_INSTRUMENT_PIN,
  calculateDsm5tr,
  type Dsm5trAnswers,
} from "@insight/contracts";

import { Dsm5trAssessment } from "./Dsm5trAssessment";

const patientId = "20000000-0000-4000-8000-000000000001";
const researchCaseId = "30000000-0000-4000-8000-000000000001";

function assessmentResponse(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1",
    definition: DSM5TR_DEFINITION,
    assessment: {
      researchCaseId,
      assessmentType: "DSM5TR",
      status: "NOT_STARTED",
      answers: null,
      calculation: null,
      psychiatristDecision: null,
      instrumentPin: DSM5TR_INSTRUMENT_PIN,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: null,
      updatedAt: null,
      ...overrides,
    },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => vi.restoreAllMocks());

describe("DSM-5-TR assessment flow", () => {
  it("autosaves structured answers, preserves contrary authority, completes, and bypasses", async () => {
    type Write = {
      schemaVersion: string;
      mode: string;
      expectedRevision: number;
      answers?: Dsm5trAnswers;
      psychiatristDecision?: string;
    };
    const writes: Write[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.endsWith("/research-case")) {
          return json({
            schemaVersion: "1",
            researchCase: {
              id: researchCaseId,
              state: "DATA_COLLECTION",
              revision: 1,
              inputRevision: 1,
              currentStep: { ordinal: 1, label: "Data collection" },
              allowedCommands: [],
              modelAllowedTools: [],
              lastInputInvalidation: null,
            },
          });
        }
        if (request.method === "GET") return json(assessmentResponse());
        const body = (await request.clone().json()) as Write;
        writes.push(body);
        if (body.mode === "BYPASS") {
          return json(assessmentResponse({ status: "BYPASSED" }));
        }
        const answers = body.answers!;
        return json(
          assessmentResponse({
            status: body.mode === "COMPLETE" ? "COMPLETED" : "IN_PROGRESS",
            answers,
            calculation: calculateDsm5tr(answers),
            psychiatristDecision: body.psychiatristDecision,
          }),
        );
      }),
    );

    render(<Dsm5trAssessment patientId={patientId} csrfToken="csrf" />);
    expect(
      await screen.findByRole("heading", { name: "DSM-5-TR schizophrenia criteria assessment" }),
    ).toBeTruthy();
    expect(screen.getByText("Incomplete")).toBeTruthy();

    for (const [question, answer] of [
      ["Delusions", "Yes"],
      ["Hallucinations", "Yes"],
      ["Disorganized speech", "No"],
      ["Grossly disorganized or catatonic behavior", "No"],
      ["Negative symptoms", "No"],
      ["Functional-decline requirement met", "Yes"],
      ["Duration requirement met", "Yes"],
      ["Mood-disorder exclusion requirement met", "Yes"],
      ["Substance or medical-condition exclusion requirement met", "Yes"],
      ["History of autism spectrum disorder or childhood communication disorder", "No"],
    ]) {
      fireEvent.click(
        within(screen.getByRole("group", { name: question })).getByRole("radio", {
          name: answer,
        }),
      );
    }
    fireEvent.click(screen.getByRole("radio", { name: "Schizophrenia not confirmed" }));
    expect(screen.getByText("Criteria met")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Complete assessment" }));
    await vi.waitFor(() => expect(writes.some(({ mode }) => mode === "COMPLETE")).toBe(true));
    const completed = writes.find(({ mode }) => mode === "COMPLETE");
    expect(completed?.psychiatristDecision).toBe("SCHIZOPHRENIA_NOT_CONFIRMED");
    expect(completed?.answers?.criterionA.delusions).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Bypass assessment" }));
    expect(await screen.findByRole("heading", { name: "Assessment bypassed" })).toBeTruthy();
    expect(screen.getByText("Bypassed: no result")).toBeTruthy();
    expect(screen.queryByText("Criteria met")).toBeNull();
    expect(writes.at(-1)).toEqual({ schemaVersion: "1", mode: "BYPASS", expectedRevision: 1 });
  }, 30_000);
});
