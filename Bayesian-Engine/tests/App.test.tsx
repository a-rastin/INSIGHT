import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePositionProperty } from "../src/domain/model";
import type { BayesEngineApi } from "../src/preload/api";
import { parseXmlBif } from "../src/domain/parser";
import { App } from "../src/renderer/App";
import { serializeXmlBif } from "../src/domain/serializer";
import { useDocumentStore } from "../src/store/documentStore";
import {
  propertiesFile,
  rainRootFile,
  rainWetGrassFile,
} from "./fixtures/domainFixtures";

const { reactFlowRenders } = vi.hoisted(() => ({
  reactFlowRenders: [] as Record<string, unknown>[],
}));

vi.mock("@xyflow/react", () => ({
  applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
  Background: () => null,
  ReactFlowProvider: ({ children }: PropsWithChildren) => children,
  SelectionMode: { Partial: "partial" },
  useReactFlow: () => ({
    fitView: vi.fn(),
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({
      x: x - 10,
      y: y - 20,
    }),
  }),
  ReactFlow: (props: Record<string, unknown>) => {
    reactFlowRenders.push(props);
    const nodes = props.nodes as Array<{
      id: string;
      position: { x: number; y: number };
    }>;
    const edges = props.edges as Array<{
      id: string;
      source: string;
      target: string;
    }>;
    const onPaneClick = props.onPaneClick as (event: {
      clientX: number;
      clientY: number;
    }) => void;
    const onConnect = props.onConnect as (connection: {
      source: string;
      target: string;
    }) => void;
    const isValidConnection = props.isValidConnection as (connection: {
      source: string;
      target: string;
    }) => boolean;
    const onNodeClick = props.onNodeClick as (
      event: unknown,
      node: (typeof nodes)[number],
    ) => void;
    const onNodeDragStop = props.onNodeDragStop as (
      event: unknown,
      node: (typeof nodes)[number],
    ) => void;
    const onEdgeClick = props.onEdgeClick as (
      event: unknown,
      edge: (typeof edges)[number],
    ) => void;

    return (
      <div aria-label="Network graph">
        <button
          type="button"
          onClick={() => onPaneClick({ clientX: 120, clientY: 80 })}
        >
          Canvas
        </button>
        {nodes.length > 1 && (
          <button
            type="button"
            onClick={() => {
              const connection = {
                source: nodes[0].id,
                target: nodes[1].id,
              };
              if (isValidConnection(connection)) onConnect(connection);
            }}
          >
            Connect {nodes[0].id} to {nodes[1].id}
          </button>
        )}
        {nodes.map((node) => (
          <span key={node.id}>
            <button type="button" onClick={() => onNodeClick({}, node)}>
              Select {node.id}
            </button>
            <button
              type="button"
              onClick={() =>
                onNodeDragStop(
                  {},
                  {
                    ...node,
                    position: {
                      x: node.position.x + 10,
                      y: node.position.y + 20,
                    },
                  },
                )
              }
            >
              Move {node.id}
            </button>
          </span>
        ))}
        {edges.map((edge) => (
          <button
            type="button"
            key={edge.id}
            onClick={() => onEdgeClick({}, edge)}
          >
            Select edge {edge.source} to {edge.target}
          </button>
        ))}
      </div>
    );
  },
}));

