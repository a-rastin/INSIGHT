import { describe, expect, it } from "vitest";
import {
  addNatureVariable,
  addOutcome,
  addParent,
  addVariable,
  deleteVariable,
  removeOutcome,
  removeParent,
  renameNetwork,
  renameOutcome,
  renameVariable,
  reorderOutcomes,
  reorderParents,
  setCptDistribution,
  setRawTableRow,
  setVariablePosition,
  setVariableProperties,
} from "../src/domain/mutations";
import { parseXmlBif } from "../src/domain/parser";
import { serializeXmlBif } from "../src/domain/serializer";
import { validateFile } from "../src/domain/validator";
import type { XmlBifNetwork } from "../src/domain/model";
import {
  decisionUtilityFile,
  multiParentFile,
  propertiesFile,
  rainRootFile,
  rainWetGrassFile,
} from "./fixtures/domainFixtures";

function influenceNetwork(): XmlBifNetwork {
  return {
    name: "Influence",
    properties: [],
    variables: [
      { name: "A", type: "nature", outcomes: ["a0", "a1"], properties: [] },
      {
        name: "Choice",
        type: "decision",
        outcomes: ["d0", "d1"],
        properties: [],
      },
      { name: "Value", type: "utility", outcomes: [], properties: [] },
    ],
    definitions: [
      { for: "A", given: [], table: [0.5, 0.5], properties: [] },
      {
        for: "Choice",
        given: ["A"],
        table: [1, 2, 3, 4],
        properties: [],
      },
      {
        for: "Value",
        given: ["Choice", "A"],
        table: [10, 20, 30, 40],
        properties: [],
      },
    ],
  };
}

