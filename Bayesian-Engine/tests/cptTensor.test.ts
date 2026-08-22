import { describe, expect, it } from "vitest";
import {
  coordinatesToFlatIndex,
  flatIndexToCoordinates,
  groupChildDistributions,
  insertAxis,
  insertAxisState,
  permuteAxes,
  permuteAxisStates,
  product,
  removeAxisIfLossless,
  removeAxisState,
  stridesFor,
} from "../src/domain/cptTensor";

const cardinalities = [2, 3, 2] as const;
const identifiable = Array.from({ length: 12 }, (_, index) => index);

describe("CPT tensor indexing", () => {
  it("computes products and row-major strides, including a scalar tensor", () => {
    expect(product(cardinalities)).toBe(12);
    expect(product([])).toBe(1);
    expect(stridesFor(cardinalities)).toEqual([6, 2, 1]);
    expect(stridesFor([])).toEqual([]);
  });

  it("round-trips every coordinate and flat index", () => {
    for (let index = 0; index < identifiable.length; index += 1) {
      const coordinates = flatIndexToCoordinates(index, cardinalities);
      expect(coordinatesToFlatIndex(coordinates, cardinalities)).toBe(index);
    }
    expect(coordinatesToFlatIndex([1, 2, 1], cardinalities)).toBe(11);

    const threeParentCardinalities = [2, 2, 3, 2];
    for (let index = 0; index < product(threeParentCardinalities); index += 1) {
      expect(
        coordinatesToFlatIndex(
          flatIndexToCoordinates(index, threeParentCardinalities),
          threeParentCardinalities,
        ),
      ).toBe(index);
    }
  });
});

describe("CPT tensor permutations", () => {
  it("swaps non-binary A and B axes exactly", () => {
    expect(permuteAxes(identifiable, cardinalities, [1, 0, 2])).toEqual([
      0, 1, 6, 7, 2, 3, 8, 9, 4, 5, 10, 11,
    ]);
  });

  it("reverses parent and child states exactly", () => {
    expect(
      permuteAxisStates(identifiable, cardinalities, 1, [2, 1, 0]),
    ).toEqual([4, 5, 2, 3, 0, 1, 10, 11, 8, 9, 6, 7]);
    expect(permuteAxisStates(identifiable, cardinalities, 2, [1, 0])).toEqual([
      1, 0, 3, 2, 5, 4, 7, 6, 9, 8, 11, 10,
    ]);
  });

  it("preserves probability values without normalization or averaging", () => {
    const probabilities = [0.1, 0.9, 0.25, 0.75, 0.4, 0.6];
    const result = permuteAxes(probabilities, [3, 2], [1, 0]);

    expect(result).toEqual([0.1, 0.25, 0.4, 0.9, 0.75, 0.6]);
    expect([...result].sort()).toEqual([...probabilities].sort());
  });

  it("does not mutate inputs", () => {
    const values = [...identifiable];
    const dimensions = [...cardinalities];
    const order = [1, 0, 2];

    permuteAxes(values, dimensions, order);

    expect(values).toEqual(identifiable);
    expect(dimensions).toEqual(cardinalities);
    expect(order).toEqual([1, 0, 2]);
  });
});

describe("CPT tensor dimension changes", () => {
  it("inserts an axis by replicating the existing tensor", () => {
    expect(insertAxis([10, 11, 20, 21], [2, 2], 1, 3)).toEqual([
      10, 11, 10, 11, 10, 11, 20, 21, 20, 21, 20, 21,
    ]);
  });

  it("inserts and removes one state on a non-binary axis", () => {
    expect(insertAxisState([0, 1, 2, 3, 4, 5], [2, 3], 1, 1, () => 9)).toEqual([
      0, 9, 1, 2, 3, 9, 4, 5,
    ]);
    expect(removeAxisState([0, 9, 1, 2, 3, 9, 4, 5], [2, 4], 1, 1)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });

  it("removes an axis only when every removed-state slice matches", () => {
    const repeated = [10, 11, 10, 11, 10, 11, 20, 21, 20, 21, 20, 21];

    expect(removeAxisIfLossless(repeated, [2, 3, 2], 1)).toEqual([
      10, 11, 20, 21,
    ]);
    expect(removeAxisIfLossless([10, 11, 10, 12], [2, 2], 0)).toBeNull();
  });

  it("supports a comparison policy for lossless removal", () => {
    expect(
      removeAxisIfLossless(
        [0.5, 0.5000000001],
        [2],
        0,
        (left, right) => Math.abs(left - right) < 1e-9,
      ),
    ).toEqual([0.5]);
  });

  it("groups child-contiguous distributions", () => {
    expect(groupChildDistributions(identifiable, [2, 3], 2)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
      [8, 9],
      [10, 11],
    ]);
    expect(groupChildDistributions([0.2, 0.8], [], 2)).toEqual([[0.2, 0.8]]);
  });
});

describe("CPT tensor input validation", () => {
  it.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid cardinalities %j",
    (invalid) => {
      expect(() => product([invalid])).toThrow(RangeError);
    },
  );

  it("rejects invalid coordinates and flat indexes", () => {
    expect(() => coordinatesToFlatIndex([0], [2, 2])).toThrow(RangeError);
    expect(() => coordinatesToFlatIndex([2, 0], [2, 2])).toThrow(RangeError);
    expect(() => flatIndexToCoordinates(4, [2, 2])).toThrow(RangeError);
    expect(() => flatIndexToCoordinates(-1, [2, 2])).toThrow(RangeError);
  });

  it("rejects wrong tensor lengths", () => {
    expect(() => permuteAxes([1, 2], [2, 2], [0, 1])).toThrow(RangeError);
    expect(() => groupChildDistributions([1], [2], 2)).toThrow(RangeError);
    expect(() => insertAxis([], [], 0, 2)).toThrow(RangeError);
  });

  it.each([[[0, 0, 2]], [[0, 1]], [[0, 1, 3]]])(
    "rejects invalid axis permutation %j",
    (axisPermutation) => {
      expect(() =>
        permuteAxes(identifiable, cardinalities, axisPermutation),
      ).toThrow(RangeError);
    },
  );

  it("rejects invalid state permutations and axis indexes", () => {
    expect(() =>
      permuteAxisStates(identifiable, cardinalities, 1, [0, 0, 2]),
    ).toThrow(RangeError);
    expect(() =>
      permuteAxisStates(identifiable, cardinalities, 3, [0]),
    ).toThrow(RangeError);
    expect(() => insertAxis(identifiable, cardinalities, 4, 2)).toThrow(
      RangeError,
    );
    expect(() => removeAxisIfLossless(identifiable, cardinalities, -1)).toThrow(
      RangeError,
    );
  });
});
