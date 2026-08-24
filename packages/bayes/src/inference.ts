import { flatIndexToCoordinates, product, stridesFor } from "./cptTensor.js";
import { findDefinition, findVariable, type XmlBifNetwork } from "./model.js";

interface Factor {
  readonly variables: readonly string[];
  readonly cardinalities: readonly number[];
  readonly values: readonly number[];
}

export interface MarginalDistribution {
  readonly nodeRef: string;
  readonly outcomes: readonly { readonly outcome: string; readonly probability: number }[];
}

export function inferMarginals(
  network: XmlBifNetwork,
  requestedOutputNodeRefs: readonly string[],
): readonly MarginalDistribution[] {
  if (
    requestedOutputNodeRefs.length === 0 ||
    new Set(requestedOutputNodeRefs).size !== requestedOutputNodeRefs.length
  ) {
    throw new RangeError("Requested output nodes must be unique and non-empty.");
  }
  const cardinality = new Map(
    network.variables.map(({ name, outcomes }) => [name, outcomes.length]),
  );
  const factors = network.variables.map((variable): Factor => {
    if (variable.type !== "nature") throw new RangeError("Inference supports nature nodes only.");
    const definition = findDefinition(network, variable.name);
    if (!definition) throw new RangeError(`Definition missing for ${variable.name}.`);
    const variables = [...definition.given, variable.name];
    const cardinalities = variables.map((name) => cardinality.get(name) ?? 0);
    if (definition.table.length !== product(cardinalities)) {
      throw new RangeError(`CPT shape mismatch for ${variable.name}.`);
    }
    return { variables, cardinalities, values: definition.table };
  });

  return requestedOutputNodeRefs.map((nodeRef) => {
    const variable = findVariable(network, nodeRef);
    if (!variable || variable.type !== "nature") {
      throw new RangeError(`Requested output node ${nodeRef} is unsupported.`);
    }
    let remaining = [...factors];
    const pending = new Set(
      network.variables.map(({ name }) => name).filter((name) => name !== nodeRef),
    );
    while (pending.size > 0) {
      const name = [...pending].sort((left, right) => {
        const size = (candidate: string) =>
          product(
            [
              ...new Set(
                remaining
                  .filter((factor) => factor.variables.includes(candidate))
                  .flatMap((factor) => factor.variables),
              ),
            ].map((ref) => cardinality.get(ref) ?? 0),
          );
        return size(left) - size(right) || left.localeCompare(right);
      })[0]!;
      const containing = remaining.filter((factor) => factor.variables.includes(name));
      remaining = remaining.filter((factor) => !factor.variables.includes(name));
      remaining.push(sumOut(containing.reduce(multiply), name));
      pending.delete(name);
    }
    const marginal = remaining.reduce(multiply);
    const values = marginal.variables.includes(nodeRef)
      ? marginal.variables.length === 1
        ? marginal.values
        : sumTo(marginal, nodeRef).values
      : [];
    const total = values.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total) || total <= 0) throw new RangeError("Inference result is invalid.");
    return {
      nodeRef,
      outcomes: variable.outcomes.map((outcome, index) => ({
        outcome,
        probability: values[index]! / total,
      })),
    };
  });
}

function multiply(left: Factor, right: Factor): Factor {
  const variables = [
    ...left.variables,
    ...right.variables.filter((name) => !left.variables.includes(name)),
  ];
  const cardinality = new Map<string, number>();
  left.variables.forEach((name, index) => cardinality.set(name, left.cardinalities[index]!));
  right.variables.forEach((name, index) => {
    const value = right.cardinalities[index]!;
    if (cardinality.has(name) && cardinality.get(name) !== value) {
      throw new RangeError(`Cardinality mismatch for ${name}.`);
    }
    cardinality.set(name, value);
  });
  const cardinalities = variables.map((name) => cardinality.get(name)!);
  const leftStrides = stridesFor(left.cardinalities);
  const rightStrides = stridesFor(right.cardinalities);
  const positions = new Map(variables.map((name, index) => [name, index]));
  const values = Array.from({ length: product(cardinalities) }, (_, index) => {
    const coordinates = flatIndexToCoordinates(index, cardinalities);
    const indexFor = (factor: Factor, strides: readonly number[]) =>
      factor.variables.reduce(
        (flat, name, axis) => flat + coordinates[positions.get(name)!]! * strides[axis]!,
        0,
      );
    return left.values[indexFor(left, leftStrides)]! * right.values[indexFor(right, rightStrides)]!;
  });
  return { variables, cardinalities, values };
}

function sumOut(factor: Factor, name: string): Factor {
  const axis = factor.variables.indexOf(name);
  if (axis < 0) return factor;
  const variables = factor.variables.filter((_, index) => index !== axis);
  const cardinalities = factor.cardinalities.filter((_, index) => index !== axis);
  const values = new Array<number>(cardinalities.length === 0 ? 1 : product(cardinalities)).fill(0);
  const targetStrides = cardinalities.length === 0 ? [] : stridesFor(cardinalities);
  factor.values.forEach((value, index) => {
    const coordinates = flatIndexToCoordinates(index, factor.cardinalities).filter(
      (_, coordinateAxis) => coordinateAxis !== axis,
    );
    const target =
      coordinates.length === 0
        ? 0
        : coordinates.reduce(
            (flat, coordinate, coordinateAxis) =>
              flat + coordinate * targetStrides[coordinateAxis]!,
            0,
          );
    values[target] += value;
  });
  return { variables, cardinalities, values };
}

function sumTo(factor: Factor, name: string): Factor {
  return factor.variables.filter((candidate) => candidate !== name).reduce(sumOut, factor);
}
