import { describe, expect, it } from "vitest";
import type { XmlBifNetwork } from "../src/domain/model";
import { projectNetworkToFlow } from "../src/components/graphProjection";
import {
  decisionUtilityFile,
  multiParentFile,
  propertiesFile,
  rainWetGrassFile,
} from "./fixtures/domainFixtures";

describe("projectNetworkToFlow", () => {
  it("projects GIVEN entries as ordered parent-to-child edges", () => {
    const projection = projectNetworkToFlow(multiParentFile.networks[0]);

    expect(projection.edges.slice(-2)).toEqual([
      expect.objectContaining({ source: "Weather", target: "Activity" }),
      expect.objectContaining({ source: "Season", target: "Activity" }),
    ]);
  });

  it("uses recognized position properties", () => {
    const projection = projectNetworkToFlow(propertiesFile.networks[0]);

    expect(projection.nodes[0].position).toEqual({ x: 73, y: 165 });
  });

  it("assigns deterministic distinct positions when hints are missing", () => {
    const network = rainWetGrassFile.networks[0];

    const first = projectNetworkToFlow(network).nodes.map(
      ({ position }) => position,
    );
    const second = projectNetworkToFlow(network).nodes.map(
      ({ position }) => position,
    );
    expect(first).toEqual(second);
    expect(new Set(first.map(({ x, y }) => `${x},${y}`)).size).toBe(
      first.length,
    );
  });

  it("gives decision and utility nodes distinct classes", () => {
    const projection = projectNetworkToFlow(decisionUtilityFile.networks[0]);

    expect(projection.nodes.map(({ className }) => className)).toEqual([
      "flow-node flow-node--decision",
      "flow-node flow-node--utility",
    ]);
  });

  it("projects an empty network", () => {
    const network: XmlBifNetwork = {
      name: "Empty",
      properties: [],
      variables: [],
      definitions: [],
    };

    expect(projectNetworkToFlow(network)).toEqual({ nodes: [], edges: [] });
  });
});
