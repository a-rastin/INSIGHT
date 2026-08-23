import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import {
  MAX_XMLBIF_ELEMENTS,
  MAX_XMLBIF_NESTING_DEPTH,
  MAX_XMLBIF_SOURCE_BYTES,
  edgesOf,
  expectedTableLength,
  hashXmlBifSemantics,
  insertAxis,
  parseXmlBif,
  permuteAxes,
  permuteAxisStates,
  removeAxisIfLossless,
  serializeXmlBif,
  validateFile,
  validateProbabilities,
  validateStructure,
} from "../dist/index.js";

const source = `<BIF VERSION="0.3"><NETWORK><NAME>N</NAME>
  <VARIABLE TYPE="nature"><NAME>A</NAME><OUTCOME>yes</OUTCOME><OUTCOME>no</OUTCOME></VARIABLE>
  <VARIABLE TYPE="chance"><NAME>B</NAME><OUTCOME>b0</OUTCOME><OUTCOME>b1</OUTCOME></VARIABLE>
  <DEFINITION><FOR>A</FOR><TABLE>0.25 0.75</TABLE></DEFINITION>
  <DEFINITION><FOR>B</FOR><GIVEN>A</GIVEN><TABLE>0.1 0.9 0.8 0.2</TABLE></DEFINITION>
</NETWORK></BIF>`;

function parse(text) {
  const result = parseXmlBif(text);
  assert.equal(result.ok, true, result.ok ? undefined : result.diagnostics[0]?.message);
  return result.file;
}