describe("safe domain mutations", () => {
  it("renames networks and variables while preserving CPT values and order", () => {
    const network = structuredClone(rainWetGrassFile.networks[0]);
    const table = network.definitions[1].table;
    const renamedNetwork = renameNetwork(network, "WeatherModel");
    const renamedVariable = renameVariable(network, "Rain", "Rainfall");

    expect(renamedNetwork).toMatchObject({
      ok: true,
      value: { name: "WeatherModel" },
    });
    expect(renamedVariable).toMatchObject({
      ok: true,
      value: {
        variables: [{ name: "Rainfall" }, { name: "WetGrass" }],
        definitions: [
          { for: "Rainfall", given: [] },
          { for: "WetGrass", given: ["Rainfall"] },
        ],
      },
    });
    if (renamedVariable.ok) {
      expect(renamedVariable.value.definitions[1].table).toBe(table);
    }
  });

  it("sets finite decision and utility rows without probability rules", () => {
    const network = influenceNetwork();
    const decision = setRawTableRow(network, "Choice", [1], [-3, 8]);
    const utility = setRawTableRow(network, "Value", [1, 0], [-7]);

    expect(decision.ok && decision.value.definitions[1].table).toEqual([
      1, 2, -3, 8,
    ]);
    expect(utility.ok && utility.value.definitions[2].table).toEqual([
      10, 20, -7, 40,
    ]);
    expect(setRawTableRow(network, "Choice", [0], [Infinity, 1])).toMatchObject(
      {
        ok: false,
        diagnostics: [{ code: "RAW_TABLE_ROW_VALUES_INVALID" }],
      },
    );
  });

  it.each(["", "two words", "2StartsWrong"])(
    "rejects invalid identifier %j without mutation",
    (name) => {
      const network = structuredClone(rainRootFile.networks[0]);
      const before = structuredClone(network);

      expect(renameVariable(network, "Rain", name)).toMatchObject({
        ok: false,
        diagnostics: [{ code: "INVALID_VARIABLE_IDENTIFIER" }],
      });
      expect(network).toEqual(before);
    },
  );

  it("rejects duplicate names without mutation", () => {
    const network = structuredClone(rainWetGrassFile.networks[0]);
    const before = structuredClone(network);

    expect(renameVariable(network, "Rain", "WetGrass")).toMatchObject({
      ok: false,
      diagnostics: [{ code: "DUPLICATE_VARIABLE_NAME" }],
    });
    expect(network).toEqual(before);
  });

  it("renames an outcome without changing its index or CPT", () => {
    const network = structuredClone(rainWetGrassFile.networks[0]);
    const tables = network.definitions.map(({ table }) => table);

    const result = renameOutcome(network, "Rain", 1, "not raining");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.variables[0].outcomes).toEqual([
        "true",
        "not raining",
      ]);
      expect(result.value.definitions.map(({ table }) => table)).toEqual(
        tables,
      );
    }
    expect(network).toEqual(rainWetGrassFile.networks[0]);
  });

  it("rejects invalid outcome indexes", () => {
    expect(
      renameOutcome(rainRootFile.networks[0], "Rain", 2, "other"),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "OUTCOME_INDEX_OUT_OF_BOUNDS" }],
    });
  });

  it("reorders child and parent outcome axes exactly", () => {
    const childResult = reorderOutcomes(
      multiParentFile.networks[0],
      "Activity",
      [2, 0, 1],
    );
    expect(
      childResult.ok && childResult.value.definitions[2].table.slice(0, 6),
    ).toEqual([0.2, 0.1, 0.7, 0.3, 0.2, 0.5]);

    const parentResult = reorderOutcomes(
      multiParentFile.networks[0],
      "Season",
      [2, 0, 1],
    );
    expect(parentResult.ok && parentResult.value.definitions[1].table).toEqual([
      0.25, 0.25, 0.5,
    ]);
    expect(
      parentResult.ok && parentResult.value.definitions[2].table.slice(0, 9),
    ).toEqual([0.3, 0.4, 0.3, 0.1, 0.7, 0.2, 0.2, 0.5, 0.3]);
  });

  it("reorders every table when a variable is both child and parent", () => {
    const result = reorderOutcomes(
      rainWetGrassFile.networks[0],
      "Rain",
      [1, 0],
    );
    expect(
      result.ok && result.value.definitions.map(({ table }) => table),
    ).toEqual([
      [0.8, 0.2],
      [0.1, 0.9, 0.9, 0.1],
    ]);
  });

  it("reorders decision outcomes across decision and utility tables", () => {
    const result = reorderOutcomes(influenceNetwork(), "Choice", [1, 0]);

    expect(result.ok && result.value.definitions).toMatchObject([
      {},
      { table: [2, 1, 4, 3] },
      { table: [30, 40, 10, 20] },
    ]);
  });

  it("adds child zeros and initializes only new parent slices uniformly", () => {
    const childResult = addOutcome(
      multiParentFile.networks[0],
      "Activity",
      "rest",
      1,
    );
    expect(
      childResult.ok && childResult.value.definitions[2].table.slice(0, 8),
    ).toEqual([0.1, 0, 0.7, 0.2, 0.2, 0, 0.5, 0.3]);
    expect(childResult.ok && childResult.warnings).toEqual([]);

    const parentResult = addOutcome(
      multiParentFile.networks[0],
      "Season",
      "autumn",
      1,
    );
    expect(parentResult.ok && parentResult.value.definitions[1].table).toEqual([
      0.25, 0, 0.5, 0.25,
    ]);
    expect(
      parentResult.ok && parentResult.value.definitions[2].table.slice(0, 12),
    ).toEqual([
      0.1,
      0.7,
      0.2,
      1 / 3,
      1 / 3,
      1 / 3,
      0.2,
      0.5,
      0.3,
      0.3,
      0.4,
      0.3,
    ]);
    expect(parentResult.ok && parentResult.warnings).toMatchObject([
      { code: "CPT_INITIALIZED_NEW_PARENT_STATE", variableName: "Activity" },
    ]);
  });

  it("adds zero-valued decision and utility cells", () => {
    const result = addOutcome(influenceNetwork(), "Choice", "d2");

    expect(result.ok && result.value.definitions).toMatchObject([
      {},
      { table: [1, 2, 0, 3, 4, 0] },
      { table: [10, 20, 30, 40, 0, 0] },
    ]);
    expect(result.ok && result.warnings).toEqual([]);
  });

  it("removes parent slices exactly and resets a nonzero child removal", () => {
    const result = removeOutcome(multiParentFile.networks[0], "Season", 1);
    expect(result.ok && result.value.definitions[1].table).toEqual([0.5, 0.5]);
    expect(result.ok && result.value.definitions[2].table.slice(0, 6)).toEqual([
      0.1, 0.7, 0.2, 0.3, 0.4, 0.3,
    ]);
    expect(result.ok && result.warnings).toMatchObject([
      { code: "CPT_RESET_CHILD_OUTCOME_REMOVAL", variableName: "Season" },
    ]);
  });

  it("removes an effectively-zero child outcome losslessly", () => {
    const network = structuredClone(rainRootFile.networks[0]);
    network.definitions[0].table = [1, 0];
    const result = removeOutcome(network, "Rain", 1);

    expect(result).toMatchObject({
      ok: true,
      warnings: [],
      value: {
        variables: [{ outcomes: ["true"] }],
        definitions: [{ table: [1] }],
      },
    });
  });

  it("requires confirmation before resetting raw tables on outcome removal", () => {
    const network = influenceNetwork();
    const before = structuredClone(network);

    expect(removeOutcome(network, "Choice", 1)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "RAW_TABLE_RESET_CONFIRMATION_REQUIRED" }],
    });
    expect(network).toEqual(before);

    const result = removeOutcome(network, "Choice", 1, {
      allowDataLoss: true,
    });
    expect(result).toMatchObject({
      ok: true,
      warnings: [
        { code: "RAW_TABLE_RESET", definitionFor: "Choice" },
        { code: "RAW_TABLE_RESET", definitionFor: "Value" },
      ],
      value: {
        variables: [{}, { outcomes: ["d0"] }, {}],
        definitions: [{}, { table: [0, 0] }, { table: [0, 0] }],
      },
    });
  });

  it("rejects removing the final nature outcome and utility outcome edits", () => {
    const oneOutcome = structuredClone(rainRootFile.networks[0]);
    oneOutcome.variables[0].outcomes = ["true"];
    oneOutcome.definitions[0].table = [1];
    expect(removeOutcome(oneOutcome, "Rain", 0)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "NATURE_OUTCOME_REQUIRED" }],
    });
    expect(
      addOutcome(decisionUtilityFile.networks[0], "Value", "other"),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "UNSUPPORTED_OUTCOME_EDIT" }],
    });
  });

  it("round-trips transformed non-binary outcomes without changing semantics", () => {
    const result = addOutcome(
      multiParentFile.networks[0],
      "Season",
      "autumn",
      1,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const source = serializeXmlBif({
      version: "0.3",
      networks: [result.value],
    });
    const parsed = parseXmlBif(source);
    expect(parsed.ok && parsed.file.networks[0]).toEqual(result.value);
  });

  it("sets raw properties and replaces only first recognized position", () => {
    const network = structuredClone(propertiesFile.networks[0]);
    const raw = [
      { text: "unstructured = preserve exactly" },
      { text: "position = (1, 2)" },
      { text: "position = (3, 4)" },
    ];
    const withProperties = setVariableProperties(network, "LocatedNode", raw);
    expect(withProperties).toMatchObject({ ok: true });
    if (!withProperties.ok) return;

    const moved = setVariablePosition(withProperties.value, "LocatedNode", {
      x: 10,
      y: -20.5,
    });
    expect(moved).toMatchObject({ ok: true });
    if (moved.ok) {
      expect(moved.value.variables[0].properties).toEqual([
        { text: "unstructured = preserve exactly" },
        { text: "position = (10, -20.5)" },
        { text: "position = (3, 4)" },
      ]);
    }
    expect(network).toEqual(propertiesFile.networks[0]);
  });

  it("adds deterministic valid nature nodes with optional position", () => {
    const network = structuredClone(rainRootFile.networks[0]);
    network.variables.push({
      name: "Node2",
      type: "nature",
      outcomes: ["State0", "State1"],
      properties: [],
    });
    network.definitions.push({
      for: "Node2",
      given: [],
      table: [0.5, 0.5],
      properties: [],
    });

    const result = addNatureVariable(network, undefined, { x: 12, y: 34 });
    expect(result).toMatchObject({
      ok: true,
      value: {
        variables: [
          {},
          {},
          {
            name: "Node1",
            type: "nature",
            outcomes: ["State0", "State1"],
            properties: [{ text: "position = (12, 34)" }],
          },
        ],
        definitions: [{}, {}, { for: "Node1", given: [], table: [0.5, 0.5] }],
      },
    });
    if (result.ok) {
      expect(
        validateFile({ version: "0.3", networks: [result.value] }),
      ).toEqual([]);
    }
  });

  it("creates typed nodes with deterministic defaults", () => {
    const network = structuredClone(rainRootFile.networks[0]);
    const decision = addVariable(network, "decision", undefined, {
      x: 1,
      y: 2,
    });
    const utility = addVariable(network, "utility", "Utility1");

    expect(decision).toMatchObject({
      ok: true,
      value: {
        variables: [
          {},
          {
            name: "Node1",
            type: "decision",
            outcomes: ["State0", "State1"],
            properties: [{ text: "position = (1, 2)" }],
          },
        ],
        definitions: [{}, { for: "Node1", given: [], table: [0, 0] }],
      },
    });
    expect(utility).toMatchObject({
      ok: true,
      value: {
        variables: [{}, { name: "Utility1", type: "utility", outcomes: [] }],
        definitions: [{}, { for: "Utility1", given: [], table: [0] }],
      },
    });
  });

  it("adds a parent by replicating the old CPT across every parent state", () => {
    const added = addNatureVariable(rainRootFile.networks[0], "Child");
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const result = addParent(added.value, "Child", "Rain");
    expect(result).toMatchObject({
      ok: true,
      value: {
        definitions: [
          {},
          { for: "Child", given: ["Rain"], table: [0.5, 0.5, 0.5, 0.5] },
        ],
      },
    });
  });

  it("adds a second parent at requested axis without changing old distributions", () => {
    const network = structuredClone(multiParentFile.networks[0]);
    network.definitions[2].given = ["Weather"];
    network.definitions[2].table = [0.1, 0.7, 0.2, 0.4, 0.2, 0.4];

    const appended = addParent(network, "Activity", "Season");
    expect(appended.ok && appended.value.definitions[2].table).toEqual([
      0.1, 0.7, 0.2, 0.1, 0.7, 0.2, 0.1, 0.7, 0.2, 0.4, 0.2, 0.4, 0.4, 0.2, 0.4,
      0.4, 0.2, 0.4,
    ]);

    const inserted = addParent(network, "Activity", "Season", 0);
    expect(inserted.ok && inserted.value.definitions[2]).toMatchObject({
      given: ["Season", "Weather"],
      table: [
        0.1, 0.7, 0.2, 0.4, 0.2, 0.4, 0.1, 0.7, 0.2, 0.4, 0.2, 0.4, 0.1, 0.7,
        0.2, 0.4, 0.2, 0.4,
      ],
    });
  });

  it("adds mixed-type parents and creates missing decision tables", () => {
    const imported = influenceNetwork();
    imported.definitions = imported.definitions.filter(
      ({ for: definitionFor }) => definitionFor !== "Choice",
    );
    const decisionResult = addParent(imported, "Choice", "A");
    expect(decisionResult).toMatchObject({
      ok: true,
      value: {
        definitions: [
          {},
          {},
          { for: "Choice", given: ["A"], table: [0, 0, 0, 0] },
        ],
      },
    });

    const utilityRoot = influenceNetwork();
    utilityRoot.definitions[2] = {
      for: "Value",
      given: [],
      table: [7],
      properties: [],
    };
    const utilityResult = addParent(utilityRoot, "Value", "Choice");
    expect(utilityResult).toMatchObject({
      ok: true,
      value: {
        definitions: [{}, {}, { given: ["Choice"], table: [0, 0] }],
      },
    });
  });

  it("rejects duplicate, self, cycle, unknown, and utility-source arcs", () => {
    const network = rainWetGrassFile.networks[0];
    expect(addParent(network, "WetGrass", "Rain")).toMatchObject({
      ok: false,
      diagnostics: [{ code: "DUPLICATE_GIVEN" }],
    });
    expect(addParent(network, "Rain", "Rain")).toMatchObject({
      ok: false,
      diagnostics: [{ code: "SELF_PARENT" }],
    });
    expect(addParent(network, "Rain", "WetGrass")).toMatchObject({
      ok: false,
      diagnostics: [{ code: "GRAPH_CYCLE" }],
    });
    expect(addParent(network, "Missing", "Rain")).toMatchObject({
      ok: false,
      diagnostics: [{ code: "VARIABLE_NOT_FOUND" }],
    });
    expect(
      addParent(decisionUtilityFile.networks[0], "Choice", "Value"),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "UTILITY_CANNOT_BE_PARENT" }],
    });
  });

  it("removes parents losslessly or resets differing slices uniformly", () => {
    const identical = structuredClone(rainWetGrassFile.networks[0]);
    identical.definitions[1].table = [0.3, 0.7, 0.3, 0.7];
    expect(removeParent(identical, "WetGrass", "Rain")).toMatchObject({
      ok: true,
      warnings: [],
      value: { definitions: [{}, { given: [], table: [0.3, 0.7] }] },
    });

    expect(
      removeParent(rainWetGrassFile.networks[0], "WetGrass", "Rain"),
    ).toMatchObject({
      ok: true,
      warnings: [{ code: "CPT_RESET_PARENT_REMOVAL" }],
      value: { definitions: [{}, { given: [], table: [0.5, 0.5] }] },
    });
  });

  it("preserves lossless raw parent collapse without confirmation", () => {
    const network = influenceNetwork();
    network.definitions[1].table = [1, 2, 1, 2];

    expect(removeParent(network, "Choice", "A")).toMatchObject({
      ok: true,
      warnings: [],
      value: { definitions: [{}, { given: [], table: [1, 2] }, {}] },
    });
  });

  it("requires confirmation before raw parent removal and resets to zero", () => {
    const network = influenceNetwork();

    expect(removeParent(network, "Choice", "A")).toMatchObject({
      ok: false,
      diagnostics: [{ code: "RAW_TABLE_RESET_CONFIRMATION_REQUIRED" }],
    });
    expect(
      removeParent(network, "Choice", "A", { allowDataLoss: true }),
    ).toMatchObject({
      ok: true,
      warnings: [{ code: "RAW_TABLE_RESET", definitionFor: "Choice" }],
      value: { definitions: [{}, { given: [], table: [0, 0] }, {}] },
    });

    expect(removeParent(network, "Value", "Choice")).toMatchObject({
      ok: false,
      diagnostics: [{ code: "RAW_TABLE_RESET_CONFIRMATION_REQUIRED" }],
    });
    expect(
      removeParent(network, "Value", "Choice", { allowDataLoss: true }),
    ).toMatchObject({
      ok: true,
      warnings: [{ code: "RAW_TABLE_RESET", definitionFor: "Value" }],
      value: { definitions: [{}, {}, { given: ["A"], table: [0, 0] }] },
    });
  });

  it("reorders parent axes with exact historical tensor order", () => {
    const result = reorderParents(
      multiParentFile.networks[0],
      "Activity",
      [1, 0],
    );
    expect(result.ok && result.value.definitions[2]).toMatchObject({
      given: ["Season", "Weather"],
      table: [
        0.1, 0.7, 0.2, 0.4, 0.2, 0.4, 0.2, 0.5, 0.3, 0.5, 0.1, 0.4, 0.3, 0.4,
        0.3, 0.6, 0.3, 0.1,
      ],
    });
  });

  it("reorders utility parent-only axes exactly", () => {
    const result = reorderParents(influenceNetwork(), "Value", [1, 0]);

    expect(result.ok && result.value.definitions[2]).toMatchObject({
      given: ["A", "Choice"],
      table: [10, 30, 20, 40],
    });
  });

  it("commits one CPT distribution through tensor coordinates", () => {
    const result = setCptDistribution(
      multiParentFile.networks[0],
      "Activity",
      [1, 1],
      [0.2, 0.3, 0.5],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definitions[2].table.slice(12, 15)).toEqual([
      0.2, 0.3, 0.5,
    ]);
    expect(result.value.definitions[2].table.slice(9, 12)).toEqual([
      0.4, 0.2, 0.4,
    ]);
    const parsed = parseXmlBif(
      serializeXmlBif({ version: "0.3", networks: [result.value] }),
    );
    expect(parsed.ok && parsed.file.networks[0].definitions[2].table).toEqual(
      result.value.definitions[2].table,
    );
  });

  it("rejects invalid CPT rows without mutation", () => {
    const network = structuredClone(rainRootFile.networks[0]);
    const before = structuredClone(network);

    expect(setCptDistribution(network, "Rain", [], [0, 0])).toMatchObject({
      ok: false,
      diagnostics: [{ code: "CPT_DISTRIBUTION_NOT_NORMALIZED" }],
    });
    expect(
      setCptDistribution(network, "Rain", [], [Infinity, 0]),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "CPT_ROW_VALUES_INVALID" }],
    });
    expect(network).toEqual(before);
  });

  it("deletes isolated variables", () => {
    const added = addNatureVariable(rainRootFile.networks[0], "Other");
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const deleted = deleteVariable(added.value, "Other");
    expect(deleted).toMatchObject({
      ok: true,
      value: rainRootFile.networks[0],
    });
  });

  it("collapses identical child rows losslessly when deleting a parent", () => {
    const network = structuredClone(rainWetGrassFile.networks[0]);
    network.definitions[1].table = [0.3, 0.7, 0.3, 0.7];

    const result = deleteVariable(network, "Rain");
    expect(result).toMatchObject({
      ok: true,
      warnings: [],
      value: {
        variables: [{ name: "WetGrass" }],
        definitions: [{ for: "WetGrass", given: [], table: [0.3, 0.7] }],
      },
    });
  });

  it("resets differing child rows uniformly and emits a warning", () => {
    const network = structuredClone(rainWetGrassFile.networks[0]);
    const before = structuredClone(network);

    const result = deleteVariable(network, "Rain");
    expect(result).toMatchObject({
      ok: true,
      warnings: [{ code: "CPT_RESET_PARENT_REMOVAL" }],
      value: {
        variables: [{ name: "WetGrass" }],
        definitions: [{ for: "WetGrass", given: [], table: [0.5, 0.5] }],
      },
    });
    expect(network).toEqual(before);
  });

  it("requires confirmation before deletion resets referenced raw tables", () => {
    const network = influenceNetwork();
    const before = structuredClone(network);

    expect(deleteVariable(network, "A")).toMatchObject({
      ok: false,
      diagnostics: [{ code: "RAW_TABLE_RESET_CONFIRMATION_REQUIRED" }],
    });
    expect(network).toEqual(before);

    expect(deleteVariable(network, "A", { allowDataLoss: true })).toMatchObject(
      {
        ok: true,
        warnings: [
          { code: "RAW_TABLE_RESET", definitionFor: "Choice" },
          { code: "RAW_TABLE_RESET", definitionFor: "Value" },
        ],
        value: {
          variables: [{ name: "Choice" }, { name: "Value" }],
          definitions: [
            { for: "Choice", given: [], table: [0, 0] },
            { for: "Value", given: ["Choice"], table: [0, 0] },
          ],
        },
      },
    );
  });

  it("deletes raw-table parents losslessly when slices match", () => {
    const network = influenceNetwork();
    network.definitions[1].table = [1, 2, 1, 2];
    network.definitions[2].table = [10, 10, 20, 20];

    expect(deleteVariable(network, "A")).toMatchObject({
      ok: true,
      warnings: [],
      value: {
        definitions: [
          { for: "Choice", given: [], table: [1, 2] },
          { for: "Value", given: ["Choice"], table: [10, 20] },
        ],
      },
    });
  });
});
