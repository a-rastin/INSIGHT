import { describe, expect, it } from "vitest";
import type { XmlBifFile } from "../src/domain/model";
import { parseXmlBif } from "../src/domain/parser";
import { serializeXmlBif } from "../src/domain/serializer";
import {
  decisionUtilityFile,
  multiParentFile,
  propertiesFile,
  rainRootFile,
} from "./fixtures/domainFixtures";

function parse(source: string): XmlBifFile {
  const result = parseXmlBif(source);
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  return result.file;
}

function semanticFile(file: XmlBifFile): XmlBifFile {
  return {
    ...file,
    networks: file.networks.map((network) => ({
      ...network,
      variables: network.variables.map((variable) => ({
        name: variable.name,
        type: variable.type,
        outcomes: variable.outcomes,
        properties: variable.properties,
      })),
    })),
  };
}

describe("serializeXmlBif", () => {
  it("produces deterministic canonical XML", () => {
    const expected = `<?xml version="1.0" encoding="UTF-8"?>
<BIF VERSION="0.3">
  <NETWORK>
    <NAME>RainRoot</NAME>
    <VARIABLE TYPE="nature">
      <NAME>Rain</NAME>
      <OUTCOME>true</OUTCOME>
      <OUTCOME>false</OUTCOME>
    </VARIABLE>
    <DEFINITION>
      <FOR>Rain</FOR>
      <TABLE>0.2 0.8</TABLE>
    </DEFINITION>
  </NETWORK>
</BIF>
`;

    expect(serializeXmlBif(rainRootFile)).toBe(expected);
    expect(serializeXmlBif(rainRootFile)).toBe(serializeXmlBif(rainRootFile));
  });

  it.each([rainRootFile, propertiesFile, multiParentFile])(
    "round-trips fixture semantics and ordering",
    (file) => {
      expect(semanticFile(parse(serializeXmlBif(file)))).toEqual(
        semanticFile(file),
      );
    },
  );

  it("canonicalizes historical XML while preserving semantics", () => {
    const source = `<?xml version="1.0"?>
      <BIF VERSION="0.3"><NETWORK>
        <NAME>Historical</NAME><PROPERTY>network note</PROPERTY>
        <VARIABLE TYPE="nature"><NAME>A</NAME><OUTCOME>a0</OUTCOME><OUTCOME>a1</OUTCOME></VARIABLE>
        <VARIABLE TYPE="nature"><NAME>B</NAME><OUTCOME>b0</OUTCOME><OUTCOME>b1</OUTCOME><OUTCOME>b2</OUTCOME></VARIABLE>
        <DEFINITION><FOR>B</FOR><GIVEN>A</GIVEN><TABLE>1e-1 .2 .7 .3 .3 .4</TABLE><PROPERTY>definition note</PROPERTY></DEFINITION>
      </NETWORK></BIF>`;
    const original = parse(source);

    expect(semanticFile(parse(serializeXmlBif(original)))).toEqual(
      semanticFile(original),
    );
  });

  it("serializes chance input canonically as nature", () => {
    const parsed = parse(`<BIF VERSION="0.3"><NETWORK><NAME>N</NAME>
      <VARIABLE TYPE="chance"><NAME>C</NAME><OUTCOME>yes</OUTCOME></VARIABLE>
      <DEFINITION><FOR>C</FOR><TABLE>1</TABLE></DEFINITION>
    </NETWORK></BIF>`);
    const output = serializeXmlBif(parsed);

    expect(output).toContain('<VARIABLE TYPE="nature">');
    expect(output).not.toContain('TYPE="chance"');
    expect(semanticFile(parse(output))).toEqual(semanticFile(parsed));
  });

  it("escapes text and preserves arbitrary property text", () => {
    const file = structuredClone(rainRootFile);
    const network = file.networks[0];
    network.name = "A & B <network>";
    network.properties = [{ text: ` raw & <xml> > "quote" 'apostrophe' ` }];
    network.variables[0].name = "Rain & Snow";
    network.variables[0].outcomes = ["<yes>", "no & maybe"];
    network.variables[0].properties = [{ text: "π & λ" }];
    network.definitions[0].for = "Rain & Snow";

    const output = serializeXmlBif(file);
    expect(output).toContain("A &amp; B &lt;network&gt;");
    expect(parse(output)).toEqual(file);
  });

  it("preserves multi-parent non-binary TABLE and GIVEN order", () => {
    const network = parse(serializeXmlBif(multiParentFile)).networks[0];

    expect(network.definitions[2].given).toEqual(["Weather", "Season"]);
    expect(network.definitions[2].table).toEqual(
      multiParentFile.networks[0].definitions[2].table,
    );
  });

  it("preserves decision and utility fields and raw tables", () => {
    const file = structuredClone(decisionUtilityFile);
    file.networks[0].variables.unshift({
      name: "Nature",
      type: "nature",
      outcomes: ["yes", "no"],
      properties: [],
    });
    file.networks[0].definitions.unshift({
      for: "Nature",
      given: [],
      table: [0.4, 0.6],
      properties: [],
    });

    const roundTripped = parse(serializeXmlBif(file));
    expect(roundTripped.networks[0].variables.slice(1)).toEqual(
      decisionUtilityFile.networks[0].variables,
    );
    expect(roundTripped.networks[0].definitions[1].table).toEqual([10, -2]);
  });

  it("preserves multiple network order", () => {
    const file: XmlBifFile = {
      version: "0.3",
      networks: [
        rainRootFile.networks[0],
        { ...propertiesFile.networks[0], name: "Second" },
      ],
    };

    expect(
      parse(serializeXmlBif(file)).networks.map(({ name }) => name),
    ).toEqual(["RainRoot", "Second"]);
  });

  it("rejects unsupported versions and non-finite TABLE values", () => {
    expect(() => serializeXmlBif({ ...rainRootFile, version: "0.2" })).toThrow(
      "Unsupported XMLBIF version: 0.2",
    );

    const invalid = structuredClone(rainRootFile);
    invalid.networks[0].definitions[0].table[0] = Number.NaN;
    expect(() => serializeXmlBif(invalid)).toThrow(
      "TABLE values must be finite numbers",
    );
  });
});
