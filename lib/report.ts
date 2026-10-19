export const REPORT_SECTION_IDS = [
  "cold_open",
  "short_version",
  "dynamic",
  "when_it_shifted",
  "patterns",
  "read_on_you",
  "read_on_them",
  "what_you_are_doing_wrong",
  "what_you_are_doing_right",
  "real_time_reading",
  "linguistic_autopsy",
  "trial_of_key_date",
  "hard_truth",
  "kind_next_moves",
  "verdict",
] as const;

export type ReportSectionId = (typeof REPORT_SECTION_IDS)[number];

export type ChatReport = {
  title: string;
  persona_name: string;
  persona_description: string;
  central_thesis: string;
  sections: Array<{
    id: ReportSectionId;
    title: string;
    body: string;
    evidence_message_ids: number[];
    quotes: Array<{ message_id: number; sender: string; text: string }>;
  }>;
  safety_note: string | null;
};

export type EvidenceReference = {
  message_id: number;
  sender: string;
  quote: string;
  timestamp: string | null;
};

export type EvidenceFinding = {
  claim: string;
  supporting_messages: EvidenceReference[];
  interpretation: string;
  confidence: "low" | "medium" | "high";
  alternative_interpretation: string;
  what_would_confirm_it: string;
};

export const ANALYST_CATEGORIES = [
  "central_tension_candidates",
  "major_themes",
  "recurring_conflicts",
  "affection_signals",
  "reassurance_signals",
  "pursuit_signals",
  "withdrawal_signals",
  "avoidance_signals",
  "repair_signals",
  "boundary_signals",
  "misunderstandings",
  "emotional_escalation_points",
  "turning_points",
  "silence_events",
  "unanswered_questions",
  "repeated_phrases",
  "inside_jokes",
  "media_patterns",
  "linguistic_patterns",
  "timeline_events",
  "notable_quotes",
] as const;

export type AnalystCategory = (typeof ANALYST_CATEGORIES)[number];

export type AnalystOutput = {
  participants: string[];
  relationship_type: string;
  relationship_stage: string;
  findings: Record<AnalystCategory, EvidenceFinding[]>;
  uncertainty_flags: string[];
  safety_flags: Array<{
    category: string;
    severity: "low" | "moderate" | "high" | "imminent";
    message_ids: number[];
    exact_quote: string | null;
    concern: string;
    confidence: "low" | "medium" | "high";
  }>;
};

export type NarrativeBrief = {
  report_title_candidates: string[];
  central_thesis: string;
  thesis_message_ids: number[];
  thesis_confidence: "low" | "medium" | "high";
  core_dynamic: string;
  repeating_loop: string;
  person_a_role: string;
  person_b_role: string;
  person_a_inner_conflict: string;
  person_b_inner_conflict: string;
  key_turning_point: {
    message_ids: number[];
    what_happened: string;
    interpretation: string;
    alternative_interpretation: string;
  };
  key_quotes: EvidenceReference[];
  unresolved_question: string;
  what_user_is_doing_wrong: Array<{ point: string; message_ids: number[]; confidence: string }>;
  what_user_is_doing_right: Array<{ point: string; message_ids: number[]; confidence: string }>;
  what_other_person_may_be_experiencing: Array<{ point: string; message_ids: number[]; confidence: string }>;
  kind_next_moves: Array<{ action: string; message_ids: number[]; example_words: string | null }>;
  emotional_tone: string;
  report_length_target: string;
  safety_mode: boolean;
};

export type SafetyReview = {
  decision: "pass" | "revise" | "reject";
  issues: Array<{
    code: string;
    severity: "blocking" | "major" | "minor";
    description: string;
    message_ids: number[];
  }>;
  quality_scores: Record<string, number>;
  safety_assessment: {
    risk_detected: boolean;
    severity: "none" | "ambiguous" | "low" | "moderate" | "high" | "imminent";
    message_ids: number[];
    safety_first_required: boolean;
    user_safety_note: string | null;
  };
  repair_instructions: string[];
};

export type ReportSettings = {
  relationship_type: "romantic" | "friendship" | "family" | "group" | "workplace" | "unknown";
  tone: "gentle" | "direct" | "brutal_but_fair";
  depth: "standard" | "deep_dive" | "group_chat";
  language: string;
};

export class ReportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportFormatError";
  }
}

