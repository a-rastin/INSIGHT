import { beforeEach, describe, expect, it } from "vitest";
import {
  removeParent,
  renameVariable,
  setRawTableRow,
} from "../src/domain/mutations";
import { serializeXmlBif } from "../src/domain/serializer";
import { useDocumentStore } from "../src/store/documentStore";
import {
  decisionUtilityFile,
  rainRootFile,
  rainWetGrassFile,
} from "./fixtures/domainFixtures";

describe("document store", () => {
  beforeEach(() => useDocumentStore.getState().resetDocument());

  it("creates a valid clean default document", () => {
    const state = useDocumentStore.getState();

    expect(state.model).toEqual({
      version: "0.3",
      networks: [
        {
          name: "NewNetwork",
          properties: [],
          variables: [],
          definitions: [],
        },
      ],
    });
    expect(state.sourceText).toContain("<NAME>NewNetwork</NAME>");
    expect(state.diagnostics).toEqual([]);
    expect(state.sync).toBe("synced");
    expect(state.dirty).toBe(false);
  });

  it("loads valid source exactly with path and clean state", () => {
    const source = serializeXmlBif(rainRootFile);

    expect(
      useDocumentStore.getState().loadSource(source, "/tmp/rain.xml"),
    ).toEqual({ ok: true });
    const state = useDocumentStore.getState();
    expect(state.sourceText).toBe(source);
    expect(state.model).toEqual(rainRootFile);
    expect(state.path).toBe("/tmp/rain.xml");
    expect(state.dirty).toBe(false);
    expect(state.sync).toBe("synced");
  });

  it("keeps existing document atomic when source cannot load", () => {
    const before = useDocumentStore.getState();
    const result = before.loadSource("<not-xmlbif>", "/tmp/broken.xml");

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: "XML_MALFORMED" }],
    });
    const after = useDocumentStore.getState();
    expect(after.sourceText).toBe(before.sourceText);
    expect(after.model).toBe(before.model);
    expect(after.path).toBe(before.path);
  });

  it("keeps existing document atomic on blocking structural errors", () => {
    const source = serializeXmlBif(rainRootFile).replace(
      "<FOR>Rain</FOR>",
      "<FOR>Missing</FOR>",
    );
    const before = useDocumentStore.getState();

    const result = before.loadSource(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map(({ code }) => code)).toContain(
        "UNKNOWN_DEFINITION_TARGET",
      );
    }
    expect(useDocumentStore.getState().model).toBe(before.model);
  });

  it("loads structurally usable source with probability diagnostics", () => {
    const source = serializeXmlBif(rainRootFile).replace(
      "<TABLE>0.2 0.8</TABLE>",
      "<TABLE>0.2 0.7</TABLE>",
    );

    expect(useDocumentStore.getState().loadSource(source)).toEqual({
      ok: true,
    });
    expect(useDocumentStore.getState().diagnostics).toMatchObject([
      { code: "CPT_DISTRIBUTION_NOT_NORMALIZED" },
    ]);
  });

  it("requires one acknowledgment before lossy canonicalization", () => {
    const source = serializeXmlBif(rainRootFile).replace(
      "<NETWORK>",
      "<NETWORK><!-- preserve this comment -->",
    );
    useDocumentStore.getState().loadSource(source);
    const before = useDocumentStore.getState();

    expect(
      before.applyDomainMutation((network) =>
        renameVariable(network, "Rain", "Storm"),
      ),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "CANONICALIZATION_CONFIRMATION_REQUIRED" }],
    });
    expect(useDocumentStore.getState()).toMatchObject({
      sourceText: source,
      dirty: false,
    });

    useDocumentStore.getState().acknowledgeCanonicalization();
    expect(
      useDocumentStore
        .getState()
        .applyDomainMutation((network) =>
          renameVariable(network, "Rain", "Storm"),
        ),
    ).toEqual({ ok: true });
    expect(useDocumentStore.getState().sourceText).not.toContain("comment");
    expect(useDocumentStore.getState().fidelityRisks).toEqual([]);
  });

  it("resets canonicalization acknowledgment after synchronized code changes", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainRootFile));
    useDocumentStore.getState().acknowledgeCanonicalization();
    const source = serializeXmlBif(rainRootFile).replace(
      "<NETWORK>",
      "<NETWORK><UNKNOWN />",
    );
    const version = useDocumentStore.getState().setCodeDraft(source);
    useDocumentStore.getState().synchronizeCodeDraft(version);

    expect(useDocumentStore.getState()).toMatchObject({
      sync: "synced",
      canonicalizationAcknowledged: false,
      fidelityRisks: [{ code: "UNKNOWN_XML_ELEMENT" }],
    });
  });

  it("applies a domain mutation, serializes it, and marks dirty", () => {
    useDocumentStore
      .getState()
      .loadSource(serializeXmlBif(rainWetGrassFile), "/tmp/network.xml");

    const result = useDocumentStore
      .getState()
      .applyDomainMutation((network) =>
        renameVariable(network, "Rain", "Rainfall"),
      );

    expect(result).toEqual({ ok: true });
    const state = useDocumentStore.getState();
    expect(state.model?.networks[0].definitions[1].given).toEqual(["Rainfall"]);
    expect(state.sourceText).toContain("<NAME>Rainfall</NAME>");
    expect(state.sourceText).toContain("<GIVEN>Rainfall</GIVEN>");
    expect(state.sync).toBe("synced");
    expect(state.dirty).toBe(true);
  });

  it("preserves decision and utility content during unrelated nature edits", () => {
    const file = structuredClone(decisionUtilityFile);
    file.networks[0].variables.unshift(rainRootFile.networks[0].variables[0]);
    file.networks[0].definitions.unshift(
      rainRootFile.networks[0].definitions[0],
    );
    useDocumentStore.getState().loadSource(serializeXmlBif(file));

    expect(
      useDocumentStore
        .getState()
        .applyDomainMutation((network) =>
          renameVariable(network, "Rain", "Weather"),
        ),
    ).toEqual({ ok: true });
    const network = useDocumentStore.getState().model!.networks[0];
    expect(network.variables.slice(1)).toEqual(
      decisionUtilityFile.networks[0].variables,
    );
    expect(network.definitions[1]).toEqual(
      decisionUtilityFile.networks[0].definitions[0],
    );
  });

  it("keeps model and source unchanged when mutation is rejected", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainWetGrassFile));
    const before = useDocumentStore.getState();

    const result = before.applyDomainMutation((network) =>
      renameVariable(network, "Rain", "WetGrass"),
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: "DUPLICATE_VARIABLE_NAME" }],
    });
    const after = useDocumentStore.getState();
    expect(after.model).toBe(before.model);
    expect(after.sourceText).toBe(before.sourceText);
    expect(after.dirty).toBe(false);
  });

  it("keeps exact invalid code and last usable graph model", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainRootFile));
    const previousModel = useDocumentStore.getState().model;
    const invalidSource = "<BIF><broken></BIF>";

    const version = useDocumentStore.getState().setCodeDraft(invalidSource);
    useDocumentStore.getState().synchronizeCodeDraft(version);

    const state = useDocumentStore.getState();
    expect(state.sourceText).toBe(invalidSource);
    expect(state.model).toBe(previousModel);
    expect(state.sync).toBe("code-invalid");
    expect(state.dirty).toBe(true);
    expect(state.diagnostics[0].code).toBe("XML_MALFORMED");
  });

  it("updates the graph model from structurally usable code despite probability errors", () => {
    const source = serializeXmlBif(rainRootFile)
      .replaceAll("Rain", "Storm")
      .replace("<TABLE>0.2 0.8</TABLE>", "<TABLE>0.2 0.7</TABLE>");

    const version = useDocumentStore.getState().setCodeDraft(source);
    useDocumentStore.getState().synchronizeCodeDraft(version);

    const state = useDocumentStore.getState();
    expect(state.model?.networks[0].variables[0].name).toBe("Storm");
    expect(state.diagnostics.map(({ code }) => code)).toContain(
      "CPT_DISTRIBUTION_NOT_NORMALIZED",
    );
    expect(state.sync).toBe("synced");
  });

  it("blocks visual edits until invalid code is fixed", () => {
    const invalidVersion = useDocumentStore
      .getState()
      .setCodeDraft("<BIF><broken></BIF>");
    useDocumentStore.getState().synchronizeCodeDraft(invalidVersion);

    expect(
      useDocumentStore
        .getState()
        .applyDomainMutation((network) =>
          renameVariable(network, "Rain", "Storm"),
        ),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "CODE_NOT_SYNCHRONIZED" }],
    });

    const validSource = serializeXmlBif(rainRootFile);
    const validVersion = useDocumentStore.getState().setCodeDraft(validSource);
    useDocumentStore.getState().synchronizeCodeDraft(validVersion);
    expect(useDocumentStore.getState().sync).toBe("synced");
  });

  it("ignores stale code synchronization results", () => {
    const staleVersion = useDocumentStore
      .getState()
      .setCodeDraft(serializeXmlBif(rainRootFile));
    const latestSource = "<BIF><latest></BIF>";
    const latestVersion = useDocumentStore
      .getState()
      .setCodeDraft(latestSource);

    useDocumentStore.getState().synchronizeCodeDraft(staleVersion);
    expect(useDocumentStore.getState()).toMatchObject({
      sourceText: latestSource,
      sync: "code-invalid",
    });

    useDocumentStore.getState().synchronizeCodeDraft(latestVersion);
    expect(useDocumentStore.getState().diagnostics[0].code).toBe(
      "XML_MALFORMED",
    );
  });

  it("regenerates deterministic XML after a valid code edit", () => {
    const source = serializeXmlBif(rainRootFile);
    const version = useDocumentStore.getState().setCodeDraft(source);
    useDocumentStore.getState().synchronizeCodeDraft(version);

    expect(
      useDocumentStore
        .getState()
        .applyDomainMutation((network) =>
          renameVariable(network, "Rain", "Storm"),
        ),
    ).toEqual({ ok: true });
    const state = useDocumentStore.getState();
    expect(state.sourceText).toBe(serializeXmlBif(state.model!));
    expect(state.sync).toBe("synced");
  });

  it("undoes and redoes visual edits as exact source snapshots", () => {
    const source = serializeXmlBif(rainRootFile);
    useDocumentStore.getState().loadSource(source);
    useDocumentStore.getState().setSelectedNode("Rain");
    useDocumentStore
      .getState()
      .applyDomainMutation((network) =>
        renameVariable(network, "Rain", "Storm"),
      );
    useDocumentStore.getState().setSelectedNode("Storm");
    const editedSource = useDocumentStore.getState().sourceText;

    expect(useDocumentStore.getState().undo()).toBe(true);
    expect(useDocumentStore.getState().sourceText).toBe(source);
    expect(useDocumentStore.getState().model).toEqual(rainRootFile);
    expect(useDocumentStore.getState().dirty).toBe(false);
    expect(useDocumentStore.getState().selectedNode).toBe("Rain");

    expect(useDocumentStore.getState().redo()).toBe(true);
    expect(useDocumentStore.getState().sourceText).toBe(editedSource);
    expect(
      useDocumentStore.getState().model?.networks[0].variables[0].name,
    ).toBe("Storm");
    expect(useDocumentStore.getState().dirty).toBe(true);
    expect(useDocumentStore.getState().selectedNode).toBe("Storm");
  });

  it("undoes and redoes raw edits and confirmed zero resets", () => {
    const file = structuredClone(decisionUtilityFile);
    file.networks[0].definitions.unshift({
      for: "Choice",
      given: [],
      table: [0, 2],
      properties: [],
    });
    useDocumentStore.getState().loadSource(serializeXmlBif(file));

    expect(
      useDocumentStore
        .getState()
        .applyDomainMutation((network) =>
          setRawTableRow(network, "Choice", [], [-3, 8]),
        ),
    ).toEqual({ ok: true });
    expect(useDocumentStore.getState().undo()).toBe(true);
    expect(
      useDocumentStore.getState().model?.networks[0].definitions[0].table,
    ).toEqual([0, 2]);
    expect(useDocumentStore.getState().redo()).toBe(true);
    expect(
      useDocumentStore.getState().model?.networks[0].definitions[0].table,
    ).toEqual([-3, 8]);

    expect(
      useDocumentStore
        .getState()
        .applyDomainMutation((network) =>
          removeParent(network, "Value", "Choice", { allowDataLoss: true }),
        ),
    ).toEqual({ ok: true });
    expect(
      useDocumentStore.getState().model?.networks[0].definitions[1],
    ).toMatchObject({ given: [], table: [0] });
    expect(useDocumentStore.getState().undo()).toBe(true);
    expect(
      useDocumentStore.getState().model?.networks[0].definitions[1],
    ).toMatchObject({ given: ["Choice"], table: [10, -2] });
    expect(useDocumentStore.getState().redo()).toBe(true);
    expect(
      useDocumentStore.getState().model?.networks[0].definitions[1],
    ).toMatchObject({ given: [], table: [0] });
  });

  it("clears dirty when undo returns to the saved source", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainRootFile));
    useDocumentStore
      .getState()
      .applyDomainMutation((network) =>
        renameVariable(network, "Rain", "Storm"),
      );
    useDocumentStore.getState().markSaved();
    useDocumentStore
      .getState()
      .applyDomainMutation((network) =>
        renameVariable(network, "Storm", "Cloud"),
      );

    expect(useDocumentStore.getState().undo()).toBe(true);
    expect(useDocumentStore.getState()).toMatchObject({ dirty: false });
    expect(
      useDocumentStore.getState().model?.networks[0].variables[0].name,
    ).toBe("Storm");
  });

  it("rebases visual history after valid code synchronization", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainRootFile));
    useDocumentStore
      .getState()
      .applyDomainMutation((network) =>
        renameVariable(network, "Rain", "Storm"),
      );
    const code = serializeXmlBif(rainWetGrassFile);
    const version = useDocumentStore.getState().setCodeDraft(code);
    useDocumentStore.getState().synchronizeCodeDraft(version);

    expect(useDocumentStore.getState().historyPast).toEqual([]);
    expect(useDocumentStore.getState().undo()).toBe(false);
    expect(useDocumentStore.getState().sourceText).toBe(code);
  });

  it("does not publish duplicate graph selection updates", () => {
    useDocumentStore.getState().setSelectedNode("Rain");
    const nodeState = useDocumentStore.getState();
    useDocumentStore.getState().setSelectedNode("Rain");
    expect(useDocumentStore.getState()).toBe(nodeState);

    useDocumentStore
      .getState()
      .setSelectedEdge({ source: "Rain", target: "WetGrass" });
    const edgeState = useDocumentStore.getState();
    useDocumentStore
      .getState()
      .setSelectedEdge({ source: "Rain", target: "WetGrass" });
    expect(useDocumentStore.getState()).toBe(edgeState);
  });

  it("marks saved while retaining or replacing path", () => {
    useDocumentStore
      .getState()
      .loadSource(serializeXmlBif(rainRootFile), "/tmp/old.xml");
    useDocumentStore
      .getState()
      .applyDomainMutation((network) =>
        renameVariable(network, "Rain", "Rainfall"),
      );

    useDocumentStore.getState().markSaved();
    expect(useDocumentStore.getState()).toMatchObject({
      path: "/tmp/old.xml",
      dirty: false,
    });

    useDocumentStore.getState().markSaved("/tmp/new.xml");
    expect(useDocumentStore.getState().path).toBe("/tmp/new.xml");
  });

  it("adds a uniquely named network without changing existing networks", () => {
    const first = rainRootFile.networks[0];
    useDocumentStore.getState().loadSource(
      serializeXmlBif({
        version: "0.3",
        networks: [first, { ...first, name: "Network1" }],
      }),
    );

    expect(useDocumentStore.getState().addNetwork()).toEqual({ ok: true });
    const state = useDocumentStore.getState();
    expect(state.model?.networks.map(({ name }) => name)).toEqual([
      first.name,
      "Network1",
      "Network2",
    ]);
    expect(state.model?.networks[0]).toEqual(first);
    expect(state.model?.networks[2]).toMatchObject({
      variables: [],
      definitions: [],
    });
    expect(state.activeNetworkIndex).toBe(2);
    expect(state.dirty).toBe(true);
    expect(state.sourceText.match(/<NETWORK>/g)).toHaveLength(3);
  });

  it("deletes the active non-last network and adjusts its index", () => {
    const first = rainRootFile.networks[0];
    useDocumentStore.getState().loadSource(
      serializeXmlBif({
        version: "0.3",
        networks: [
          first,
          { ...first, name: "Second" },
          { ...first, name: "Third" },
        ],
      }),
    );
    useDocumentStore.getState().setActiveNetworkIndex(2);

    expect(useDocumentStore.getState().deleteActiveNetwork()).toEqual({
      ok: true,
    });
    const state = useDocumentStore.getState();
    expect(state.model?.networks.map(({ name }) => name)).toEqual([
      first.name,
      "Second",
    ]);
    expect(state.activeNetworkIndex).toBe(1);
    expect(state.sourceText).not.toContain("<NAME>Third</NAME>");
  });

  it("blocks deleting the last network", () => {
    const before = useDocumentStore.getState();

    expect(before.deleteActiveNetwork()).toMatchObject({
      ok: false,
      diagnostics: [{ code: "LAST_NETWORK_REQUIRED" }],
    });
    expect(useDocumentStore.getState().model).toBe(before.model);
  });

  it("checks active network index bounds", () => {
    const file = {
      ...rainRootFile,
      networks: [
        rainRootFile.networks[0],
        { ...rainRootFile.networks[0], name: "Second" },
      ],
    };
    useDocumentStore.getState().loadSource(serializeXmlBif(file));

    expect(useDocumentStore.getState().setActiveNetworkIndex(1)).toEqual({
      ok: true,
    });
    expect(useDocumentStore.getState().activeNetworkIndex).toBe(1);
    expect(useDocumentStore.getState().setActiveNetworkIndex(2)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "ACTIVE_NETWORK_OUT_OF_BOUNDS" }],
    });
    expect(
      useDocumentStore.getState().setActiveNetworkIndex(0.5),
    ).toMatchObject({
      ok: false,
    });
    expect(useDocumentStore.getState().activeNetworkIndex).toBe(1);
  });
});
