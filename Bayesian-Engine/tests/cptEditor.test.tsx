import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CptEditor } from "../src/components/CptEditor";
import {
  MAX_CPT_EDITOR_ROWS,
  projectCptTable,
} from "../src/components/cptTableProjection";
import type { DocumentActionResult } from "../src/store/documentStore";
import { multiParentFile, rainRootFile } from "./fixtures/domainFixtures";

afterEach(cleanup);

const success = (): DocumentActionResult => ({ ok: true });

describe("CPT table projection", () => {
  it("maps a root CPT to one child-ordered row", () => {
    expect(projectCptTable(rainRootFile.networks[0], "Rain")).toEqual({
      ok: true,
      parentNames: [],
      childOutcomes: ["true", "false"],
      rows: [
        {
          parentStateIndexes: [],
          parentStates: [],
          tableIndexes: [0, 1],
          values: [0.2, 0.8],
        },
      ],
    });
  });

  it("preserves GIVEN and state order with exact multi-parent indexes", () => {
    const projection = projectCptTable(multiParentFile.networks[0], "Activity");
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;

    expect(projection.parentNames).toEqual(["Weather", "Season"]);
    expect(projection.childOutcomes).toEqual(["inside", "outside", "travel"]);
    expect(projection.rows.map(({ parentStates }) => parentStates)).toEqual([
      ["sunny", "spring"],
      ["sunny", "summer"],
      ["sunny", "winter"],
      ["rainy", "spring"],
      ["rainy", "summer"],
      ["rainy", "winter"],
    ]);
    expect(projection.rows[4]).toEqual({
      parentStateIndexes: [1, 1],
      parentStates: ["rainy", "summer"],
      tableIndexes: [12, 13, 14],
      values: [0.5, 0.1, 0.4],
    });
  });

  it("blocks huge tables before allocating graphical rows", () => {
    const parentOutcomes = Array.from(
      { length: MAX_CPT_EDITOR_ROWS + 1 },
      (_, index) => `p${index}`,
    );
    const network = {
      name: "Large",
      properties: [],
      variables: [
        {
          name: "Parent",
          type: "nature" as const,
          outcomes: parentOutcomes,
          properties: [],
        },
        {
          name: "Child",
          type: "nature" as const,
          outcomes: ["only"],
          properties: [],
        },
      ],
      definitions: [
        {
          for: "Child",
          given: ["Parent"],
          table: Array(MAX_CPT_EDITOR_ROWS + 1).fill(1) as number[],
          properties: [],
        },
      ],
    };

    expect(projectCptTable(network, "Child")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("graphical editing limit"),
    });
  });

  it("blocks invalid table dimensions", () => {
    const network = structuredClone(rainRootFile.networks[0]);
    network.definitions[0].table = [1];
    expect(projectCptTable(network, "Rain")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("expected 2"),
    });
  });
});

describe("CPT editor", () => {
  it("normalizes draft weights and commits the whole row", () => {
    const onCommitRow = vi.fn(success);
    render(
      <CptEditor
        network={rainRootFile.networks[0]}
        childName="Rain"
        onCommitRow={onCommitRow}
      />,
    );

    fireEvent.change(screen.getByLabelText("Root P(true)"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText("Root P(false)"), {
      target: { value: "80" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Normalize" }));

    expect(onCommitRow).toHaveBeenCalledWith([], [0.2, 0.8]);
  });

  it("complements the selected cell and commits a normalized row", () => {
    const onCommitRow = vi.fn(success);
    render(
      <CptEditor
        network={rainRootFile.networks[0]}
        childName="Rain"
        onCommitRow={onCommitRow}
      />,
    );

    fireEvent.change(screen.getByLabelText("Root P(true)"), {
      target: { value: "0.1" },
    });
    fireEvent.focus(screen.getByLabelText("Root P(false)"));
    fireEvent.change(screen.getByLabelText("Root P(false)"), {
      target: { value: "." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complement" }));

    expect(onCommitRow).toHaveBeenCalledWith([], [0.1, 0.9]);
  });

  it("rejects zero-sum and non-finite drafts without mutation", () => {
    const onCommitRow = vi.fn(success);
    render(
      <CptEditor
        network={rainRootFile.networks[0]}
        childName="Rain"
        onCommitRow={onCommitRow}
      />,
    );

    for (const label of ["Root P(true)", "Root P(false)"]) {
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: "0" },
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "Normalize" }));
    expect(screen.getByRole("alert")).toHaveTextContent("zero-sum");

    fireEvent.change(screen.getByLabelText("Root P(true)"), {
      target: { value: "1e" },
    });
    fireEvent.blur(screen.getByLabelText("Root P(true)"));
    expect(onCommitRow).not.toHaveBeenCalled();
  });
});
