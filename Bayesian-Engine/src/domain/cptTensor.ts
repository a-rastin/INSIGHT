export type ValueComparator = (left: number, right: number) => boolean;

function assertCardinalities(cardinalities: readonly number[]): void {
  for (const cardinality of cardinalities) {
    if (!Number.isSafeInteger(cardinality) || cardinality <= 0) {
      throw new RangeError("Cardinalities must be positive safe integers");
    }
  }
}

function assertAxisIndex(
  axisIndex: number,
  axisCount: number,
  allowEnd = false,
): void {
  const upperBound = allowEnd ? axisCount : axisCount - 1;
  if (
    !Number.isSafeInteger(axisIndex) ||
    axisIndex < 0 ||
    axisIndex > upperBound
  ) {
    throw new RangeError("Axis index is out of range");
  }
}

function assertPermutation(permutation: readonly number[], size: number): void {
  if (
    permutation.length !== size ||
    permutation.some(
      (index) => !Number.isSafeInteger(index) || index < 0 || index >= size,
    ) ||
    new Set(permutation).size !== size
  ) {
    throw new RangeError("Invalid permutation");
  }
}

function assertTensorShape(
  values: readonly number[],
  cardinalities: readonly number[],
): void {
  const expectedLength = product(cardinalities);
  if (values.length !== expectedLength) {
    throw new RangeError(
      `Tensor has ${values.length} values; expected ${expectedLength}`,
    );
  }
}

export function product(cardinalities: readonly number[]): number {
  assertCardinalities(cardinalities);
  let result = 1;

  for (const cardinality of cardinalities) {
    result *= cardinality;
    if (!Number.isSafeInteger(result)) {
      throw new RangeError("Tensor size exceeds safe integer range");
    }
  }

  return result;
}

export function stridesFor(cardinalities: readonly number[]): number[] {
  assertCardinalities(cardinalities);
  const strides = new Array<number>(cardinalities.length);
  let stride = 1;

  for (let axis = cardinalities.length - 1; axis >= 0; axis -= 1) {
    strides[axis] = stride;
    stride *= cardinalities[axis];
    if (!Number.isSafeInteger(stride)) {
      throw new RangeError("Tensor size exceeds safe integer range");
    }
  }

  return strides;
}

export function coordinatesToFlatIndex(
  coordinates: readonly number[],
  cardinalities: readonly number[],
): number {
  const strides = stridesFor(cardinalities);
  if (coordinates.length !== cardinalities.length) {
    throw new RangeError("Coordinate count must match axis count");
  }

  return coordinates.reduce((flatIndex, coordinate, axis) => {
    if (
      !Number.isSafeInteger(coordinate) ||
      coordinate < 0 ||
      coordinate >= cardinalities[axis]
    ) {
      throw new RangeError("Coordinate is out of range");
    }
    return flatIndex + coordinate * strides[axis];
  }, 0);
}

export function flatIndexToCoordinates(
  flatIndex: number,
  cardinalities: readonly number[],
): number[] {
  const size = product(cardinalities);
  if (!Number.isSafeInteger(flatIndex) || flatIndex < 0 || flatIndex >= size) {
    throw new RangeError("Flat index is out of range");
  }

  return stridesFor(cardinalities).map(
    (stride, axis) => Math.floor(flatIndex / stride) % cardinalities[axis],
  );
}

// axisPermutation[newAxis] identifies its corresponding old axis.
export function permuteAxes(
  values: readonly number[],
  oldCardinalities: readonly number[],
  axisPermutation: readonly number[],
): number[] {
  assertTensorShape(values, oldCardinalities);
  assertPermutation(axisPermutation, oldCardinalities.length);
  const newCardinalities = axisPermutation.map(
    (oldAxis) => oldCardinalities[oldAxis],
  );

  return values.map((_, newFlatIndex) => {
    const newCoordinates = flatIndexToCoordinates(
      newFlatIndex,
      newCardinalities,
    );
    const oldCoordinates = new Array<number>(oldCardinalities.length);
    axisPermutation.forEach((oldAxis, newAxis) => {
      oldCoordinates[oldAxis] = newCoordinates[newAxis];
    });
    return values[coordinatesToFlatIndex(oldCoordinates, oldCardinalities)];
  });
}

// newOrder[newState] identifies its corresponding old state.
export function permuteAxisStates(
  values: readonly number[],
  cardinalities: readonly number[],
  axisIndex: number,
  newOrder: readonly number[],
): number[] {
  assertTensorShape(values, cardinalities);
  assertAxisIndex(axisIndex, cardinalities.length);
  assertPermutation(newOrder, cardinalities[axisIndex]);

  return values.map((_, newFlatIndex) => {
    const oldCoordinates = flatIndexToCoordinates(newFlatIndex, cardinalities);
    oldCoordinates[axisIndex] = newOrder[oldCoordinates[axisIndex]];
    return values[coordinatesToFlatIndex(oldCoordinates, cardinalities)];
  });
}