export function parseJsonObject(content: string): Record<string, unknown> {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const candidates = [cleaned];
  let cursor = 0;
  while (cursor < cleaned.length) {
    const start = cleaned.indexOf("{", cursor);
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < cleaned.length; index += 1) {
      const character = cleaned[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") inString = false;
        continue;
      }
      if (character === "\"") inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) break;
    candidates.push(cleaned.slice(start, end + 1));
    cursor = end + 1;
  }
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  throw new ReportFormatError("the model response was not a JSON object");
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getField(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const match = Object.keys(record).find(
      (candidate) => normalizeKey(candidate) === normalizeKey(name),
    );
    if (match) return record[match];
  }
  return undefined;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function parseEvidenceReference(value: unknown): EvidenceReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const message_id = getField(record, ["message_id", "id"]);
  const sender = asString(getField(record, ["sender", "participant", "name"]));
  const quote = asString(getField(record, ["quote", "text", "excerpt"]));
  const timestamp = getField(record, ["timestamp", "sent_at"]);
  if (
    typeof message_id !== "number" ||
    !Number.isInteger(message_id) ||
    !sender ||
    !quote
  ) {
    return null;
  }
  return {
    message_id,
    sender,
    quote,
    timestamp: typeof timestamp === "string" ? timestamp : null,
  };
}

function parseFinding(value: unknown): EvidenceFinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const claim = asString(getField(record, ["claim", "pattern", "observation"]));
  const interpretation = asString(getField(record, ["interpretation", "analysis", "read"]));
  const confidence = getField(record, ["confidence"]);
  const alternative_interpretation = asString(
    getField(record, ["alternative_interpretation", "alternative", "other_reading"]),
  );
  const what_would_confirm_it = asString(
    getField(record, ["what_would_confirm_it", "confirmation", "what_to_check"]),
  );
  const messages = getField(record, ["supporting_messages", "evidence", "messages"]);
  const supporting_messages = Array.isArray(messages)
    ? messages.map(parseEvidenceReference).filter((item): item is EvidenceReference => item !== null)
    : [];
  return claim && interpretation
    ? {
        claim,
        supporting_messages,
        interpretation,
        confidence:
          confidence === "high" || confidence === "medium" ? confidence : "low",
        alternative_interpretation: alternative_interpretation ?? "The evidence may support another reading.",
        what_would_confirm_it: what_would_confirm_it ?? "More surrounding conversation would help confirm this.",
      }
    : null;
}

export function parseAnalystOutput(
  value: Record<string, unknown>,
  participants: string[],
): AnalystOutput {
  const source = (getField(value, ["analyst_output", "analysis"]) as Record<string, unknown> | undefined) ?? value;
  const rawFindings = getField(source, ["findings"]);
  const findings = {} as Record<AnalystCategory, EvidenceFinding[]>;
  for (const category of ANALYST_CATEGORIES) {
    const raw = getField(
      rawFindings && typeof rawFindings === "object" && !Array.isArray(rawFindings)
        ? (rawFindings as Record<string, unknown>)
        : source,
      [category],
    );
    findings[category] = Array.isArray(raw)
      ? raw.map(parseFinding).filter((item): item is EvidenceFinding => item !== null).slice(0, 12)
      : [];
  }
  const rawSafety = getField(source, ["safety_flags"]);
  const safety_flags = Array.isArray(rawSafety)
    ? rawSafety.flatMap((flag) => {
        if (!flag || typeof flag !== "object" || Array.isArray(flag)) return [];
        const item = flag as Record<string, unknown>;
        const concern = asString(item.concern);
        if (!concern) return [];
        const severity: AnalystOutput["safety_flags"][number]["severity"] =
          item.severity === "imminent" || item.severity === "high" || item.severity === "moderate"
            ? item.severity
            : "low";
        const confidence: AnalystOutput["safety_flags"][number]["confidence"] =
          item.confidence === "high" || item.confidence === "medium" ? item.confidence : "low";
        return [{
          category: asString(item.category) ?? "other",
          severity,
          message_ids: Array.isArray(item.message_ids)
            ? item.message_ids.filter((id): id is number => Number.isInteger(id))
            : [],
          exact_quote: typeof item.exact_quote === "string" ? item.exact_quote : null,
          concern,
          confidence,
        }];
      })
    : [];

  return {
    participants: asStringArray(getField(source, ["participants"])).length
      ? asStringArray(getField(source, ["participants"]))
      : participants,
    relationship_type: asString(getField(source, ["relationship_type"])) ?? "unknown",
    relationship_stage: asString(getField(source, ["relationship_stage"])) ?? "unknown",
    findings,
    uncertainty_flags: asStringArray(getField(source, ["uncertainty_flags"])),
    safety_flags,
  };
}

