import { describe, expect, it } from "vitest";
import type { XmlBifFile } from "../src/domain/model";
import {
  forEachDistribution,
  validateFile,
  validateProbabilities,
  validateRawTables,
} from "../src/domain/validator";
import {
  decisionUtilityFile,
  multiParentFile,
  rainRootFile,
  rainWetGrassFile,
} from "./fixtures/domainFixtures";

const codes = (file: XmlBifFile): string[] =>
  validateProbabilities(file).map(({ code }) => code);

const rootFile = (table: number[]): XmlBifFile => ({
  version: "0.3",
  networks: [
    {
      name: "Root",
      properties: [],
      variables: [
        {
          name: "X",
          type: "nature",
          outcomes: ["a", "b"],
          properties: [],
        },
      ],
      definitions: [{ for: "X", given: [], table, properties: [] }],
    },
  ],
});

describe("validateProbabilities", () => {
  it("accepts valid root, one-parent, child-cardinality-3, and multi-parent CPTs", () => {
    expect(validateProbabilities(rainRootFile)).toEqual([]);
    expect(validateProbabilities(rainWetGrassFile)).toEqual([]);
    expect(validateProbabilities(multiParentFile)).toEqual([]);
    expect(validateFile(multiParentFile)).toEqual([]);
  });

  it("groups contiguous child values in historical parent-parent-child order", () => {
    const network = multiParentFile.networks[0];
    const definition = network.definitions[2];
    const groups: Array<{
      values: readonly number[];
      parents: readonly number[];
    }> = [];

    forEachDistribution(network, definition, (values, parents) => {
      groups.push({ values, parents });
    });

    expect(groups).toEqual([
      { parents: [0, 0], values: [0.1, 0.7, 0.2] },
      { parents: [0, 1], values: [0.2, 0.5, 0.3] },
      { parents: [0, 2], values: [0.3, 0.4, 0.3] },
      { parents: [1, 0], values: [0.4, 0.2, 0.4] },
      { parents: [1, 1], values: [0.5, 0.1, 0.4] },
      { parents: [1, 2], values: [0.6, 0.3, 0.1] },
    ]);
  });

  it.each([
    [[], "CPT_TABLE_EMPTY"],
    [[1], "CPT_TABLE_LENGTH"],
    [[0.2, 0.8, 0], "CPT_TABLE_LENGTH"],
  ])("rejects invalid table size %#", (table, expectedCode) => {
    expect(codes(rootFile(table as number[]))).toContain(expectedCode);
  });

  it("reports negative, above-one, and non-normalized values", () => {
    const diagnostics = validateProbabilities(rootFile([-0.2, 1.3]));

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CPT_VALUE_NEGATIVE",
          tableIndex: 0,
          parentConfigurationIndex: 0,
        }),
        expect.objectContaining({ code: "CPT_VALUE_ABOVE_ONE", tableIndex: 1 }),
        expect.objectContaining({
          code: "CPT_DISTRIBUTION_NOT_NORMALIZED",
          parentConfigurationIndex: 0,
        }),
      ]),
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite value %s from direct domain input",
    (value) => {
      expect(codes(rootFile([value, 0]))).toContain("CPT_VALUE_NON_FINITE");
    },
  );

  it("allows normalization error within absolute tolerance", () => {
    expect(validateProbabilities(rootFile([0.2, 0.8000000005]))).toEqual([]);
    expect(codes(rootFile([0.2, 0.800000002]))).toContain(
      "CPT_DISTRIBUTION_NOT_NORMALIZED",
    );
  });

  it("does not treat decision or utility tables as probabilities", () => {
    const file = structuredClone(decisionUtilityFile);
    file.networks[0].definitions[0].table = [10, -2];

    expect(validateProbabilities(file)).toEqual([]);
  });

  it("accepts finite decision and utility values without probability rules", () => {
    const file = structuredClone(decisionUtilityFile);
    file.networks[0].definitions.unshift({
      for: "Choice",
      given: [],
      table: [-10, 20],
      properties: [],
    });

    expect(validateRawTables(file)).toEqual([]);
    expect(validateFile(file)).toEqual([]);
  });

  it("validates decision and utility table dimensions", () => {
    const decisionFile = structuredClone(decisionUtilityFile);
    decisionFile.networks[0].variables.unshift({
      name: "Context",
      type: "nature",
      outcomes: ["low", "medium", "high"],
      properties: [],
    });
    decisionFile.networks[0].definitions.unshift({
      for: "Choice",
      given: ["Context"],
      table: [0],
      properties: [],
    });
    const utilityFile = structuredClone(decisionUtilityFile);
    utilityFile.networks[0].definitions[0].table = [10];

    expect(validateRawTables(decisionFile)).toEqual([
      expect.objectContaining({ code: "DECISION_TABLE_LENGTH" }),
    ]);
    expect(validateRawTables(utilityFile)).toEqual([
      expect.objectContaining({ code: "UTILITY_TABLE_LENGTH" }),
    ]);
  });

  it.each(["decision", "utility"] as const)(
    "rejects non-finite %s table values",
    (type) => {
      const file = structuredClone(decisionUtilityFile);
      if (type === "decision") {
        file.networks[0].definitions.unshift({
          for: "Choice",
          given: [],
          table: [Number.NaN, 0],
          properties: [],
        });
      } else {
        file.networks[0].definitions[0].table = [Number.POSITIVE_INFINITY, 0];
      }

      expect(validateRawTables(file)).toEqual([
        expect.objectContaining({
          code: "TABLE_VALUE_NON_FINITE",
          tableIndex: 0,
        }),
      ]);
      expect(validateProbabilities(file)).toEqual([]);
    },
  );
});
