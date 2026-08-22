import type { XmlBifFile } from "../../src/domain/model";

export const rainRootFile: XmlBifFile = {
  version: "0.3",
  networks: [
    {
      name: "RainRoot",
      properties: [],
      variables: [
        {
          name: "Rain",
          type: "nature",
          outcomes: ["true", "false"],
          properties: [],
        },
      ],
      definitions: [
        { for: "Rain", given: [], table: [0.2, 0.8], properties: [] },
      ],
    },
  ],
};

export const rainWetGrassFile: XmlBifFile = {
  version: "0.3",
  networks: [
    {
      name: "RainAndWetGrass",
      properties: [],
      variables: [
        {
          name: "Rain",
          type: "nature",
          outcomes: ["true", "false"],
          properties: [],
        },
        {
          name: "WetGrass",
          type: "nature",
          outcomes: ["wet", "dry"],
          properties: [],
        },
      ],
      definitions: [
        { for: "Rain", given: [], table: [0.2, 0.8], properties: [] },
        {
          for: "WetGrass",
          given: ["Rain"],
          table: [0.9, 0.1, 0.1, 0.9],
          properties: [],
        },
      ],
    },
  ],
};

export const multiParentFile: XmlBifFile = {
  version: "0.3",
  networks: [
    {
      name: "NonBinaryParents",
      properties: [],
      variables: [
        {
          name: "Weather",
          type: "nature",
          outcomes: ["sunny", "rainy"],
          properties: [],
        },
        {
          name: "Season",
          type: "nature",
          outcomes: ["spring", "summer", "winter"],
          properties: [],
        },
        {
          name: "Activity",
          type: "nature",
          outcomes: ["inside", "outside", "travel"],
          properties: [],
        },
      ],
      definitions: [
        { for: "Weather", given: [], table: [0.6, 0.4], properties: [] },
        {
          for: "Season",
          given: [],
          table: [0.25, 0.5, 0.25],
          properties: [],
        },
        {
          for: "Activity",
          given: ["Weather", "Season"],
          table: [
            0.1, 0.7, 0.2, 0.2, 0.5, 0.3, 0.3, 0.4, 0.3, 0.4, 0.2, 0.4, 0.5,
            0.1, 0.4, 0.6, 0.3, 0.1,
          ],
          properties: [],
        },
      ],
    },
  ],
};

export const propertiesFile: XmlBifFile = {
  version: "0.3",
  networks: [
    {
      name: "Properties",
      properties: [{ text: "author = Ada" }, { text: "unstructured text" }],
      variables: [
        {
          name: "LocatedNode",
          type: "nature",
          outcomes: ["yes", "no"],
          properties: [
            { text: "position = (73, 165)" },
            { text: "custom = preserve exactly" },
          ],
        },
      ],
      definitions: [
        {
          for: "LocatedNode",
          given: [],
          table: [0.5, 0.5],
          properties: [{ text: "definition note" }],
        },
      ],
    },
  ],
};

export const decisionUtilityFile: XmlBifFile = {
  version: "0.3",
  networks: [
    {
      name: "InfluenceNodes",
      properties: [],
      variables: [
        {
          name: "Choice",
          type: "decision",
          outcomes: ["go", "stay"],
          properties: [],
        },
        {
          name: "Value",
          type: "utility",
          outcomes: [],
          properties: [{ text: "preserve utility" }],
        },
      ],
      definitions: [
        { for: "Value", given: ["Choice"], table: [10, -2], properties: [] },
      ],
    },
  ],
};