describe("App", () => {
  afterEach(cleanup);

  beforeEach(() => {
    reactFlowRenders.length = 0;
    useDocumentStore.getState().resetDocument();
    window.bayesEngine = {
      openXmlBifFile: vi.fn().mockResolvedValue({ canceled: true }),
      saveXmlBifFile: vi.fn().mockResolvedValue({ canceled: true }),
      confirmDiscardChanges: vi.fn().mockResolvedValue("cancel"),
      onCommand: vi.fn().mockReturnValue(() => undefined),
      onCloseRequested: vi.fn().mockReturnValue(() => undefined),
      closeWindow: vi.fn(),
    } satisfies BayesEngineApi;
  });

  it("shows the application title", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Bayes Engine" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Save As" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Select" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Add Node" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add Arc" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Fit" })).toBeVisible();
    expect(screen.getByText("No variables in this network")).toBeVisible();
  });

  it("hides the active-network selector for one network", () => {
    render(<App />);

    expect(screen.queryByLabelText("Active network")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Network name")).toHaveValue("NewNetwork");
  });

  it("switches between networks and clears the inactive inspector", () => {
    const second = {
      ...rainRootFile.networks[0],
      name: "Second",
      variables: [{ ...rainRootFile.networks[0].variables[0], name: "Storm" }],
      definitions: [
        { ...rainRootFile.networks[0].definitions[0], for: "Storm" },
      ],
    };
    useDocumentStore.getState().loadSource(
      serializeXmlBif({
        version: "0.3",
        networks: [rainRootFile.networks[0], second],
      }),
    );
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Select Rain" }));
    expect(screen.getByLabelText("Name / identifier")).toHaveValue("Rain");

    fireEvent.change(screen.getByLabelText("Active network"), {
      target: { value: "1" },
    });

    expect(screen.getByRole("button", { name: "Select Storm" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Select Rain" })).toBeNull();
    expect(screen.getByText("Select a node to inspect it.")).toBeVisible();
  });

  it("renames, adds, and deletes networks through serialized store edits", () => {
    render(<App />);

    const name = screen.getByLabelText("Network name");
    fireEvent.change(name, { target: { value: "Primary" } });
    fireEvent.keyDown(name, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Add network" }));

    expect(screen.getByLabelText("Active network")).toHaveValue("1");
    expect(
      useDocumentStore.getState().model?.networks.map(({ name }) => name),
    ).toEqual(["Primary", "Network1"]);

    fireEvent.click(screen.getByRole("button", { name: "Delete network" }));
    const state = useDocumentStore.getState();
    expect(state.model?.networks.map(({ name }) => name)).toEqual(["Primary"]);
    expect(state.sourceText).toContain("<NAME>Primary</NAME>");
    expect(state.sourceText.match(/<NETWORK>/g)).toHaveLength(1);
    expect(screen.queryByLabelText("Active network")).not.toBeInTheDocument();
  });

  it("confirms before deleting a network containing variables", () => {
    useDocumentStore.getState().loadSource(
      serializeXmlBif({
        version: "0.3",
        networks: [
          rainRootFile.networks[0],
          { ...rainRootFile.networks[0], name: "Second" },
        ],
      }),
    );
    useDocumentStore.getState().setActiveNetworkIndex(1);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Delete network" }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(useDocumentStore.getState().model?.networks).toHaveLength(2);
    confirm.mockRestore();
  });

  it("updates the selector when synchronized code changes network count", () => {
    render(<App />);
    const second = { ...rainRootFile.networks[0], name: "Second" };
    const twoNetworkSource = serializeXmlBif({
      version: "0.3",
      networks: [rainRootFile.networks[0], second],
    });

    act(() => {
      const version = useDocumentStore
        .getState()
        .setCodeDraft(twoNetworkSource);
      useDocumentStore.getState().synchronizeCodeDraft(version);
    });
    expect(screen.getByLabelText("Active network")).toBeVisible();
    expect(
      (screen.getByLabelText("Active network") as HTMLSelectElement).options,
    ).toHaveLength(2);

    act(() => {
      const version = useDocumentStore
        .getState()
        .setCodeDraft(serializeXmlBif(rainRootFile));
      useDocumentStore.getState().synchronizeCodeDraft(version);
    });
    expect(screen.queryByLabelText("Active network")).not.toBeInTheDocument();
  });

  it("shows stale graph but disables visual edits for invalid code", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainRootFile));
    const version = useDocumentStore
      .getState()
      .setCodeDraft("<BIF><broken></BIF>");
    useDocumentStore.getState().synchronizeCodeDraft(version);

    render(<App />);

    expect(
      screen.getByText("Graph not synchronized with XML code"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Select Rain" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add Node" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add Arc" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("shows file I/O failures", async () => {
    window.bayesEngine.openXmlBifFile = vi.fn().mockResolvedValue({
      canceled: false,
      error: "Permission denied",
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Permission denied"),
    );
  });

  it("confirms before first graphical edit that would lose source details", () => {
    const source = serializeXmlBif(rainRootFile).replace(
      "<NETWORK>",
      "<NETWORK><!-- source comment -->",
    );
    useDocumentStore.getState().loadSource(source);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));
    fireEvent.click(screen.getByRole("button", { name: "Canvas" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Continue?"));
    expect(useDocumentStore.getState().sourceText).toBe(source);
    expect(useDocumentStore.getState().dirty).toBe(false);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));
    fireEvent.click(screen.getByRole("button", { name: "Canvas" }));
    expect(useDocumentStore.getState().sourceText).not.toContain(
      "source comment",
    );
    confirm.mockRestore();
  });

  it("adds and selects a valid node at the converted canvas position", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));
    fireEvent.click(screen.getByRole("button", { name: "Canvas" }));

    const state = useDocumentStore.getState();
    const network = state.model?.networks[0];
    expect(network?.variables).toMatchObject([
      {
        name: "Node1",
        outcomes: ["State0", "State1"],
        properties: [{ text: "position = (110, 60)" }],
      },
    ]);
    expect(network?.definitions).toMatchObject([
      { for: "Node1", given: [], table: [0.5, 0.5] },
    ]);
    expect(state.dirty).toBe(true);
    expect(screen.getByText("Selected: Node1")).toBeVisible();
    expect(screen.getByRole("button", { name: "Select" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const parsed = parseXmlBif(state.sourceText);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.file.networks[0].variables[0].properties).toEqual([
        { text: "position = (110, 60)" },
      ]);
    }
  });

  it("creates selected decision and utility node types", () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("Node type"), {
      target: { value: "decision" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));
    fireEvent.click(screen.getByRole("button", { name: "Canvas" }));
    fireEvent.change(screen.getByLabelText("Node type"), {
      target: { value: "utility" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));
    fireEvent.click(screen.getByRole("button", { name: "Canvas" }));

    expect(useDocumentStore.getState().model?.networks[0]).toMatchObject({
      variables: [
        { name: "Node1", type: "decision", outcomes: ["State0", "State1"] },
        { name: "Node2", type: "utility", outcomes: [] },
      ],
      definitions: [
        { for: "Node1", table: [0, 0] },
        { for: "Node2", table: [0] },
      ],
    });
  });

  it("edits decision and utility values and hides utility outcomes", () => {
    useDocumentStore.getState().loadSource(
      serializeXmlBif({
        version: "0.3",
        networks: [
          {
            name: "Influence",
            properties: [],
            variables: [
              {
                name: "Choice",
                type: "decision",
                outcomes: ["go", "stay"],
                properties: [],
              },
              { name: "Value", type: "utility", outcomes: [], properties: [] },
            ],
            definitions: [
              { for: "Choice", given: [], table: [0, 2], properties: [] },
              {
                for: "Value",
                given: ["Choice"],
                table: [-2, 5],
                properties: [],
              },
            ],
          },
        ],
      }),
    );
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Select Choice" }));
    expect(
      screen.getByRole("heading", { name: "Decision values" }),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText("Root go"), {
      target: { value: "-3" },
    });
    fireEvent.blur(screen.getByLabelText("Root go"));
    expect(
      useDocumentStore.getState().model?.networks[0].definitions[0].table,
    ).toEqual([-3, 2]);

    fireEvent.click(screen.getByRole("button", { name: "Select Value" }));
    expect(
      screen.getByRole("heading", { name: "Utility values" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add outcome" })).toBeNull();
    fireEvent.change(screen.getByLabelText("go Value"), {
      target: { value: "12.5" },
    });
    fireEvent.blur(screen.getByLabelText("go Value"));
    expect(
      useDocumentStore.getState().model?.networks[0].definitions[1].table,
    ).toEqual([12.5, 5]);
  });

  it("rejects utility-source connections before domain mutation", () => {
    useDocumentStore.getState().loadSource(
      serializeXmlBif({
        version: "0.3",
        networks: [
          {
            name: "UtilitySink",
            properties: [],
            variables: [
              { name: "Value", type: "utility", outcomes: [], properties: [] },
              {
                name: "Choice",
                type: "decision",
                outcomes: ["yes", "no"],
                properties: [],
              },
            ],
            definitions: [
              { for: "Value", given: [], table: [0], properties: [] },
              { for: "Choice", given: [], table: [0, 0], properties: [] },
            ],
          },
        ],
      }),
    );
    render(<App />);
    const before = useDocumentStore.getState().model;

    fireEvent.click(screen.getByRole("button", { name: "Add Arc" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Connect Value to Choice" }),
    );

    expect(useDocumentStore.getState().model).toEqual(before);
    expect(reactFlowRenders.at(-1)?.isValidConnection).toEqual(
      expect.any(Function),
    );
  });

  it("confirms raw-table resets and commits one history entry", () => {
    useDocumentStore.getState().loadSource(
      serializeXmlBif({
        version: "0.3",
        networks: [
          {
            name: "Influence",
            properties: [],
            variables: [
              {
                name: "Choice",
                type: "decision",
                outcomes: ["go", "stay"],
                properties: [],
              },
              { name: "Value", type: "utility", outcomes: [], properties: [] },
            ],
            definitions: [
              { for: "Choice", given: [], table: [0, 0], properties: [] },
              {
                for: "Value",
                given: ["Choice"],
                table: [10, -2],
                properties: [],
              },
            ],
          },
        ],
      }),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);

    fireEvent.click(
      screen.getByRole("button", { name: "Select edge Choice to Value" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const state = useDocumentStore.getState();
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("reset raw table"),
    );
    expect(state.model?.networks[0].definitions[1]).toMatchObject({
      given: [],
      table: [0],
    });
    expect(state.historyPast).toHaveLength(1);
    confirm.mockRestore();
  });

  it("shows selected node details in inspector", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainRootFile));
    render(<App />);

    expect(screen.getByText("Select a node to inspect it.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Select Rain" }));

    expect(screen.getByLabelText("Type")).toHaveValue("nature");
    expect(screen.getByLabelText("Name / identifier")).toHaveValue("Rain");
    expect(screen.getByLabelText("Outcome 0")).toHaveValue("true");
    expect(screen.getByLabelText("Outcome 1")).toHaveValue("false");
    expect(screen.getByLabelText("Root P(true)")).toHaveValue("0.2");
    expect(screen.getByLabelText("Root P(false)")).toHaveValue("0.8");
  });

  it("renames a node through inspector and updates references and XML", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainWetGrassFile));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Select Rain" }));

    const name = screen.getByLabelText("Name / identifier");
    fireEvent.change(name, { target: { value: "Rainfall" } });
    fireEvent.keyDown(name, { key: "Enter" });

    const state = useDocumentStore.getState();
    expect(state.model?.networks[0].definitions).toMatchObject([
      { for: "Rainfall" },
      { for: "WetGrass", given: ["Rainfall"] },
    ]);
    expect(state.sourceText).toContain("<NAME>Rainfall</NAME>");
    expect(state.sourceText).toContain("<GIVEN>Rainfall</GIVEN>");
    expect(screen.getByText("Selected: Rainfall")).toBeVisible();
  });

  it("shows invalid rename inline and leaves model unchanged", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainRootFile));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Select Rain" }));

    const name = screen.getByLabelText("Name / identifier");
    fireEvent.change(name, { target: { value: "two words" } });
    fireEvent.blur(name);

    expect(
      screen.getAllByText(/not a valid editor identifier/),
    ).not.toHaveLength(0);
    expect(screen.getByLabelText("Name / identifier")).toHaveValue("Rain");
    expect(useDocumentStore.getState().model).toEqual(rainRootFile);
    expect(useDocumentStore.getState().dirty).toBe(false);
  });

  it("renames an outcome without changing CPT values", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainWetGrassFile));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Select Rain" }));
    const before = useDocumentStore
      .getState()
      .model?.networks[0].definitions.map(({ table }) => [...table]);

    const outcome = screen.getByLabelText("Outcome 0");
    fireEvent.change(outcome, { target: { value: "raining" } });
    fireEvent.blur(outcome);

    const network = useDocumentStore.getState().model?.networks[0];
    expect(network?.variables[0].outcomes).toEqual(["raining", "false"]);
    expect(network?.definitions.map(({ table }) => table)).toEqual(before);
  });

  it("adds outcomes through inspector and shows initialized parent-slice warning", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainWetGrassFile));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Select Rain" }));

    fireEvent.click(screen.getByRole("button", { name: "Add outcome" }));

    const network = useDocumentStore.getState().model?.networks[0];
    expect(network?.variables[0].outcomes).toEqual(["true", "false", "State0"]);
    expect(network?.definitions.map(({ table }) => table)).toEqual([
      [0.2, 0.8, 0],
      [0.9, 0.1, 0.1, 0.9, 0.5, 0.5],
    ]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "CPT for WetGrass received a uniform slice for new Rain outcome",
    );
  });

  it("moves outcomes with child and parent CPT permutations", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainWetGrassFile));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Select Rain" }));
    fireEvent.click(screen.getByRole("button", { name: "Select outcome 1" }));

    fireEvent.click(screen.getByRole("button", { name: "Move up" }));

    const network = useDocumentStore.getState().model?.networks[0];
    expect(network?.variables[0].outcomes).toEqual(["false", "true"]);
    expect(network?.definitions.map(({ table }) => table)).toEqual([
      [0.8, 0.2],
      [0.1, 0.9, 0.9, 0.1],
    ]);
  });

  it("removes selected outcomes and shows reset warnings", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainWetGrassFile));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Select Rain" }));
    fireEvent.click(screen.getByRole("button", { name: "Select outcome 0" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Remove selected outcome" }),
    );

    const network = useDocumentStore.getState().model?.networks[0];
    expect(network?.variables[0].outcomes).toEqual(["false"]);
    expect(network?.definitions.map(({ table }) => table)).toEqual([
      [1],
      [0.1, 0.9],
    ]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "CPT for Rain was reset after removing a nonzero outcome",
    );
  });

  it("normalizes a CPT draft and serializes exact flattened values", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainRootFile));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Select Rain" }));

    fireEvent.change(screen.getByLabelText("Root P(true)"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText("Root P(false)"), {
      target: { value: "80" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Normalize" }));

    const state = useDocumentStore.getState();
    expect(state.model?.networks[0].definitions[0].table).toEqual([0.2, 0.8]);
    expect(state.sourceText).toContain("<TABLE>0.2 0.8</TABLE>");
    expect(state.dirty).toBe(false);
  });

  it("edits raw Unicode properties without changing their order", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(propertiesFile));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Select LocatedNode" }));

    const property = screen.getByLabelText("Property 1");
    fireEvent.change(property, { target: { value: "注記 = café ☂" } });
    fireEvent.blur(property);

    const state = useDocumentStore.getState();
    expect(
      state.model?.networks[0].variables[0].properties.map(({ text }) => text),
    ).toEqual(["position = (73, 165)", "注記 = café ☂"]);
    const parsed = parseXmlBif(state.sourceText);
    expect(
      parsed.ok && parsed.file.networks[0].variables[0].properties,
    ).toEqual([{ text: "position = (73, 165)" }, { text: "注記 = café ☂" }]);
  });

  it("persists drag-end position without changing unrelated properties", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(propertiesFile));
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Move LocatedNode" }));

    const state = useDocumentStore.getState();
    const properties = state.model?.networks[0].variables[0].properties;
    expect(properties?.map(({ text }) => text)).toEqual([
      "position = (83, 185)",
      "custom = preserve exactly",
    ]);
    expect(state.dirty).toBe(true);
    expect(parsePositionProperty(properties?.[0].text ?? "")).toEqual({
      x: 83,
      y: 185,
    });
  });

  it("keeps the React Flow selection callback stable while entering arc mode", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainWetGrassFile));
    render(<App />);
    const selectionCallback = reactFlowRenders.at(-1)?.onSelectionChange;

    fireEvent.click(screen.getByRole("button", { name: "Add Arc" }));

    expect(reactFlowRenders.at(-1)?.onSelectionChange).toBe(selectionCallback);
  });

  it("adds and removes arcs through domain-backed graph connections", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainRootFile));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));
    fireEvent.click(screen.getByRole("button", { name: "Canvas" }));

    fireEvent.click(screen.getByRole("button", { name: "Add Arc" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Connect Rain to Node1" }),
    );

    let state = useDocumentStore.getState();
    expect(state.model?.networks[0].definitions[1]).toMatchObject({
      for: "Node1",
      given: ["Rain"],
      table: [0.5, 0.5, 0.5, 0.5],
    });
    expect(state.sourceText).toContain("<GIVEN>Rain</GIVEN>");
    expect(screen.getByRole("button", { name: "Add Arc" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Select edge Rain to Node1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    state = useDocumentStore.getState();
    expect(state.model?.networks[0].definitions[1]).toMatchObject({
      given: [],
      table: [0.5, 0.5],
    });
    expect(state.sourceText).not.toContain("<GIVEN>Rain</GIVEN>");
  });

  it("rejects an invalid graph connection without changing projected edges", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainWetGrassFile));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Add Arc" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Connect Rain to WetGrass" }),
    );

    expect(useDocumentStore.getState().model).toEqual(rainWetGrassFile);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Rain is already a parent of WetGrass",
    );
    expect(
      screen.getAllByRole("button", { name: "Select edge Rain to WetGrass" }),
    ).toHaveLength(1);
  });

  it("deletes only a selected node and keeps child CPT valid with warning", () => {
    useDocumentStore.getState().loadSource(serializeXmlBif(rainWetGrassFile));
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(useDocumentStore.getState().model).toEqual(rainWetGrassFile);

    fireEvent.click(screen.getByRole("button", { name: "Select Rain" }));
    fireEvent.keyDown(window, { key: "Delete" });

    expect(useDocumentStore.getState().model?.networks[0]).toMatchObject({
      variables: [{ name: "WetGrass" }],
      definitions: [{ for: "WetGrass", given: [], table: [0.5, 0.5] }],
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "CPT for WetGrass was reset after removing parent Rain",
    );
  });
});