function evidencePoints(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const point = asString(getField(record, ["point", "claim", "action"]));
    if (!point) return [];
    return [{
      point,
      message_ids: Array.isArray(record.message_ids)
        ? record.message_ids.filter((id): id is number => Number.isInteger(id))
        : [],
      confidence: asString(record.confidence) ?? "low",
    }];
  });
}

export function parseNarrativeBrief(value: Record<string, unknown>): NarrativeBrief {
  const source = (getField(value, ["narrative_brief", "brief"]) as Record<string, unknown> | undefined) ?? value;
  const thesis = asString(getField(source, ["central_thesis", "thesis"]));
  if (!thesis) throw new ReportFormatError("narrative synthesis did not produce a central thesis");
  const rawTurningPoint = getField(source, ["key_turning_point", "turning_point"]);
  const turning = rawTurningPoint && typeof rawTurningPoint === "object" && !Array.isArray(rawTurningPoint)
    ? (rawTurningPoint as Record<string, unknown>)
    : {};
  const rawQuotes = getField(source, ["key_quotes", "quotes"]);
  const rawMoves = getField(source, ["kind_next_moves", "next_moves", "nextMoves"]);

  return {
    report_title_candidates: asStringArray(getField(source, ["report_title_candidates", "titles"])),
    central_thesis: thesis,
    thesis_message_ids: Array.isArray(getField(source, ["thesis_message_ids", "evidence_message_ids"]))
      ? (getField(source, ["thesis_message_ids", "evidence_message_ids"]) as unknown[]).filter(
          (id): id is number => Number.isInteger(id),
        )
      : [],
    thesis_confidence:
      getField(source, ["thesis_confidence", "confidence"]) === "high" ||
      getField(source, ["thesis_confidence", "confidence"]) === "medium"
        ? (getField(source, ["thesis_confidence", "confidence"]) as "high" | "medium")
        : "low",
    core_dynamic: asString(getField(source, ["core_dynamic", "dynamic"])) ?? "The available evidence does not establish a repeating dynamic.",
    repeating_loop: asString(getField(source, ["repeating_loop", "loop"])) ?? "Not enough repeated evidence to identify a loop.",
    person_a_role: asString(getField(source, ["person_a_role"])) ?? "Not established by the evidence.",
    person_b_role: asString(getField(source, ["person_b_role"])) ?? "Not established by the evidence.",
    person_a_inner_conflict: asString(getField(source, ["person_a_inner_conflict"])) ?? "Unknown.",
    person_b_inner_conflict: asString(getField(source, ["person_b_inner_conflict"])) ?? "Unknown.",
    key_turning_point: {
      message_ids: Array.isArray(turning.message_ids)
        ? turning.message_ids.filter((id): id is number => Number.isInteger(id))
        : [],
      what_happened: asString(turning.what_happened) ?? "No turning point is established.",
      interpretation: asString(turning.interpretation) ?? "There is not enough evidence to interpret a turning point.",
      alternative_interpretation: asString(turning.alternative_interpretation) ?? "More context could change this reading.",
    },
    key_quotes: Array.isArray(rawQuotes)
      ? rawQuotes.map(parseEvidenceReference).filter((item): item is EvidenceReference => item !== null)
      : [],
    unresolved_question: asString(getField(source, ["unresolved_question"])) ?? "What context is missing from this conversation?",
    what_user_is_doing_wrong: evidencePoints(getField(source, ["what_user_is_doing_wrong"])),
    what_user_is_doing_right: evidencePoints(getField(source, ["what_user_is_doing_right"])),
    what_other_person_may_be_experiencing: evidencePoints(getField(source, ["what_other_person_may_be_experiencing"])),
    kind_next_moves: Array.isArray(rawMoves)
      ? rawMoves.flatMap((move) => {
          if (!move || typeof move !== "object" || Array.isArray(move)) return [];
          const item = move as Record<string, unknown>;
          const action = asString(getField(item, ["action", "move", "step"]));
          return action ? [{
            action,
            message_ids: Array.isArray(item.message_ids)
              ? item.message_ids.filter((id): id is number => Number.isInteger(id))
              : [],
            example_words: asString(getField(item, ["example_words", "script"])),
          }] : [];
        })
      : [],
    emotional_tone: asString(getField(source, ["emotional_tone"])) ?? "direct and humane",
    report_length_target: asString(getField(source, ["report_length_target"])) ?? "standard",
    safety_mode: getField(source, ["safety_mode"]) === true,
  };
}

