import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PANSS_DEFINITION,
  PANSS_INSTRUMENT_PIN,
  calculatePanss,
  type PanssAnswers,
} from "@insight/contracts";

import { PanssAssessment } from "./PanssAssessment";

const patientId = "20000000-0000-4000-8000-000000000001";
const researchCaseId = "30000000-0000-4000-8000-000000000001";

function response(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1",
    definition: PANSS_DEFINITION,
    assessment: {
      researchCaseId,
      assessmentType: "PANSS",
      status: "NOT_STARTED",
      answers: null,
      calculation: null,
      instrumentPin: PANSS_INSTRUMENT_PIN,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: null,
      updatedAt: null,
      ...overrides,
    },
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => vi.restoreAllMocks());

describe("PANSS assessment flow", () => {
  it("renders 30 labelled inputs, hides partial totals, completes, and bypasses separately", async () => {
    const writes: { mode: string; answers?: PanssAnswers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.endsWith("/research-case")) {
          return json({
            schemaVersion: "1",
            researchCase: { revision: 1 },
          });
        }
        if (request.method === "GET") return json(response());
        const body = (await request.clone().json()) as {
          mode: string;
          answers?: PanssAnswers;
        };
        writes.push(body);
        if (body.mode === "BYPASS") return json(response({ status: "BYPASSED" }));
        return json(
          response({
            status: body.mode === "COMPLETE" ? "COMPLETED" : "IN_PROGRESS",
            answers: body.answers,
            calculation: calculatePanss(body.answers ?? {}),
          }),
        );
      }),
    );

    render(<PanssAssessment patientId={patientId} csrfToken="csrf" />);
    expect(await screen.findByRole("heading", { name: PANSS_DEFINITION.title })).toBeTruthy();
    expect(screen.getAllByRole("combobox")).toHaveLength(30);
    expect(screen.getByText("Incomplete: 0 of 30 items rated")).toBeTruthy();
    expect(screen.queryByText("Positive", { selector: "dt" })).toBeNull();

    for (const item of PANSS_DEFINITION.items) {
      fireEvent.change(screen.getByLabelText(new RegExp(`${item.id} ${item.text}`)), {
        target: { value: "1" },
      });
    }
    expect(screen.getByText("30", { selector: "dd" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Complete PANSS assessment" }));
    await vi.waitFor(() => expect(writes.some(({ mode }) => mode === "COMPLETE")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Bypass PANSS assessment" }));
    expect(await screen.findByRole("heading", { name: "PANSS assessment bypassed" })).toBeTruthy();
    expect(screen.getByText("Bypassed: no score")).toBeTruthy();
    expect(screen.queryByText(/0 of 30/)).toBeNull();
    expect(writes.at(-1)).toEqual({
      schemaVersion: "1",
      mode: "BYPASS",
      expectedRevision: 1,
    });
  }, 30_000);
});
