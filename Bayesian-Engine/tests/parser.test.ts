import { describe, expect, it } from "vitest";
import { MAX_XMLBIF_SOURCE_BYTES } from "../src/domain/inputLimits";
import type { ParseSuccess } from "../src/domain/parser";
import { parseXmlBif } from "../src/domain/parser";

function expectSuccess(source: string): ParseSuccess {
  const result = parseXmlBif(source);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  return result;
}

describe("parseXmlBif", () => {
  it("parses a minimal file without inventing missing content", () => {
    const result = expectSuccess(`<?xml version="1.0"?>
      <BIF VERSION="0.3"><NETWORK><NAME>Minimal</NAME></NETWORK></BIF>`);

    expect(result.file).toEqual({
      version: "0.3",
      networks: [
        {
          name: "Minimal",
          properties: [],
          variables: [],
          definitions: [],
        },
      ],
    });
  });

  it("preserves network, variable, outcome, definition, and parent order", () => {
    const result = expectSuccess(`<BIF VERSION="0.3">
      <NETWORK>
        <NAME>First</NAME>
        <VARIABLE TYPE="nature"><NAME>A</NAME><OUTCOME>a0</OUTCOME><OUTCOME>a1</OUTCOME></VARIABLE>
        <VARIABLE><NAME>B</NAME><OUTCOME>b0</OUTCOME><OUTCOME>b1</OUTCOME><OUTCOME>b2</OUTCOME></VARIABLE>
        <VARIABLE TYPE="nature"><NAME>X</NAME><OUTCOME>x2</OUTCOME><OUTCOME>x1</OUTCOME><OUTCOME>x0</OUTCOME></VARIABLE>
        <DEFINITION><FOR>A</FOR><TABLE>0.5 0.5</TABLE></DEFINITION>
        <DEFINITION><FOR>X</FOR><GIVEN>A</GIVEN><GIVEN>B</GIVEN><TABLE>0 1 2</TABLE></DEFINITION>
      </NETWORK>
      <NETWORK><NAME>Second</NAME></NETWORK>
    </BIF>`);

    expect(result.file.networks.map(({ name }) => name)).toEqual([
      "First",
      "Second",
    ]);
    expect(result.file.networks[0].variables.map(({ name }) => name)).toEqual([
      "A",
      "B",
      "X",
    ]);
    expect(result.file.networks[0].variables[2].outcomes).toEqual([
      "x2",
      "x1",
      "x0",
    ]);
    expect(result.file.networks[0].variables[1].type).toBe("nature");
    expect(
      result.file.networks[0].definitions.map(({ for: name }) => name),
    ).toEqual(["A", "X"]);
    expect(result.file.networks[0].definitions[1].given).toEqual(["A", "B"]);
  });

  it("maps chance to nature and preserves decision and utility types", () => {
    const result = expectSuccess(`<BIF VERSION="0.3"><NETWORK><NAME>Types</NAME>
      <VARIABLE TYPE="chance"><NAME>C</NAME></VARIABLE>
      <VARIABLE TYPE="decision"><NAME>D</NAME></VARIABLE>
      <VARIABLE TYPE="utility"><NAME>U</NAME></VARIABLE>
    </NETWORK></BIF>`);

    expect(result.file.networks[0].variables).toMatchObject([
      { name: "C", type: "nature", sourceType: "chance" },
      { name: "D", type: "decision" },
      { name: "U", type: "utility" },
    ]);
  });

  it("parses whitespace-separated decimal and scientific TABLE numbers", () => {
    const result =
      expectSuccess(`<BIF VERSION="0.3"><NETWORK><NAME>Numbers</NAME>
      <DEFINITION><FOR>X</FOR><TABLE>
        1\t-2.5  +.25
        6.02e2 1E-3
      </TABLE></DEFINITION>
    </NETWORK></BIF>`);

    expect(result.file.networks[0].definitions[0].table).toEqual([
      1, -2.5, 0.25, 602, 0.001,
    ]);
  });

  it("preserves arbitrary PROPERTY text and decodes XML entities", () => {
    const result = expectSuccess(`<BIF VERSION="0.3"><NETWORK>
      <NAME>A &amp; B</NAME>
      <PROPERTY>  arbitrary = &lt;keep&gt;  </PROPERTY>
      <VARIABLE TYPE="nature"><NAME>X</NAME><OUTCOME>yes &amp; no</OUTCOME><PROPERTY>π = λ</PROPERTY></VARIABLE>
      <DEFINITION><FOR>X</FOR><TABLE>1</TABLE><PROPERTY>raw text</PROPERTY></DEFINITION>
    </NETWORK></BIF>`);
    const network = result.file.networks[0];

    expect(network.name).toBe("A & B");
    expect(network.properties).toEqual([{ text: "  arbitrary = <keep>  " }]);
    expect(network.variables[0].outcomes).toEqual(["yes & no"]);
    expect(network.variables[0].properties).toEqual([{ text: "π = λ" }]);
    expect(network.definitions[0].properties).toEqual([{ text: "raw text" }]);
  });

  it("uses the last TABLE and emits a stable warning", () => {
    const result =
      expectSuccess(`<BIF VERSION="0.3"><NETWORK><NAME>Tables</NAME>
      <DEFINITION><FOR>X</FOR><TABLE>0 1</TABLE><TABLE>0.25 0.75</TABLE></DEFINITION>
    </NETWORK></BIF>`);

    expect(result.file.networks[0].definitions[0].table).toEqual([0.25, 0.75]);
    expect(result.warnings).toMatchObject([
      {
        code: "MULTIPLE_TABLES",
        severity: "warning",
        definitionFor: "X",
      },
    ]);
  });

  it("accepts internal DOCTYPE declarations without fetching resources", () => {
    const result = expectSuccess(`<?xml version="1.0"?>
      <!DOCTYPE BIF [
        <!ELEMENT BIF (NETWORK*)>
        <!ATTLIST BIF VERSION CDATA #REQUIRED>
        <!ELEMENT NETWORK (NAME)>
        <!ELEMENT NAME (#PCDATA)>
      ]>
      <BIF VERSION="0.3"><NETWORK><NAME>Safe</NAME></NETWORK></BIF>`);

    expect(result.file.networks[0].name).toBe("Safe");
  });

  it("does not resolve external entities", () => {
    const result = parseXmlBif(`<!DOCTYPE BIF [
      <!ENTITY external SYSTEM "file:///etc/passwd">
    ]><BIF VERSION="0.3"><NETWORK><NAME>&external;</NAME></NETWORK></BIF>`);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected external entity to be rejected");
    expect(result.diagnostics[0].code).toBe("XML_MALFORMED");
    expect(result.diagnostics[0].message).not.toContain("root:");
  });

  it("rejects source above the documented size limit before parsing", () => {
    const result = parseXmlBif(" ".repeat(MAX_XMLBIF_SOURCE_BYTES + 1));

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: "SOURCE_TOO_LARGE" }],
    });
  });

  it.each([
    ["malformed XML", "<BIF><NETWORK></BIF>", "XML_MALFORMED"],
    ["wrong root", "<XMLBIF />", "ROOT_NOT_BIF"],
    [
      "unsupported TYPE",
      '<BIF VERSION="0.3"><NETWORK><NAME>N</NAME><VARIABLE TYPE="continuous"><NAME>X</NAME></VARIABLE></NETWORK></BIF>',
      "UNSUPPORTED_VARIABLE_TYPE",
    ],
    [
      "invalid TABLE token",
      '<BIF VERSION="0.3"><NETWORK><NAME>N</NAME><DEFINITION><FOR>X</FOR><TABLE>0.5 nope</TABLE></DEFINITION></NETWORK></BIF>',
      "INVALID_TABLE_NUMBER",
    ],
    [
      "non-finite TABLE result",
      '<BIF VERSION="0.3"><NETWORK><NAME>N</NAME><DEFINITION><FOR>X</FOR><TABLE>1e999</TABLE></DEFINITION></NETWORK></BIF>',
      "INVALID_TABLE_NUMBER",
    ],
  ])("returns a diagnostic for %s", (_name, source, code) => {
    const result = parseXmlBif(source);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected parsing to fail");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      code,
    );
  });
});
