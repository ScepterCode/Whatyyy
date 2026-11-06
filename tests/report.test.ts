import { describe, expect, it } from "vitest";
import { mergeReportParts, parseAnalystOutput, parseChatReport, parseJsonObject, REPORT_SECTION_IDS, validateReportEvidence, type ChatReport } from "../lib/report";

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
      'Section "short_version" contains a quote not found verbatim in the source messages: "We secretly moved to Paris.".',
    );
  });

  it("names the passage flagged as potentially unsafe advice", () => {
    const report = makeReport({ dynamic: "You could track where Sam goes after work." });
    expect(validateReportEvidence(report, messages, ["Maya", "Sam"])).toContain(
      'The report contains potentially unsafe advice: "you could track where sam goes after work.".',
    );
  });

  it("does not flag track or monitor when used as a noun", () => {
    for (const dynamic of [
      "You retreat behind formal salutations, and neither track completely dominates.",
      "Your communication follows a predictable track.",
      "The two of you are back on track after the apology.",
    ]) {
      const issues = validateReportEvidence(makeReport({ dynamic }), messages, ["Maya", "Sam"]);
      expect(issues.filter((issue) => issue.includes("unsafe advice"))).toEqual([]);
    }
  });

  it("still flags surveillance advice phrased with track or monitor", () => {
    for (const dynamic of [
      "You should track her phone for a week.",
      "You could monitor his messages.",
      "Try to keep track of where Sam goes.",
      "You can threaten to leave.",
    ]) {
      const issues = validateReportEvidence(makeReport({ dynamic }), messages, ["Maya", "Sam"]);
      expect(issues.some((issue) => issue.includes("unsafe advice"))).toBe(true);
    }
  });

  it("ignores leading and trailing punctuation inside body quotation marks", () => {
    const report = makeReport({
      short_version: "Sam answered, “We can talk tomorrow,” and Maya accepted the delay.",
      dynamic: "Sam's reply, \"...We can talk tomorrow!\" leaves the timing open.",
    });
    expect(
      validateReportEvidence(report, messages, ["Maya", "Sam"]).filter((issue) => issue.includes("quote")),
    ).toEqual([]);
  });

  it("still rejects body quotes whose words differ from the source", () => {
    const report = makeReport({
      short_version: "Sam answered, “We can talk tomorrow night,” and Maya accepted the delay.",
    });
    expect(validateReportEvidence(report, messages, ["Maya", "Sam"])).toContain(
      'Section "short_version" contains a quote not found verbatim in the source messages: "We can talk tomorrow night,".',
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

describe("parseAnalystOutput", () => {
  it("groups a flat findings list by its category tag", () => {
    const finding = {
      claim: "Sam proposes a time.",
      supporting_messages: [{ message_id: 1, sender: "Sam", quote: "We can talk tomorrow.", timestamp: null }],
      interpretation: "Sam may want to keep talking.",
      confidence: "low",
      alternative_interpretation: "Sam may just be busy today.",
      what_would_confirm_it: "Whether the talk happens.",
    };
    const analysis = parseAnalystOutput(
      {
        participants: ["Maya", "Sam"],
        relationship_type: "friendship",
        relationship_stage: "unknown",
        findings: [{ category: "repair_signals", ...finding }],
        uncertainty_flags: [],
        safety_flags: [],
      },
      ["Maya", "Sam"],
    );
    expect(analysis.findings.repair_signals).toHaveLength(1);
    expect(analysis.findings.major_themes).toEqual([]);
  });
});

describe("mergeReportParts", () => {
  it("keeps each half to its own section IDs so overruns cannot duplicate sections", () => {
    const { sections, ...header } = makeReport({});
    const openingIds = REPORT_SECTION_IDS.slice(0, 8);
    const closingIds = REPORT_SECTION_IDS.slice(8);
    const merged = mergeReportParts(
      { ...header, sections },
      { sections: [...sections.slice(0, 3), ...sections.slice(8), sections[9]] },
      openingIds,
      closingIds,
    );
    expect(parseChatReport(merged).sections.map((section) => section.id)).toEqual([...REPORT_SECTION_IDS]);
  });
});