function semantic(file) {
  return {
    ...file,
    networks: file.networks.map((network) => ({
      ...network,
      variables: network.variables.map((variable) => {
        const canonical = { ...variable };
        delete canonical.sourceType;
        return canonical;
      }),
    })),
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

test("parser and serializer preserve semantic order and canonicalize chance", () => {
  const file = parse(source);
  assert.deepEqual(
    file.networks[0].variables.map(({ name }) => name),
    ["A", "B"],
  );
  assert.deepEqual(file.networks[0].definitions[1].given, ["A"]);
  assert.deepEqual(edgesOf(file.networks[0]), [{ source: "A", target: "B" }]);
  const serialized = serializeXmlBif(file);
  assert.match(serialized, /<VARIABLE TYPE="nature">/);
  assert.doesNotMatch(serialized, /chance/);
  assert.deepEqual(semantic(parse(serialized)), semantic(file));
  assert.equal(serializeXmlBif(parse(serialized)), serialized);
});

test("CPT dimensions and probability normalization are validated", () => {
  const file = parse(source);
  assert.equal(expectedTableLength(file.networks[0], file.networks[0].definitions[1]), 4);
  assert.deepEqual(validateFile(file), []);
  file.networks[0].definitions[1].table = [0.1, 0.8, 0.8, 0.2];
  assert.deepEqual(
    validateProbabilities(file).map(({ code }) => code),
    ["CPT_DISTRIBUTION_NOT_NORMALIZED"],
  );
});

test("structural validation reports duplicates, references, and graph cycles", () => {
  const file = parse(source);
  file.networks[0].variables.push(clone(file.networks[0].variables[0]));
  file.networks[0].definitions[1].given.push("Missing");
  file.networks[0].definitions[0].given.push("B");
  const codes = validateStructure(file).map(({ code }) => code);
  assert.ok(codes.includes("DUPLICATE_VARIABLE_NAME"));
  assert.ok(codes.includes("UNKNOWN_PARENT"));
  assert.ok(codes.includes("GRAPH_CYCLE"));
});

test("tensor transforms preserve exact row-major arrays", () => {
  const values = Array.from({ length: 12 }, (_, index) => index);
  assert.deepEqual(
    permuteAxes(values, [2, 3, 2], [1, 0, 2]),
    [0, 1, 6, 7, 2, 3, 8, 9, 4, 5, 10, 11],
  );
  assert.deepEqual(
    permuteAxisStates(values, [2, 3, 2], 1, [2, 1, 0]),
    [4, 5, 2, 3, 0, 1, 10, 11, 8, 9, 6, 7],
  );
  assert.deepEqual(
    insertAxis([10, 11, 20, 21], [2, 2], 1, 3),
    [10, 11, 10, 11, 10, 11, 20, 21, 20, 21, 20, 21],
  );
  assert.deepEqual(
    removeAxisIfLossless([10, 11, 10, 11, 10, 11, 20, 21, 20, 21, 20, 21], [2, 3, 2], 1),
    [10, 11, 20, 21],
  );
});

test("safe XML accepts harmless DTD but rejects entity use", () => {
  const harmless = parseXmlBif(`<!DOCTYPE BIF [<!ELEMENT BIF (NETWORK*)>]>
    <BIF VERSION="0.3"><NETWORK><NAME>Safe</NAME></NETWORK></BIF>`);
  assert.equal(harmless.ok, true);
  for (const entity of [
    `<!DOCTYPE BIF [<!ENTITY external SYSTEM "file:///etc/passwd">]><BIF VERSION="0.3"><NETWORK><NAME>&external;</NAME></NETWORK></BIF>`,
    `<BIF VERSION="0.3"><NETWORK><NAME>&unknown;</NAME></NETWORK></BIF>`,
  ]) {
    const result = parseXmlBif(entity);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, "XML_MALFORMED");
    assert.doesNotMatch(result.diagnostics[0].message, /root:/);
  }
});

test("XML source, nesting, and element limits return stable diagnostics", () => {
  assert.equal(
    parseXmlBif(" ".repeat(MAX_XMLBIF_SOURCE_BYTES + 1)).diagnostics[0].code,
    "SOURCE_TOO_LARGE",
  );
  const depth = `<BIF>${"<X>".repeat(MAX_XMLBIF_NESTING_DEPTH)}</X></BIF>`;
  assert.equal(parseXmlBif(depth).diagnostics[0].code, "XML_DEPTH_LIMIT");
  const elements = `<BIF>${"<X/>".repeat(MAX_XMLBIF_ELEMENTS)}</BIF>`;
  assert.equal(parseXmlBif(elements).diagnostics[0].code, "XML_ELEMENT_LIMIT");
});

test("semantic SHA-256 is stable and excludes formatting and chance alias metadata", async () => {
  const canonical = parse(source);
  const formattedChance = parse(`<?xml version="1.0"?>\n${source.replaceAll("nature", "chance")}`);
  assert.equal(
    await hashXmlBifSemantics(canonical),
    "d1f5f0a15ed8f3e165d049a9d57425d0ea3123e9878f7d65f8bacca72d5b2705",
  );
  assert.equal(await hashXmlBifSemantics(formattedChance), await hashXmlBifSemantics(canonical));
  const changed = clone(canonical);
  changed.networks[0].definitions[0].table = [0.5, 0.5];
  assert.notEqual(await hashXmlBifSemantics(changed), await hashXmlBifSemantics(canonical));
});

const fixtureDiagnostics = {
  "10 - Long Acting Antipsychotic Medications/gemini-code-1783423101383.xml": ["CPT_TABLE_LENGTH"],
  "11 - Acute Dystonia & anticholinergic therapy/gemini-code-1783438905589.xml": [],
  "12 - Treatments for Parkinsonism/gemini-code-1783423778176.xml": [],
  "13 - Treatments for Akathesia/gemini-code-1783423969512.xml": [],
  "14 - VMAT2 Medications for Tardive Dyskinesia/vmat2_tardive_dyskinesia_bn.xml": Array(7).fill(
    "CPT_DISTRIBUTION_NOT_NORMALIZED",
  ),
  "5 - Continuing Medications/gemini-code-1783421787562.xml": ["CPT_TABLE_LENGTH"],
  "6 - Continuing the Same Medication/gemini-code-1783439886327.xml": [],
  "7 - Clozapine in Treatment-Resistant Schizophrenia/gemini-code-1783422447172.xml":
    Array(3).fill("CPT_TABLE_LENGTH"),
  "9 - Clozapine in Aggressive Behavior _/gemini-code-1783422744909.xml": [],
  "Clozapine in Suicide Risk/BN-Clozapine-in-Suicide-Risk.xml": [],
  "Involuntary-Treatment-Considerations/BN-Involuntary-Treatment-Considerations.xml":
    Array(2).fill("CPT_TABLE_LENGTH"),
  "Pharmacotherapy/BN-Pharmacotherapy.xml": [],
  "Treatment-Setting/BN-Treatment-Setting.xml": Array(4).fill("CPT_TABLE_LENGTH"),
};

test("all 13 repository XML fixtures parse with deterministic honest parity", async () => {
  const root = new URL("../../../BNs/", import.meta.url);
  const names = (await readdir(root, { recursive: true }))
    .filter((name) => name.endsWith(".xml"))
    .sort();
  assert.equal(names.length, 13);
  assert.deepEqual(names, Object.keys(fixtureDiagnostics));
  for (const name of names) {
    const parsed = parseXmlBif(await readFile(new URL(name, root), "utf8"));
    assert.equal(parsed.ok, true, name);
    assert.deepEqual(parsed.warnings, [], name);
    assert.deepEqual(
      validateFile(parsed.file).map(({ code }) => code),
      fixtureDiagnostics[name],
      name,
    );
    if (parsed.file.version === "0.3") {
      assert.deepEqual(semantic(parse(serializeXmlBif(parsed.file))), semantic(parsed.file), name);
    } else assert.equal(parsed.file.version, "1.0", name);
  }
});
