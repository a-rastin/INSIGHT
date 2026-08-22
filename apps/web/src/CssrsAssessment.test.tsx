import axe from "axe-core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CSSRS_ACTIVATION_GATE,
  CSSRS_DEFINITION,
  CSSRS_INSTRUMENT_PIN,
  calculateCssrs,
  type CssrsAnswers,
} from "@insight/contracts";

import { CssrsAssessment } from "./CssrsAssessment";

const patientId = "20000000-0000-4000-8000-000000000001";
const researchCaseId = "30000000-0000-4000-8000-000000000001";

function response(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1",
    definition: CSSRS_DEFINITION,
    assessment: {
      researchCaseId,
      assessmentType: "CSSRS_RECENT",
      status: "NOT_STARTED",
      answers: null,
      calculation: null,
      instrumentPin: CSSRS_INSTRUMENT_PIN,
      activationGate: CSSRS_ACTIVATION_GATE,
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

describe("C-SSRS Recent flow", () => {
  it("traverses both branches, renders text plus color, and remains informational", async () => {
    const writes: { mode: string; answers?: CssrsAnswers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.endsWith("/research-case")) {
          return json({ schemaVersion: "1", researchCase: { revision: 1 } });
        }
        if (request.method === "GET") return json(response());
        const body = (await request.clone().json()) as {
          mode: string;
          answers?: CssrsAnswers;
        };
        writes.push(body);
        if (body.mode === "BYPASS") return json(response({ status: "BYPASSED" }));
        return json(
          response({
            status: body.mode === "COMPLETE" ? "COMPLETED" : "IN_PROGRESS",
            answers: body.answers,
            calculation: calculateCssrs(body.answers ?? {}),
          }),
        );
      }),
    );

    const { container } = render(<CssrsAssessment patientId={patientId} csrfToken="csrf" />);
    expect(await screen.findByRole("heading", { name: CSSRS_DEFINITION.title })).toBeTruthy();
    expect(screen.getAllByRole("group")).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "Research activation inactive" })).toBeTruthy();

    choose(/1\. Have you wished/, "No");
    choose(/2\. Have you actually had/, "Yes");
    expect(screen.getAllByRole("group")).toHaveLength(6);
    choose(/3\. Have you been thinking/, "Yes");
    choose(/4\. Have you had these thoughts/, "No");
    choose(/5\. Have you started to work out/, "No");
    choose(/6\. Have you ever done anything/, "Yes");
    expect(screen.getAllByRole("group")).toHaveLength(7);
    choose(/Was this within the past three months/, "No");

    expect(screen.getByText("Moderate", { selector: "strong" })).toBeTruthy();
    expect(container.querySelector(".cssrs-result__marker")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /acknowledge/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /final/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Complete C-SSRS screen" }));
    await vi.waitFor(() => expect(writes.some(({ mode }) => mode === "COMPLETE")).toBe(true));
    expect(writes.find(({ mode }) => mode === "COMPLETE")?.answers).toEqual({
      q1WishDead: false,
      q2SuicidalThoughts: true,
      q3Method: true,
      q4Intent: false,
      q5Plan: false,
      q6Behavior: true,
      q6WithinThreeMonths: false,
    });

    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Bypass C-SSRS screen" }));
    expect(await screen.findByRole("heading", { name: "C-SSRS assessment bypassed" })).toBeTruthy();
    expect(screen.getByText("Bypassed: no result")).toBeTruthy();
    expect(screen.queryByText("Moderate", { selector: "strong" })).toBeNull();
    expect(writes.at(-1)).toEqual({
      schemaVersion: "1",
      mode: "BYPASS",
      expectedRevision: 1,
    });
  }, 30_000);
});

function choose(groupName: RegExp, answer: "Yes" | "No") {
  fireEvent.click(
    within(screen.getByRole("group", { name: groupName })).getByRole("radio", { name: answer }),
  );
}
