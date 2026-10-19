import { describe, expect, it } from "vitest";
import { parseJsonObject, REPORT_SECTION_IDS, validateReportEvidence, type ChatReport } from "../lib/report";

function makeReport(bodyOverrides: Partial<Record<(typeof REPORT_SECTION_IDS)[number], string>>): ChatReport {
  return {
    title: "A report about Maya and Sam",
    persona_name: "Ada",
    persona_description: "A careful outside read.",
    central_thesis: "Maya and Sam communicate clearly, but the small sample cannot establish a broader pattern.",
    safety_note: null,
    sections: REPORT_SECTION_IDS.map((id) => ({
      id,
      title: id.replaceAll("_", " "),
      body: bodyOverrides[id] ?? "Maya and Sam have a limited sample of messages to interpret.",
      evidence_message_ids: id === "short_version" ? [1] : [],
      quotes: [],
    })),
  };
}

describe("validateReportEvidence", () => {
  const messages = [{ message_id: 1, sender: "Sam", cleaned_text: "We can talk tomorrow." }];

  it("allows clearly labeled suggested wording that is not a source quote", () => {
    const report = makeReport({});
    report.sections.find((section) => section.id === "kind_next_moves")!.body =
      "One option is simple.\nA suggested script:\n“Could we make a plan together?” Here is a practical way to begin a clear conversation about timing, expectations, and what each person wants.";
    expect(validateReportEvidence(report, messages, ["Maya", "Sam"])).toEqual([]);
  });

  it("rejects unsupported quoted chat presented as fact", () => {
    const report = makeReport({
      short_version: "Sam said “We secretly moved to Paris.” Maya has not provided enough context.",
    });
    expect(validateReportEvidence(report, messages, ["Maya", "Sam"])).toContain(
      'Section "short_version" contains a quote not found verbatim in the source messages.',
    );
  });
});

describe("parseJsonObject", () => {
  it("extracts a JSON object from surrounding model prose and fences", () => {
    expect(parseJsonObject('Result follows:\n```json\n{"text":"a } inside a string"}\n```')).toEqual({
      text: "a } inside a string",
    });
  });
});
