import type { Edge, Node } from "@xyflow/react";
import {
  edgesOf,
  parsePositionProperty,
  type Position,
  type VariableType,
  type XmlBifNetwork,
} from "../domain/model";

export interface FlowNodeData extends Record<string, unknown> {
  label: string;
  variableType: VariableType;
}

export interface FlowProjection {
  nodes: Node<FlowNodeData>[];
  edges: Edge[];
}

function layoutPositions(network: XmlBifNetwork): Map<string, Position> {
  const names = new Set(network.variables.map(({ name }) => name));
  const depth = new Map(network.variables.map(({ name }) => [name, 0]));
  const incoming = new Map(network.variables.map(({ name }) => [name, 0]));
  const children = new Map(
    network.variables.map(({ name }) => [name, [] as string[]]),
  );

  for (const { source, target } of edgesOf(network)) {
    if (!names.has(source) || !names.has(target)) continue;
    incoming.set(target, (incoming.get(target) ?? 0) + 1);
    children.get(source)?.push(target);
  }

  const queue = network.variables
    .map(({ name }) => name)
    .filter((name) => incoming.get(name) === 0);
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index];
    for (const child of children.get(parent) ?? []) {
      depth.set(
        child,
        Math.max(depth.get(child) ?? 0, (depth.get(parent) ?? 0) + 1),
      );
      const remaining = (incoming.get(child) ?? 0) - 1;
      incoming.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }

  const rowByDepth = new Map<number, number>();
  return new Map(
    network.variables.map(({ name }) => {
      const column = depth.get(name) ?? 0;
      const row = rowByDepth.get(column) ?? 0;
      rowByDepth.set(column, row + 1);
      return [name, { x: 80 + column * 220, y: 60 + row * 120 }];
    }),
  );
}

export function projectNetworkToFlow(network: XmlBifNetwork): FlowProjection {
  const layout = layoutPositions(network);
  const edgeIds = new Map<string, number>();

  return {
    nodes: network.variables.map((variable) => ({
      id: variable.name,
      position:
        variable.properties
          .map(({ text }) => parsePositionProperty(text))
          .find((position) => position !== null) ?? layout.get(variable.name)!,
      data: { label: variable.name, variableType: variable.type },
      className: `flow-node flow-node--${variable.type}`,
      draggable: true,
      connectable: false,
    })),
    edges: edgesOf(network).map(({ source, target }) => {
      const baseId = `${source}->${target}`;
      const occurrence = (edgeIds.get(baseId) ?? 0) + 1;
      edgeIds.set(baseId, occurrence);
      return {
        id: occurrence === 1 ? baseId : `${baseId}#${occurrence}`,
        source,
        target,
      };
    }),
  };
}
