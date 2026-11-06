import { ANALYST_CATEGORIES, type ReportSectionId } from "./report";

// JSON Schemas passed to the model so each stage's reply is well-formed JSON in the expected shape.
// Parsers and evidence checks in lib/report.ts remain the source of truth for validation.

const text = { type: "string" };
const nullableText = { type: ["string", "null"] };
const ids = { type: "array", items: { type: "integer" } };
const confidence = { type: "string", enum: ["low", "medium", "high"] };

function object(properties: Record<string, unknown>, optional: string[] = []) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
  };
}

// A flat tagged list: Gemini rejects a schema that repeats this shape under each of the 21 categories.
const finding = object({
  category: { type: "string", enum: [...ANALYST_CATEGORIES] },
  claim: text,
  supporting_messages: {
    type: "array",
    items: object({ message_id: { type: "integer" }, sender: text, quote: text, timestamp: nullableText }),
  },
  interpretation: text,
  confidence,
  alternative_interpretation: text,
  what_would_confirm_it: text,
});

export const ANALYST_SCHEMA = object({
  participants: { type: "array", items: text },
  relationship_type: text,
  relationship_stage: text,
  findings: { type: "array", items: finding },
  uncertainty_flags: { type: "array", items: text },
  safety_flags: {
    type: "array",
    items: object({
      category: text,
      severity: { type: "string", enum: ["low", "moderate", "high", "imminent"] },
      message_ids: ids,
      exact_quote: nullableText,
      concern: text,
      confidence,
    }),
  },
});

const evaluatedPoint = { type: "array", items: object({ point: text, message_ids: ids, confidence }) };

export const NARRATIVE_SCHEMA = object({
  report_title_candidates: { type: "array", items: text },
  central_thesis: text,
  thesis_message_ids: ids,
  thesis_confidence: confidence,
  core_dynamic: text,
  repeating_loop: text,
  person_a_role: text,
  person_b_role: text,
  person_a_inner_conflict: text,
  person_b_inner_conflict: text,
  key_turning_point: object({
    message_ids: ids,
    what_happened: text,
    interpretation: text,
    alternative_interpretation: text,
  }),
  key_quotes: {
    type: "array",
    items: object({ message_id: { type: "integer" }, sender: text, quote: text, timestamp: nullableText }),
  },
  unresolved_question: text,
  what_user_is_doing_wrong: evaluatedPoint,
  what_user_is_doing_right: evaluatedPoint,
  what_other_person_may_be_experiencing: evaluatedPoint,
  kind_next_moves: {
    type: "array",
    items: object({ action: text, message_ids: ids, example_words: nullableText }, ["example_words"]),
  },
  emotional_tone: text,
  report_length_target: text,
  safety_mode: { type: "boolean" },
});

export function writerSchema(sectionIds: readonly ReportSectionId[], includeHeader: boolean) {
  const sections = {
    type: "array",
    items: object({
      id: { type: "string", enum: [...sectionIds] },
      title: text,
      body: text,
      evidence_message_ids: ids,
      quotes: {
        type: "array",
        items: object({ message_id: { type: "integer" }, sender: text, text }),
      },
    }),
  };
  return includeHeader
    ? object({
        title: text,
        persona_name: text,
        persona_description: text,
        central_thesis: text,
        safety_note: nullableText,
        sections,
      })
    : object({ sections });
}

export const REVIEW_SCHEMA = object({
  decision: { type: "string", enum: ["pass", "revise", "reject"] },
  issues: {
    type: "array",
    items: object({
      code: text,
      severity: { type: "string", enum: ["blocking", "major", "minor"] },
      description: text,
      message_ids: ids,
    }),
  },
  quality_scores: object({
    specificity: { type: "integer" },
    evidence_grounding: { type: "integer" },
    thesis_coherence: { type: "integer" },
    voice_distinctiveness: { type: "integer" },
    actionability: { type: "integer" },
    name_accuracy: { type: "integer" },
  }),
  safety_assessment: object({
    risk_detected: { type: "boolean" },
    severity: { type: "string", enum: ["none", "ambiguous", "low", "moderate", "high", "imminent"] },
    message_ids: ids,
    safety_first_required: { type: "boolean" },
    user_safety_note: nullableText,
  }),
  repair_instructions: { type: "array", items: text },
});
