import { useEffect, useState } from "react";
import { DiagnosticsPanel } from "../components/DiagnosticsPanel";
import { GraphView, type GraphMode } from "../components/GraphView";
import { NodeInspector } from "../components/NodeInspector";
import { XmlCodeView } from "../components/XmlCodeView";
import {
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
  setCptDistribution,
  setRawTableRow,
  setVariablePosition,
  setVariableProperties,
} from "../domain/mutations";
import type { VariableType, XmlBifNetwork } from "../domain/model";
import {
  useDocumentStore,
  type DocumentActionResult,
  type DomainMutator,
} from "../store/documentStore";
import { closeDocumentWindow, createCommandController } from "./commands";

export function App(): JSX.Element {
  const [error, setError] = useState<string>();
  const [activeTab, setActiveTab] = useState<"graph" | "code">("graph");
  const [fitRequest, setFitRequest] = useState(0);
  const [graphMode, setGraphMode] = useState<GraphMode>("select");
  const [nodeType, setNodeType] = useState<VariableType>("nature");
  const [networkName, setNetworkName] = useState("");
  const path = useDocumentStore(({ path }) => path);
  const dirty = useDocumentStore(({ dirty }) => dirty);
  const sync = useDocumentStore(({ sync }) => sync);
  const visualEditingDisabled = sync === "code-invalid";
  const model = useDocumentStore(({ model }) => model);
  const activeNetworkIndex = useDocumentStore(
    ({ activeNetworkIndex }) => activeNetworkIndex,
  );
  const selectedNode = useDocumentStore(({ selectedNode }) => selectedNode);
  const selectedEdge = useDocumentStore(({ selectedEdge }) => selectedEdge);
  const setSelectedNode = useDocumentStore(
    ({ setSelectedNode }) => setSelectedNode,
  );
  const setSelectedEdge = useDocumentStore(
    ({ setSelectedEdge }) => setSelectedEdge,
  );
  const network = model?.networks[activeNetworkIndex] ?? null;
  const selectedVariable =
    network?.variables.find(({ name }) => name === selectedNode) ?? null;
  const diagnostics = useDocumentStore(({ diagnostics }) => diagnostics);
  const applyDomainMutationFromStore = useDocumentStore(
    ({ applyDomainMutation }) => applyDomainMutation,
  );
  const addNetwork = useDocumentStore(({ addNetwork }) => addNetwork);
  const deleteActiveNetwork = useDocumentStore(
    ({ deleteActiveNetwork }) => deleteActiveNetwork,
  );
  const setActiveNetworkIndex = useDocumentStore(
    ({ setActiveNetworkIndex }) => setActiveNetworkIndex,
  );

  useEffect(() => {
    setNetworkName(network?.name ?? "");
    setSelectedNode(undefined);
    setSelectedEdge(undefined);
  }, [activeNetworkIndex, network?.name]);

  useEffect(() => {
    if (
      selectedNode &&
      !network?.variables.some(({ name }) => name === selectedNode)
    ) {
      setSelectedNode(undefined);
    }
  }, [network, selectedNode]);

  const runVisualAction = (
    action: () => DocumentActionResult,
  ): DocumentActionResult => {
    const state = useDocumentStore.getState();
    if (state.fidelityRisks.length > 0 && !state.canonicalizationAcknowledged) {
      const confirmed = window.confirm(
        "Graphical editing will rewrite XML in Bayes Engine's canonical XMLBIF format and may remove comments/unknown XML formatting. Continue?",
      );
      if (!confirmed) return { ok: false, diagnostics: [] };
      state.acknowledgeCanonicalization();
    }
    return action();
  };

  const applyDomainMutation = (mutator: DomainMutator) =>
    runVisualAction(() => applyDomainMutationFromStore(mutator));

  const applyDestructiveMutation = (
    mutate: (
      network: XmlBifNetwork,
      allowDataLoss: boolean,
    ) => ReturnType<DomainMutator>,
  ): DocumentActionResult => {
    const result = applyDomainMutation((current) => mutate(current, false));
    if (
      result.ok ||
      !result.diagnostics.some(
        ({ code }) => code === "RAW_TABLE_RESET_CONFIRMATION_REQUIRED",
      )
    ) {
      return result;
    }
    if (
      !window.confirm(
        `${result.diagnostics.map(({ message }) => message).join("\n")}\n\nContinue?`,
      )
    ) {
      return { ok: false, diagnostics: [] };
    }
    return applyDomainMutation((current) => mutate(current, true));
  };

  const showMutationResult = (result: DocumentActionResult): boolean => {
    setError(
      result.ok
        ? undefined
        : result.diagnostics.map(({ message }) => message).join("\n"),
    );
    return result.ok;
  };

  const addNode = (position: { x: number; y: number }) => {
    const added = showMutationResult(
      applyDomainMutation((current) =>
        addVariable(current, nodeType, undefined, position),
      ),
    );
    setGraphMode("select");
    if (added) {
      const current = useDocumentStore.getState();
      setSelectedNode(
        current.model?.networks[current.activeNetworkIndex].variables.at(-1)
          ?.name,
      );
    }
  };

  const deleteSelected = () => {
    if (selectedEdge) {
      if (
        showMutationResult(
          applyDestructiveMutation((current, allowDataLoss) =>
            removeParent(current, selectedEdge.target, selectedEdge.source, {
              allowDataLoss,
            }),
          ),
        )
      ) {
        setSelectedEdge(undefined);
      }
      return;
    }
    if (!selectedNode) return;
    if (
      showMutationResult(
        applyDestructiveMutation((current, allowDataLoss) =>
          deleteVariable(current, selectedNode, { allowDataLoss }),
        ),
      )
    ) {
      setSelectedNode(undefined);
    }
  };

  const commandController = createCommandController(window.bayesEngine, {
    deleteSelected,
    setMode: setGraphMode,
    fitGraph: () => setFitRequest((request) => request + 1),
    setTab: setActiveTab,
  });

  const run = async (
    command: () => Promise<{ ok: boolean; message?: string }>,
  ) => {
    const result = await command();
    setError(result.ok ? undefined : result.message);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) =>
      commandController.handleKeyDown(event);
    const removeCommandListener = window.bayesEngine.onCommand(
      (command) => void run(() => commandController.execute(command)),
    );
    const removeCloseListener = window.bayesEngine.onCloseRequested(
      () => void run(() => closeDocumentWindow(window.bayesEngine)),
    );
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      removeCommandListener();
      removeCloseListener();
    };
  });

  return (
    <div className="app-shell">
      <header>
        <h1>Bayes Engine</h1>
        <div className="toolbar" role="toolbar" aria-label="Document tools">
          <button
            type="button"
            onClick={() => void run(() => commandController.execute("new"))}
          >
            New
          </button>
          <button
            type="button"
            onClick={() => void run(() => commandController.execute("open"))}
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => void run(() => commandController.execute("save"))}
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => void run(() => commandController.execute("save-as"))}
          >
            Save As
          </button>
          <button
            type="button"
            disabled={useDocumentStore.getState().historyPast.length === 0}
            onClick={() => void commandController.execute("undo")}
          >
            Undo
          </button>
          <button
            type="button"
            disabled={useDocumentStore.getState().historyFuture.length === 0}
            onClick={() => void commandController.execute("redo")}
          >
            Redo
          </button>
          <button
            type="button"
            aria-pressed={graphMode === "select"}
            onClick={() => void commandController.execute("select-mode")}
          >
            Select
          </button>
          <label className="node-type-choice">
            Node type
            <select
              aria-label="Node type"
              value={nodeType}
              disabled={visualEditingDisabled}
              onChange={(event) =>
                setNodeType(event.target.value as VariableType)
              }
            >
              <option value="nature">Nature</option>
              <option value="decision">Decision</option>
              <option value="utility">Utility</option>
            </select>
          </label>
          <button
            type="button"
            aria-pressed={graphMode === "add-node"}
            disabled={visualEditingDisabled}
            onClick={() => void commandController.execute("add-node-mode")}
          >
            Add Node
          </button>
          <button
            type="button"
            aria-pressed={graphMode === "add-arc"}
            disabled={visualEditingDisabled}
            onClick={() => void commandController.execute("add-arc-mode")}
          >
            Add Arc
          </button>
          <button
            type="button"
            disabled={visualEditingDisabled}
            onClick={() => void commandController.execute("delete")}
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => void commandController.execute("fit")}
          >
            Fit
          </button>
        </div>
      </header>
      <main>
        <div className="main-tabs" role="tablist" aria-label="Document views">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "graph"}
            onClick={() => setActiveTab("graph")}
          >
            Graph
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "code"}
            onClick={() => setActiveTab("code")}
          >
            XML Code
          </button>
          <div className="network-tools" aria-label="Network tools">
            {model && model.networks.length > 1 && (
              <label>
                Active network
                <select
                  value={activeNetworkIndex}
                  disabled={visualEditingDisabled}
                  onChange={(event) => {
                    const result = setActiveNetworkIndex(
                      Number(event.target.value),
                    );
                    showMutationResult(result);
                  }}
                >
                  {model.networks.map((item, index) => (
                    <option key={index} value={index}>
                      {index + 1}: {item.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {network && (
              <label>
                Network name
                <input
                  value={networkName}
                  disabled={visualEditingDisabled}
                  onChange={(event) => setNetworkName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    showMutationResult(
                      applyDomainMutation((current) =>
                        renameNetwork(current, networkName),
                      ),
                    );
                  }}
                />
              </label>
            )}
            <button
              type="button"
              disabled={visualEditingDisabled}
              onClick={() => showMutationResult(runVisualAction(addNetwork))}
            >
              Add network
            </button>
            <button
              type="button"
              disabled={
                visualEditingDisabled || (model?.networks.length ?? 0) <= 1
              }
              onClick={() => {
                if (
                  network &&
                  network.variables.length > 0 &&
                  !window.confirm(
                    `Delete network "${network.name}" and all its variables?`,
                  )
                ) {
                  return;
                }
                showMutationResult(runVisualAction(deleteActiveNetwork));
              }}
            >
              Delete network
            </button>
          </div>
          {activeTab === "graph" && selectedNode && (
            <span>Selected: {selectedNode}</span>
          )}
        </div>
        {activeTab === "graph" ? (
          <div className="graph-tab">
            {visualEditingDisabled && (
              <p className="sync-banner" role="status">
                Graph not synchronized with XML code
              </p>
            )}
            <div className="workspace">
              <GraphView
                network={network}
                editingDisabled={visualEditingDisabled}
                fitRequest={fitRequest}
                mode={graphMode}
                selectedNode={selectedNode}
                selectedEdge={selectedEdge}
                onSelectedNodeChange={setSelectedNode}
                onSelectedEdgeChange={setSelectedEdge}
                onAddNode={addNode}
                onAddArc={({ source, target }) => {
                  const added = showMutationResult(
                    applyDomainMutation((current) =>
                      addParent(current, target, source),
                    ),
                  );
                  if (added) {
                    setSelectedNode(undefined);
                    setSelectedEdge({ source, target });
                    setGraphMode("select");
                  }
                }}
                onNodePositionChange={(name, position) =>
                  showMutationResult(
                    applyDomainMutation((current) =>
                      setVariablePosition(current, name, position),
                    ),
                  )
                }
              />
              <fieldset
                className="inspector-disabled-wrapper"
                disabled={visualEditingDisabled}
              >
                <NodeInspector
                  network={network}
                  variable={selectedVariable}
                  onRename={(name) => {
                    if (!selectedNode) return { ok: true };
                    const result = applyDomainMutation((current) =>
                      renameVariable(current, selectedNode, name),
                    );
                    showMutationResult(result);
                    if (result.ok) setSelectedNode(name);
                    return result;
                  }}
                  onRenameOutcome={(index, name) => {
                    const result = selectedNode
                      ? applyDomainMutation((current) =>
                          renameOutcome(current, selectedNode, index, name),
                        )
                      : { ok: true as const };
                    showMutationResult(result);
                    return result;
                  }}
                  onAddOutcome={(name) => {
                    const result = selectedNode
                      ? applyDomainMutation((current) =>
                          addOutcome(current, selectedNode, name),
                        )
                      : { ok: true as const };
                    showMutationResult(result);
                    return result;
                  }}
                  onRemoveOutcome={(index) => {
                    const result = selectedNode
                      ? applyDestructiveMutation((current, allowDataLoss) =>
                          removeOutcome(current, selectedNode, index, {
                            allowDataLoss,
                          }),
                        )
                      : { ok: true as const };
                    showMutationResult(result);
                    return result;
                  }}
                  onReorderOutcomes={(order) => {
                    const result = selectedNode
                      ? applyDomainMutation((current) =>
                          reorderOutcomes(current, selectedNode, order),
                        )
                      : { ok: true as const };
                    showMutationResult(result);
                    return result;
                  }}
                  onSetProperties={(properties) => {
                    const result = selectedNode
                      ? applyDomainMutation((current) =>
                          setVariableProperties(
                            current,
                            selectedNode,
                            properties,
                          ),
                        )
                      : { ok: true as const };
                    showMutationResult(result);
                    return result;
                  }}
                  onSetCptDistribution={(parentStateIndexes, values) => {
                    const result = selectedNode
                      ? applyDomainMutation((current) =>
                          setCptDistribution(
                            current,
                            selectedNode,
                            parentStateIndexes,
                            values,
                          ),
                        )
                      : { ok: true as const };
                    showMutationResult(result);
                    return result;
                  }}
                  onSetRawTableRow={(parentStateIndexes, values) => {
                    const result = selectedNode
                      ? applyDomainMutation((current) =>
                          setRawTableRow(
                            current,
                            selectedNode,
                            parentStateIndexes,
                            values,
                          ),
                        )
                      : { ok: true as const };
                    showMutationResult(result);
                    return result;
                  }}
                />
              </fieldset>
            </div>
            <DiagnosticsPanel diagnostics={diagnostics} />
          </div>
        ) : (
          <XmlCodeView />
        )}
        {error && (
          <p className="app-error" role="alert">
            {error}
          </p>
        )}
      </main>
      <footer>
        <span>
          {path?.split(/[\\/]/).at(-1) ?? "Untitled"}
          {dirty && " *"}
        </span>
        <span>{sync}</span>
        <span>
          {diagnostics.filter(({ severity }) => severity === "error").length}{" "}
          errors,{" "}
          {diagnostics.filter(({ severity }) => severity === "warning").length}{" "}
          warnings
        </span>
      </footer>
    </div>
  );
}