function parseSection(value: unknown): ChatReport["sections"][number] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = getField(record, ["id", "section_id"]);
  const title = asString(getField(record, ["title", "heading"]));
  const body = asString(getField(record, ["body", "content", "text"]));
  if (
    typeof id !== "string" ||
    !REPORT_SECTION_IDS.includes(id as ReportSectionId) ||
    !title ||
    !body
  ) {
    return null;
  }
  const evidenceIds = getField(record, ["evidence_message_ids", "message_ids"]);
  const rawQuotes = getField(record, ["quotes"]);
  return {
    id: id as ReportSectionId,
    title,
    body,
    evidence_message_ids: Array.isArray(evidenceIds)
      ? evidenceIds.filter((item): item is number => Number.isInteger(item))
      : [],
    quotes: Array.isArray(rawQuotes)
      ? rawQuotes.flatMap((quote) => {
          if (!quote || typeof quote !== "object" || Array.isArray(quote)) return [];
          const item = quote as Record<string, unknown>;
          const message_id = getField(item, ["message_id", "id"]);
          const sender = asString(getField(item, ["sender", "name"]));
          const text = asString(getField(item, ["text", "quote"]));
          return typeof message_id === "number" && sender && text
            ? [{ message_id, sender, text }]
            : [];
        })
      : [],
  };
}

export function parseChatReport(value: Record<string, unknown>): ChatReport {
  const source = (getField(value, ["final_report", "report"]) as Record<string, unknown> | undefined) ?? value;
  const title = asString(getField(source, ["title"]));
  const central_thesis = asString(getField(source, ["central_thesis", "thesis"]));
  const rawSections = getField(source, ["sections"]);
  const sections = Array.isArray(rawSections)
    ? rawSections.map(parseSection).filter((item): item is ChatReport["sections"][number] => item !== null)
    : [];
  const errors: string[] = [];
  if (!title) errors.push("missing title");
  if (!central_thesis) errors.push("missing central thesis");
  if (sections.length !== REPORT_SECTION_IDS.length) errors.push("missing or malformed report sections");
  const ids = sections.map((section) => section.id);
  if (new Set(ids).size !== ids.length) errors.push("duplicate report section IDs");
  if (REPORT_SECTION_IDS.some((id, index) => ids[index] !== id)) errors.push("report sections are out of order");
  if (errors.length) throw new ReportFormatError(errors.join("; "));
  const persona_name = asString(getField(source, ["persona_name"])) ?? "Ada";
  return {
    title: title as string,
    persona_name,
    persona_description:
      asString(getField(source, ["persona_description"])) ??
      "An outside reader for the parts people leave between the lines.",
    central_thesis: central_thesis as string,
    sections,
    safety_note: asString(getField(source, ["safety_note"])),
  };
}

