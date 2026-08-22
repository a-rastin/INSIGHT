import { describe, expect, it } from "vitest";
import {
  cardinality,
  edgesOf,
  expectedTableLength,
  findDefinition,
  findVariable,
  formatPositionProperty,
  parentConfigurationCount,
  parentsOf,
  parsePositionProperty,
  tableAxisCardinalities,
  tableAxisNames,
} from "../src/domain/model";
import {
  decisionUtilityFile,
  multiParentFile,
  propertiesFile,
  rainRootFile,
  rainWetGrassFile,
} from "./fixtures/domainFixtures";

describe("XMLBIF domain queries", () => {
  it("preserves ordered outcomes as arrays", () => {
    const network = rainRootFile.networks[0];

    expect(findVariable(network, "Rain")?.outcomes).toEqual(["true", "false"]);
    expect(Array.isArray(findVariable(network, "Rain")?.outcomes)).toBe(true);
    expect(cardinality(network, "Rain")).toBe(2);
  });

  it("derives ordered parents and parent-to-child edges from definitions", () => {
    const network = multiParentFile.networks[0];

    expect(parentsOf(network, "Activity")).toEqual(["Weather", "Season"]);
    expect(edgesOf(network)).toEqual([
      { source: "Weather", target: "Activity" },
      { source: "Season", target: "Activity" },
    ]);
  });

  it("calculates non-binary parent configurations and table length", () => {
    const network = multiParentFile.networks[0];
    const definition = findDefinition(network, "Activity");

    expect(definition).toBeDefined();
    expect(parentConfigurationCount(network, definition!)).toBe(6);
    expect(tableAxisNames(network, definition!)).toEqual([
      "Weather",
      "Season",
      "Activity",
    ]);
    expect(tableAxisCardinalities(network, definition!)).toEqual([2, 3, 3]);
    expect(expectedTableLength(network, definition!)).toBe(18);
  });

  it("uses parent-only axes for utility tables", () => {
    const network = decisionUtilityFile.networks[0];
    const definition = findDefinition(network, "Value");

    expect(definition).toBeDefined();
    expect(tableAxisNames(network, definition!)).toEqual(["Choice"]);
    expect(tableAxisCardinalities(network, definition!)).toEqual([2]);
    expect(expectedTableLength(network, definition!)).toBe(2);
    expect(
      expectedTableLength(network, {
        for: "Value",
        given: [],
        table: [0],
        properties: [],
      }),
    ).toBe(1);
  });

  it("uses parent and child axes for decision tables", () => {
    const network = structuredClone(decisionUtilityFile.networks[0]);
    network.variables.unshift({
      name: "Context",
      type: "nature",
      outcomes: ["low", "medium", "high"],
      properties: [],
    });
    const definition = {
      for: "Choice",
      given: ["Context"],
      table: [0, 0, 0, 0, 0, 0],
      properties: [],
    };

    expect(tableAxisNames(network, definition)).toEqual(["Context", "Choice"]);
    expect(tableAxisCardinalities(network, definition)).toEqual([3, 2]);
    expect(expectedTableLength(network, definition)).toBe(6);
  });

  it("handles root and one-parent definitions", () => {
    const rootNetwork = rainRootFile.networks[0];
    const rootDefinition = rootNetwork.definitions[0];
    const childNetwork = rainWetGrassFile.networks[0];
    const childDefinition = findDefinition(childNetwork, "WetGrass");

    expect(parentConfigurationCount(rootNetwork, rootDefinition)).toBe(1);
    expect(expectedTableLength(rootNetwork, rootDefinition)).toBe(2);
    expect(expectedTableLength(childNetwork, childDefinition!)).toBe(4);
  });

  it("returns undefined when table dimensions cannot resolve references", () => {
    const network = rainRootFile.networks[0];

    expect(cardinality(network, "Missing")).toBeUndefined();
    expect(
      expectedTableLength(network, {
        for: "Rain",
        given: ["Missing"],
        table: [],
        properties: [],
      }),
    ).toBeUndefined();
  });
});

describe("position properties", () => {
  it("parses only complete position hints", () => {
    expect(parsePositionProperty("  position = ( -73.5, +165.25 ) ")).toEqual({
      x: -73.5,
      y: 165.25,
    });
    expect(parsePositionProperty("position=(.5, 1e2)")).toEqual({
      x: 0.5,
      y: 100,
    });
    expect(parsePositionProperty("custom position = (1, 2)")).toBeNull();
    expect(parsePositionProperty("color = blue")).toBeNull();
  });

  it("formats generated positions deterministically", () => {
    expect(formatPositionProperty({ x: 100, y: 200.5 })).toBe(
      "position = (100, 200.5)",
    );
    expect(() => formatPositionProperty({ x: Infinity, y: 0 })).toThrow(
      RangeError,
    );
  });
});

describe("reusable fixtures", () => {
  it("covers properties, decision, and utility content", () => {
    expect(
      propertiesFile.networks[0].properties.map(({ text }) => text),
    ).toEqual(["author = Ada", "unstructured text"]);
    expect(
      decisionUtilityFile.networks[0].variables.map(({ type }) => type),
    ).toEqual(["decision", "utility"]);
  });
});
