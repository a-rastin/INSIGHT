import { describe, expect, it } from "vitest";
import { detectXmlFidelityRisks } from "../src/domain/fidelity";

const codes = (source: string) =>
  detectXmlFidelityRisks(source).map(({ code }) => code);

describe("XML fidelity detection", () => {
  it("does not flag canonical XMLBIF content or arbitrary PROPERTY text", () => {
    expect(
      codes(`<?xml version="1.0"?>
        <BIF VERSION="0.3"><NETWORK><NAME>N</NAME>
          <PROPERTY>arbitrary = &lt;safe text&gt;</PROPERTY>
          <VARIABLE TYPE="chance"><NAME>legacy-id</NAME><OUTCOME>yes</OUTCOME></VARIABLE>
          <DEFINITION><FOR>legacy-id</FOR><TABLE>1e0</TABLE></DEFINITION>
        </NETWORK></BIF>`),
    ).toEqual([]);
  });

  it("detects comments, internal DTDs, processing instructions, and unknown XML", () => {
    const result = codes(`<?xml version="1.0"?>
      <!DOCTYPE BIF [<!ELEMENT BIF ANY>]>
      <!--keep me--><?application preserve?>
      <BIF VERSION="0.3" vendor="x"><NETWORK><NAME>N</NAME><VENDOR /></NETWORK></BIF>`);

    expect(result).toEqual(
      expect.arrayContaining([
        "XML_COMMENT",
        "XML_DOCTYPE",
        "XML_PROCESSING_INSTRUCTION",
        "UNKNOWN_XML_ATTRIBUTE",
        "UNKNOWN_XML_ELEMENT",
      ]),
    );
  });
});