export function insertAxis(
  values: readonly number[],
  cardinalities: readonly number[],
  axisIndex: number,
  newCardinality: number,
): number[] {
  assertTensorShape(values, cardinalities);
  assertAxisIndex(axisIndex, cardinalities.length, true);
  assertCardinalities([newCardinality]);
  const newCardinalities = [...cardinalities];
  newCardinalities.splice(axisIndex, 0, newCardinality);

  return Array.from(
    { length: product(newCardinalities) },
    (_, newFlatIndex) => {
      const oldCoordinates = flatIndexToCoordinates(
        newFlatIndex,
        newCardinalities,
      );
      oldCoordinates.splice(axisIndex, 1);
      return values[coordinatesToFlatIndex(oldCoordinates, cardinalities)];
    },
  );
}

export function insertAxisState(
  values: readonly number[],
  cardinalities: readonly number[],
  axisIndex: number,
  stateIndex: number,
  initialize: (coordinates: readonly number[]) => number,
): number[] {
  assertTensorShape(values, cardinalities);
  assertAxisIndex(axisIndex, cardinalities.length);
  if (
    !Number.isSafeInteger(stateIndex) ||
    stateIndex < 0 ||
    stateIndex > cardinalities[axisIndex]
  ) {
    throw new RangeError("State index is out of range");
  }

  const newCardinalities = [...cardinalities];
  newCardinalities[axisIndex] += 1;
  return Array.from({ length: product(newCardinalities) }, (_, flatIndex) => {
    const coordinates = flatIndexToCoordinates(flatIndex, newCardinalities);
    if (coordinates[axisIndex] === stateIndex) return initialize(coordinates);
    const oldCoordinates = [...coordinates];
    if (oldCoordinates[axisIndex] > stateIndex) oldCoordinates[axisIndex] -= 1;
    return values[coordinatesToFlatIndex(oldCoordinates, cardinalities)];
  });
}

export function removeAxisState(
  values: readonly number[],
  cardinalities: readonly number[],
  axisIndex: number,
  stateIndex: number,
): number[] {
  assertTensorShape(values, cardinalities);
  assertAxisIndex(axisIndex, cardinalities.length);
  if (cardinalities[axisIndex] <= 1) {
    throw new RangeError("Cannot remove the only axis state");
  }
  if (
    !Number.isSafeInteger(stateIndex) ||
    stateIndex < 0 ||
    stateIndex >= cardinalities[axisIndex]
  ) {
    throw new RangeError("State index is out of range");
  }

  const newCardinalities = [...cardinalities];
  newCardinalities[axisIndex] -= 1;
  return Array.from({ length: product(newCardinalities) }, (_, flatIndex) => {
    const oldCoordinates = flatIndexToCoordinates(flatIndex, newCardinalities);
    if (oldCoordinates[axisIndex] >= stateIndex) oldCoordinates[axisIndex] += 1;
    return values[coordinatesToFlatIndex(oldCoordinates, cardinalities)];
  });
}

export function removeAxisIfLossless(
  values: readonly number[],
  cardinalities: readonly number[],
  axisIndex: number,
  equal: ValueComparator = (left, right) => left === right,
): number[] | null {
  assertTensorShape(values, cardinalities);
  assertAxisIndex(axisIndex, cardinalities.length);
  const remainingCardinalities = [...cardinalities];
  const removedCardinality = remainingCardinalities.splice(axisIndex, 1)[0];
  const result: number[] = [];
  const remainingSize = product(remainingCardinalities);

  for (let flatIndex = 0; flatIndex < remainingSize; flatIndex += 1) {
    const coordinates = flatIndexToCoordinates(
      flatIndex,
      remainingCardinalities,
    );
    coordinates.splice(axisIndex, 0, 0);
    const first = values[coordinatesToFlatIndex(coordinates, cardinalities)];

    for (let state = 1; state < removedCardinality; state += 1) {
      coordinates[axisIndex] = state;
      if (
        !equal(
          first,
          values[coordinatesToFlatIndex(coordinates, cardinalities)],
        )
      ) {
        return null;
      }
    }
    result.push(first);
  }

  return result;
}

export function groupChildDistributions(
  values: readonly number[],
  parentCardinalities: readonly number[],
  childCardinality: number,
): number[][] {
  assertCardinalities([childCardinality]);
  assertTensorShape(values, [...parentCardinalities, childCardinality]);

  return Array.from({ length: product(parentCardinalities) }, (_, index) => {
    const start = index * childCardinality;
    return values.slice(start, start + childCardinality);
  });
}
