import { describe, expect, it } from "vitest";
import type {
  XmlBifDefinition,
  XmlBifFile,
  XmlBifNetwork,
  XmlBifVariable,
} from "../src/domain/model";
import {
  hasBlockingStructuralErrors,
  validateStructure,
} from "../src/domain/validator";
import { rainWetGrassFile } from "./fixtures/domainFixtures";

const variable = (
  name: string,
  type: XmlBifVariable["type"] = "nature",
): XmlBifVariable => ({
  name,
  type,
  outcomes: type === "utility" ? [] : ["yes", "no"],
  properties: [],
});

const definition = (child: string, given: string[] = []): XmlBifDefinition => ({
  for: child,
  given,
  table: [],
  properties: [],
});

const fileWith = (network: Partial<XmlBifNetwork>): XmlBifFile => ({
  version: "0.3",
  networks: [
    {
      name: "Network",
      properties: [],
      variables: [],
      definitions: [],
      ...network,
    },
  ],
});

const codes = (file: XmlBifFile): string[] =>
  validateStructure(file).map(({ code }) => code);

describe("validateStructure", () => {
  it("accepts valid multi-network files without mutation", () => {
    const file: XmlBifFile = {
      version: "0.3",
      networks: [
        rainWetGrassFile.networks[0],
        {
          name: "Influence",
          properties: [],
          variables: [
            variable("Choice", "decision"),
            variable("Value", "utility"),
          ],
          definitions: [definition("Value", ["Choice"])],
        },
      ],
    };
    const before = structuredClone(file);

    expect(validateStructure(file)).toEqual([]);
    expect(file).toEqual(before);
  });

  it.each([
    ["blank network name", { name: "  " }, "BLANK_NETWORK_NAME"],
    [
      "blank variable name",
      { variables: [variable("")], definitions: [definition("")] },
      "BLANK_VARIABLE_NAME",
    ],
    [
      "duplicate variables",
      {
        variables: [variable("A"), variable("A")],
        definitions: [definition("A")],
      },
      "DUPLICATE_VARIABLE_NAME",
    ],
    [
      "nature node without outcomes",
      {
        variables: [{ ...variable("A"), outcomes: [] }],
        definitions: [definition("A")],
      },
      "NATURE_WITHOUT_OUTCOMES",
    ],
    [
      "decision node without outcomes",
      { variables: [{ ...variable("Choice", "decision"), outcomes: [] }] },
      "DECISION_WITHOUT_OUTCOMES",
    ],
    [
      "utility node with outcomes",
      {
        variables: [{ ...variable("Value", "utility"), outcomes: ["invalid"] }],
      },
      "UTILITY_WITH_OUTCOMES",
    ],
    [
      "duplicate definition",
      {
        variables: [variable("A")],
        definitions: [definition("A"), definition("A")],
      },
      "DUPLICATE_DEFINITION",
    ],
    [
      "unknown definition target",
      { definitions: [definition("Missing")] },
      "UNKNOWN_DEFINITION_TARGET",
    ],
    [
      "unknown parent",
      {
        variables: [variable("A")],
        definitions: [definition("A", ["Missing"])],
      },
      "UNKNOWN_PARENT",
    ],
    [
      "duplicate parent",
      {
        variables: [variable("A"), variable("B")],
        definitions: [definition("A"), definition("B", ["A", "A"])],
      },
      "DUPLICATE_PARENT",
    ],
    [
      "self-parent",
      {
        variables: [variable("A")],
        definitions: [definition("A", ["A"])],
      },
      "SELF_PARENT",
    ],
    [
      "utility parent",
      {
        variables: [variable("Value", "utility"), variable("A")],
        definitions: [definition("A", ["Value"])],
      },
      "UTILITY_CANNOT_BE_PARENT",
    ],
    [
      "duplicate edge",
      {
        variables: [variable("A"), variable("B")],
        definitions: [definition("A"), definition("B", ["A", "A"])],
      },
      "DUPLICATE_EDGE",
    ],
    [
      "missing nature definition",
      { variables: [variable("A")] },
      "MISSING_NATURE_DEFINITION",
    ],
  ])("reports stable code for %s", (_name, network, expectedCode) => {
    expect(codes(fileWith(network))).toContain(expectedCode);
  });

  it("detects A -> B -> C -> A", () => {
    const file = fileWith({
      variables: [variable("A"), variable("B"), variable("C")],
      definitions: [
        definition("A", ["C"]),
        definition("B", ["A"]),
        definition("C", ["B"]),
      ],
    });

    expect(codes(file)).toContain("GRAPH_CYCLE");
  });

  it("allows an imported root decision without a definition", () => {
    expect(
      validateStructure(
        fileWith({ variables: [variable("Choice", "decision")] }),
      ),
    ).toEqual([]);
  });

  it("warns for duplicate outcomes without blocking the model", () => {
    const diagnostics = validateStructure(
      fileWith({
        variables: [{ ...variable("A"), outcomes: ["same", "same"] }],
        definitions: [definition("A")],
      }),
    );

    expect(diagnostics).toMatchObject([
      { code: "DUPLICATE_OUTCOME", severity: "warning" },
    ]);
    expect(hasBlockingStructuralErrors(diagnostics)).toBe(false);
  });

  it("preserves a legacy identifier with a non-blocking warning", () => {
    const diagnostics = validateStructure(
      fileWith({
        variables: [variable("Legacy name")],
        definitions: [definition("Legacy name")],
      }),
    );

    expect(diagnostics).toMatchObject([
      {
        code: "LEGACY_IDENTIFIER",
        severity: "warning",
        category: "compatibility",
      },
    ]);
    expect(hasBlockingStructuralErrors(diagnostics)).toBe(false);
  });

  it("classifies only structural and reference errors as blocking", () => {
    expect(
      hasBlockingStructuralErrors([
        {
          code: "BAD_PROBABILITY",
          severity: "error",
          category: "probability",
          message: "Not part of structural validation",
        },
      ]),
    ).toBe(false);
    expect(
      hasBlockingStructuralErrors([
        {
          code: "UNKNOWN_PARENT",
          severity: "error",
          category: "reference",
          message: "Missing parent",
        },
      ]),
    ).toBe(true);
  });
});