export function parseSafetyReview(value: Record<string, unknown>): SafetyReview {
  const source = (getField(value, ["safety_review", "review"]) as Record<string, unknown> | undefined) ?? value;
  const decision = getField(source, ["decision"]);
  const safety = getField(source, ["safety_assessment"]);
  const safetyRecord =
    safety && typeof safety === "object" && !Array.isArray(safety)
      ? (safety as Record<string, unknown>)
      : {};
  const issues = Array.isArray(source.issues)
    ? source.issues.flatMap((issue) => {
        if (!issue || typeof issue !== "object" || Array.isArray(issue)) return [];
        const item = issue as Record<string, unknown>;
        const description = asString(item.description);
        if (!description) return [];
        const severity: SafetyReview["issues"][number]["severity"] =
          item.severity === "blocking" || item.severity === "major" ? item.severity : "minor";
        return [{
          code: asString(item.code) ?? "other",
          severity,
          description,
          message_ids: Array.isArray(item.message_ids)
            ? item.message_ids.filter((id): id is number => Number.isInteger(id))
            : [],
        }];
      })
    : [];
  if (decision !== "pass" && decision !== "revise" && decision !== "reject") {
    throw new ReportFormatError("quality review did not return a valid decision");
  }
  const scores = source.quality_scores;
  return {
    decision,
    issues,
    quality_scores:
      scores && typeof scores === "object" && !Array.isArray(scores)
        ? Object.fromEntries(
            Object.entries(scores as Record<string, unknown>).filter(
              ([, score]) => typeof score === "number" && score >= 1 && score <= 5,
            ),
          ) as Record<string, number>
        : {},
    safety_assessment: {
      risk_detected: safetyRecord.risk_detected === true,
      severity:
        ["ambiguous", "low", "moderate", "high", "imminent"].includes(String(safetyRecord.severity))
          ? (safetyRecord.severity as SafetyReview["safety_assessment"]["severity"])
          : "none",
      message_ids: Array.isArray(safetyRecord.message_ids)
        ? safetyRecord.message_ids.filter((id): id is number => Number.isInteger(id))
        : [],
      safety_first_required: safetyRecord.safety_first_required === true,
      user_safety_note: asString(safetyRecord.user_safety_note),
    },
    repair_instructions: asStringArray(source.repair_instructions),
  };
}

export function validateReportEvidence(
  report: ChatReport,
  sourceMessages: Array<{ message_id: number; sender: string; cleaned_text: string }>,
  participants: string[],
): string[] {
  const issues: string[] = [];
  const byId = new Map(sourceMessages.map((message) => [message.message_id, message]));
  const reportText = [
    report.title,
    report.central_thesis,
    ...report.sections.flatMap((section) => [section.title, section.body]),
  ].join("\n");

  if (report.central_thesis.trim().length < 30) issues.push("The central thesis is too short to express a specific interpretation.");
  if (participants.length <= 2) {
    for (const participant of participants) {
      if (!reportText.toLocaleLowerCase().includes(participant.toLocaleLowerCase())) {
        issues.push(`The report does not mention participant "${participant}".`);
      }
    }
  }

  for (const section of report.sections) {
    for (const id of section.evidence_message_ids) {
      if (!byId.has(id)) issues.push(`Section "${section.id}" cites unknown message ${id}.`);
    }
    for (const quote of section.quotes) {
      const source = byId.get(quote.message_id);
      if (!source) {
        issues.push(`Section "${section.id}" quotes unknown message ${quote.message_id}.`);
      } else if (source.sender !== quote.sender || !source.cleaned_text.includes(quote.text)) {
        issues.push(`Section "${section.id}" contains an unsupported quote for message ${quote.message_id}.`);
      }
    }
    for (const match of section.body.matchAll(/[“"]([^”"]{8,})[”"]/g)) {
      const quoted = match[1];
      const precedingText = section.body
        .slice(Math.max(0, (match.index ?? 0) - 100), match.index)
        .trimEnd();
      const isSuggestedScript =
        /(?:suggested script|sample wording|possible script|suggested wording|example script|example wording|you could say|you might say|try saying)[^“"]{0,300}$/i.test(
          precedingText,
        );
      if (
        !isSuggestedScript &&
        !sourceMessages.some((message) => message.cleaned_text.includes(quoted))
      ) {
        issues.push(`Section "${section.id}" contains a quote not found verbatim in the source messages.`);
      }
    }
  }
  const shortVersion = report.sections.find((section) => section.id === "short_version");
  if (!shortVersion || shortVersion.evidence_message_ids.length === 0) {
    issues.push("The central thesis section does not cite any source messages.");
  }

  const combined = reportText.toLocaleLowerCase();
  if (/\b(?:is|are|you(?:'re| are))\s+(?:a\s+)?(?:narcissist|borderline|sociopath|psychopath)\b/.test(combined)) {
    issues.push("The report appears to diagnose or label a person.");
  }
  if (/\b(?:track|monitor|spy on|hack|blackmail|threaten|get revenge on)\b/.test(combined)) {
    issues.push("The report contains potentially unsafe advice.");
  }
  const nextMoves = report.sections.find((section) => section.id === "kind_next_moves");
  if (!nextMoves || nextMoves.body.trim().length < 80) {
    issues.push("The report lacks specific, useful next steps.");
  }
  return [...new Set(issues)];
}
