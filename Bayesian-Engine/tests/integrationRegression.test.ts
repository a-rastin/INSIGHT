import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { detectXmlFidelityRisks } from "../src/domain/fidelity";
import {
  addNatureVariable,
  addOutcome,
  addParent,
  removeParent,
  renameNetwork,
  reorderOutcomes,
  setRawTableRow,
} from "../src/domain/mutations";
import { parseXmlBif } from "../src/domain/parser";
import { serializeXmlBif } from "../src/domain/serializer";
import { validateFile } from "../src/domain/validator";
import { useDocumentStore } from "../src/store/documentStore";

const fixture = (name: string) =>
  readFileSync(resolve("tests/fixtures/xml", name), "utf8");

function parsedFixture(name: string) {
  const parsed = parseXmlBif(fixture(name));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(`Fixture did not parse: ${name}`);
  return parsed.file;
}

function successful<T extends { ok: boolean }>(
  result: T,
): asserts result is T & { ok: true } {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected successful mutation");
}

describe("checked-in XMLBIF regression fixtures", () => {
  it.each([
    "root-node.xml",
    "one-parent.xml",
    "two-parent-nonbinary.xml",
    "properties-positions.xml",
    "multi-network.xml",
    "decision-utility.xml",
    "fidelity-warning.xml",
  ])("loads %s without blocking errors", (name) => {
    const file = parsedFixture(name);
    expect(
      validateFile(file).filter(({ severity }) => severity === "error"),
    ).toEqual([]);
  });

  it("classifies malformed, structural, probability, and fidelity cases", () => {
    expect(parseXmlBif(fixture("malformed.xml"))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "XML_MALFORMED" }],
    });

    const structural = parsedFixture("structurally-invalid.xml");
    const structuralCodes = validateFile(structural).map(({ code }) => code);
    expect(structuralCodes).toEqual(
      expect.arrayContaining(["UNKNOWN_PARENT", "GRAPH_CYCLE"]),
    );

    const probability = parsedFixture("semantically-invalid.xml");
    expect(validateFile(probability)).toMatchObject([
      { code: "CPT_DISTRIBUTION_NOT_NORMALIZED" },
    ]);

    expect(
      detectXmlFidelityRisks(fixture("fidelity-warning.xml")).map(
        ({ code }) => code,
      ),
    ).toEqual(expect.arrayContaining(["XML_COMMENT", "XML_DOCTYPE"]));
  });
});

