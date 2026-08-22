import { describe, expect, it } from "vitest";
import { MAX_CPT_EDITOR_ROWS } from "../src/components/cptTableProjection";
import { projectRawTable } from "../src/components/rawTableProjection";
import type { XmlBifNetwork } from "../src/domain/model";

function rawNetwork(): XmlBifNetwork {
  return {
    name: "RawTables",
    properties: [],
    variables: [
      {
        name: "Weather",
        type: "nature",
        outcomes: ["sunny", "rainy"],
        properties: [],
      },
      {
        name: "Season",
        type: "nature",
        outcomes: ["spring", "summer", "winter"],
        properties: [],
      },
      {
        name: "Choice",
        type: "decision",
        outcomes: ["go", "stay"],
        properties: [],
      },
      { name: "Value", type: "utility", outcomes: [], properties: [] },
    ],
    definitions: [
      {
        for: "Choice",
        given: ["Weather", "Season"],
        table: Array.from({ length: 12 }, (_, index) => index - 5),
        properties: [],
      },
      {
        for: "Value",
        given: ["Weather", "Season"],
        table: [10, 20, 30, 40, 50, 60],
        properties: [],
      },
    ],
  };
}

describe("raw table projection", () => {
  it("maps decision rows with outcomes as rightmost-fastest columns", () => {
    const projection = projectRawTable(rawNetwork(), "Choice");

    expect(projection).toMatchObject({
      ok: true,
      variableType: "decision",
      parentNames: ["Weather", "Season"],
      columnLabels: ["go", "stay"],
    });
    if (!projection.ok) return;
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
      tableIndexes: [8, 9],
      values: [3, 4],
    });
  });

  it("maps utility rows to one Value column", () => {
    const projection = projectRawTable(rawNetwork(), "Value");

    expect(projection).toMatchObject({
      ok: true,
      variableType: "utility",
      parentNames: ["Weather", "Season"],
      columnLabels: ["Value"],
    });
    if (!projection.ok) return;
    expect(projection.rows[4]).toEqual({
      parentStateIndexes: [1, 1],
      parentStates: ["rainy", "summer"],
      tableIndexes: [4],
      values: [50],
    });
  });

  it("maps root utility to one row", () => {
    const network = rawNetwork();
    network.definitions[1] = {
      for: "Value",
      given: [],
      table: [-7],
      properties: [],
    };

    expect(projectRawTable(network, "Value")).toEqual({
      ok: true,
      variableType: "utility",
      parentNames: [],
      columnLabels: ["Value"],
      rows: [
        {
          parentStateIndexes: [],
          parentStates: [],
          tableIndexes: [0],
          values: [-7],
        },
      ],
    });
  });

  it("blocks invalid dimensions with XML guidance", () => {
    const network = rawNetwork();
    network.definitions[0].table = [1];

    expect(projectRawTable(network, "Choice")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/expected 12.*XML Code view/),
    });
  });

  it("applies the graphical row limit before allocating rows", () => {
    const network = rawNetwork();
    network.variables[0].outcomes = Array.from(
      { length: MAX_CPT_EDITOR_ROWS + 1 },
      (_, index) => `state${index}`,
    );
    network.definitions[1] = {
      for: "Value",
      given: ["Weather"],
      table: Array(MAX_CPT_EDITOR_ROWS + 1).fill(0) as number[],
      properties: [],
    };

    expect(projectRawTable(network, "Value")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("graphical editing limit"),
    });
  });
});
