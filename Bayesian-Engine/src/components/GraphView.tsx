import {
  applyNodeChanges,
  Background,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  type Connection,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { NetworkEdge, Position, XmlBifNetwork } from "../domain/model";
import { projectNetworkToFlow } from "./graphProjection";
import "@xyflow/react/dist/style.css";

export type GraphMode = "select" | "add-node" | "add-arc";

export interface GraphViewProps {
  network: XmlBifNetwork | null;
  fitRequest: number;
  mode: GraphMode;
  editingDisabled?: boolean;
  selectedNode?: string;
  selectedEdge?: NetworkEdge;
  onSelectedNodeChange: (name: string | undefined) => void;
  onSelectedEdgeChange: (edge: NetworkEdge | undefined) => void;
  onAddNode: (position: Position) => void;
  onAddArc: (edge: NetworkEdge) => void;
  onNodePositionChange: (name: string, position: Position) => void;
}

function FlowCanvas({
  network,
  fitRequest,
  mode,
  editingDisabled = false,
  selectedNode,
  selectedEdge,
  onSelectedNodeChange,
  onSelectedEdgeChange,
  onAddNode,
  onAddArc,
  onNodePositionChange,
}: GraphViewProps): JSX.Element {
  const { fitView, screenToFlowPosition } = useReactFlow();
  const projection = useMemo(
    () => (network ? projectNetworkToFlow(network) : null),
    [network],
  );
  const projectedNodes = useMemo(
    () =>
      projection?.nodes.map((node) => ({
        ...node,
        selected: node.id === selectedNode,
        connectable: !editingDisabled && mode === "add-arc",
      })) ?? [],
    [projection, selectedNode, mode, editingDisabled],
  );
  const [nodes, setNodes] = useState(projectedNodes);

  useEffect(() => setNodes(projectedNodes), [projectedNodes]);

  useEffect(() => {
    if (fitRequest > 0) void fitView({ padding: 0.2 });
  }, [fitRequest, fitView]);

  const handleSelectionChange = useCallback(
    ({ nodes, edges }: { nodes: { id: string }[]; edges: NetworkEdge[] }) => {
      onSelectedNodeChange(nodes.length === 1 ? nodes[0].id : undefined);
      onSelectedEdgeChange(
        edges.length === 1
          ? { source: edges[0].source, target: edges[0].target }
          : undefined,
      );
    },
    [onSelectedEdgeChange, onSelectedNodeChange],
  );

  if (!projection) {
    return <p className="graph-placeholder">No synchronized graph</p>;
  }

  return (
    <div className="graph-canvas" aria-label="Network graph">
      <ReactFlow
        nodes={nodes}
        edges={projection.edges.map((edge) => ({
          ...edge,
          selected:
            edge.source === selectedEdge?.source &&
            edge.target === selectedEdge.target,
        }))}
        nodesDraggable={!editingDisabled && mode === "select"}
        nodesConnectable={!editingDisabled && mode === "add-arc"}
        isValidConnection={(connection) =>
          network?.variables.some(
            ({ name, type }) =>
              name === connection.source && type !== "utility",
          ) ?? false
        }
        edgesFocusable
        onConnect={(connection: Connection) => {
          if (!editingDisabled && connection.source && connection.target) {
            onAddArc({ source: connection.source, target: connection.target });
          }
        }}
        elementsSelectable
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        fitView
        onNodesChange={(changes) =>
          setNodes((current) => applyNodeChanges(changes, current))
        }
        onNodeClick={(_, node) => {
          onSelectedEdgeChange(undefined);
          onSelectedNodeChange(node.id);
        }}
        onNodeDoubleClick={(_, node) => {
          onSelectedEdgeChange(undefined);
          onSelectedNodeChange(node.id);
        }}
        onEdgeClick={(_, edge) => {
          onSelectedNodeChange(undefined);
          onSelectedEdgeChange({ source: edge.source, target: edge.target });
        }}
        onNodeDragStop={(_, node) => {
          if (!editingDisabled) onNodePositionChange(node.id, node.position);
        }}
        onPaneClick={(event) => {
          if (!editingDisabled && mode === "add-node") {
            onAddNode(
              screenToFlowPosition({ x: event.clientX, y: event.clientY }),
            );
          } else {
            onSelectedNodeChange(undefined);
            onSelectedEdgeChange(undefined);
          }
        }}
        onSelectionChange={handleSelectionChange}
      >
        <Background />
      </ReactFlow>
      {nodes.length === 0 && (
        <p className="graph-hint">No variables in this network</p>
      )}
    </div>
  );
}

export function GraphView(props: GraphViewProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <FlowCanvas {...props} />
    </ReactFlowProvider>
  );
}