describe("cross-layer workflow regressions", () => {
  beforeEach(() => useDocumentStore.getState().resetDocument());

  it("preserves exact non-binary CPT axis order through transforms and reopen", () => {
    let network = parsedFixture("two-parent-nonbinary.xml").networks[0];

    const parentReorder = reorderOutcomes(network, "Season", [2, 0, 1]);
    successful(parentReorder);
    network = parentReorder.value;
    expect(network.definitions[2].table).toEqual([
      0.3, 0.4, 0.3, 0.1, 0.7, 0.2, 0.2, 0.5, 0.3, 0.6, 0.3, 0.1, 0.4, 0.2, 0.4,
      0.5, 0.1, 0.4,
    ]);

    const childReorder = reorderOutcomes(network, "Activity", [2, 0, 1]);
    successful(childReorder);
    network = childReorder.value;
    expect(network.definitions[2].table).toEqual([
      0.3, 0.3, 0.4, 0.2, 0.1, 0.7, 0.3, 0.2, 0.5, 0.1, 0.6, 0.3, 0.4, 0.4, 0.2,
      0.4, 0.5, 0.1,
    ]);

    const removed = removeParent(network, "Activity", "Season");
    successful(removed);
    expect(removed.warnings).toMatchObject([
      { code: "CPT_RESET_PARENT_REMOVAL" },
    ]);
    const restored = addParent(removed.value, "Activity", "Season");
    successful(restored);

    const source = serializeXmlBif({
      version: "0.3",
      networks: [restored.value],
    });
    const reopened = parseXmlBif(source);
    successful(reopened);
    const definition = reopened.file.networks[0].definitions[2];
    expect(definition.given).toEqual(["Weather", "Season"]);
    expect(definition.table).toEqual(Array(18).fill(1 / 3));
    expect(
      validateFile(reopened.file).filter(
        ({ severity }) => severity === "error",
      ),
    ).toEqual([]);
  });

  it("adds three nodes and two arcs, rejects a cycle, and reopens valid dimensions", () => {
    let network = useDocumentStore.getState().model!.networks[0];
    for (const name of ["Node1", "Node2", "Node3"]) {
      const added = addNatureVariable(network, name);
      successful(added);
      network = added.value;
    }
    const firstArc = addParent(network, "Node2", "Node1");
    successful(firstArc);
    const secondArc = addParent(firstArc.value, "Node3", "Node2");
    successful(secondArc);
    expect(addParent(secondArc.value, "Node1", "Node3")).toMatchObject({
      ok: false,
      diagnostics: [{ code: "GRAPH_CYCLE" }],
    });
    const outcome = addOutcome(secondArc.value, "Node2", "State2");
    successful(outcome);

    const source = serializeXmlBif({
      version: "0.3",
      networks: [outcome.value],
    });
    const reopened = parseXmlBif(source);
    successful(reopened);
    expect(
      reopened.file.networks[0].definitions.map(({ given, table }) => [
        given,
        table.length,
      ]),
    ).toEqual([
      [[], 2],
      [["Node1"], 6],
      [["Node2"], 6],
    ]);
    expect(
      validateFile(reopened.file).filter(
        ({ severity }) => severity === "error",
      ),
    ).toEqual([]);
  });

  it("edits only the active network and preserves inactive network source semantics", () => {
    const source = fixture("multi-network.xml");
    expect(useDocumentStore.getState().loadSource(source)).toEqual({
      ok: true,
    });
    const firstBefore = structuredClone(
      useDocumentStore.getState().model!.networks[0],
    );
    expect(useDocumentStore.getState().setActiveNetworkIndex(1)).toEqual({
      ok: true,
    });
    expect(
      useDocumentStore
        .getState()
        .applyDomainMutation((network) =>
          renameNetwork(network, "RenamedSecond"),
        ),
    ).toEqual({ ok: true });

    const state = useDocumentStore.getState();
    expect(state.model!.networks[0]).toEqual(firstBefore);
    expect(state.model!.networks[1].name).toBe("RenamedSecond");
    const reopened = parseXmlBif(state.sourceText);
    successful(reopened);
    expect(reopened.file.networks.map(({ name }) => name)).toEqual([
      "First",
      "RenamedSecond",
    ]);
  });

  it("edits and reopens ordered influence-diagram tables without normalization", () => {
    const file = parsedFixture("decision-utility.xml");
    expect(
      useDocumentStore.getState().loadSource(serializeXmlBif(file)),
    ).toEqual({
      ok: true,
    });

    expect(
      useDocumentStore
        .getState()
        .applyDomainMutation((network) =>
          setRawTableRow(network, "Choice", [1, 2], [-9, 12]),
        ),
    ).toEqual({ ok: true });
    expect(
      useDocumentStore
        .getState()
        .applyDomainMutation((network) =>
          setRawTableRow(network, "Value", [1, 0], [-25]),
        ),
    ).toEqual({ ok: true });

    const editedModel = useDocumentStore.getState().model;
    const savedSource = useDocumentStore.getState().sourceText;
    expect(editedModel?.networks[0].definitions[2].table).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, -9, 12,
    ]);
    expect(editedModel?.networks[0].definitions[3].table).toEqual([
      10, -2, -25, -4,
    ]);
    expect(useDocumentStore.getState().loadSource(savedSource)).toEqual({
      ok: true,
    });
    expect(useDocumentStore.getState().model).toEqual(editedModel);
  });
});
