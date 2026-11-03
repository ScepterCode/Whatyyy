import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentResponse,
} from "@google/genai";
import { put } from "@vercel/blob";
import { FatalError } from "workflow";
import {
  analystSystemPrompt,
  narrativeSystemPrompt,
  PROMPT_VERSION,
  QUALITY_REVIEW_PROMPT,
  WRITER_PART_SECTION_IDS,
  writerSystemPrompt,
} from "../lib/pipeline-prompts";
import {
  checkReportPart,
  mergeReportParts,
  parseAnalystOutput,
  parseChatReport,
  parseJsonObject,
  parseNarrativeBrief,
  parseSafetyReview,
  ReportFormatError,
  validateReportEvidence,
  type AnalystOutput,
  type ChatReport,
  type NarrativeBrief,
  type ReportSettings,
  type SafetyReview,
} from "../lib/report";
import type { ChatStats } from "../lib/chat";
import type { NormalizedChatMetrics, NormalizedMessage } from "../lib/normalization";
import { getOwnerHash } from "../lib/storage/device-capability";
import type { StoredReport } from "../lib/storage/report-storage";

type SourceMessage = Pick<NormalizedMessage, "message_id" | "sender" | "cleaned_text">;
type ModelMessage = Pick<
  NormalizedMessage,
  | "message_id"
  | "sender"
  | "timestamp"
  | "message_type"
  | "cleaned_text"
  | "seconds_since_previous"
  | "is_conversation_starter"
  | "is_conversation_ender"
>;

export type AnalysisWorkflowInput = {
  reportId: string;
  ownerHash: string;
  participants: string[];
  selectedUser: string;
  settings: ReportSettings;
  messageCount: number;
  metrics: NormalizedChatMetrics;
  originalChatStats: ChatStats;
  normalizationNotes: string[];
  messages: ModelMessage[];
  sourceMessages: SourceMessage[];
};

type AnalysisWorkflowResult = {
  report: ChatReport;
  storedReport: StoredReport;
  storedRemotely: boolean;
};

const MODEL_CALL_TIMEOUT_MS = 55_000;
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const BLOCKED_FINISH_REASONS = new Set<FinishReason>([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
]);

function hasBlobConfiguration(): boolean {
  return Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
}

function filterAnalystEvidence(
  analysis: AnalystOutput,
  sourceMessages: SourceMessage[],
  participants: string[],
): AnalystOutput {
  const byId = new Map(sourceMessages.map((message) => [message.message_id, message]));
  for (const findings of Object.values(analysis.findings)) {
    for (let index = findings.length - 1; index >= 0; index -= 1) {
      const finding = findings[index];
      const supported = finding.supporting_messages.filter((reference) => {
        const source = byId.get(reference.message_id);
        return source && source.sender === reference.sender && source.cleaned_text.includes(reference.quote);
      });
      if (supported.length === 0) findings.splice(index, 1);
      else finding.supporting_messages = supported;
    }
  }
  analysis.participants = analysis.participants.filter((name) => participants.includes(name));
  if (analysis.participants.length === 0) analysis.participants = participants;
  analysis.safety_flags = analysis.safety_flags
    .map((flag) => {
      const exactQuote = flag.exact_quote;
      return {
        ...flag,
        message_ids: flag.message_ids.filter((id) => byId.has(id)),
        exact_quote:
          exactQuote && flag.message_ids.some((id) => byId.get(id)?.cleaned_text.includes(exactQuote))
            ? exactQuote
            : null,
      };
    })
    .filter((flag) => flag.message_ids.length > 0);
  return analysis;
}

function filterNarrativeEvidence(
  narrative: NarrativeBrief,
  sourceMessages: SourceMessage[],
): NarrativeBrief {
  const byId = new Map(sourceMessages.map((message) => [message.message_id, message]));
  const keepIds = (ids: number[]) => ids.filter((id) => byId.has(id));
  narrative.thesis_message_ids = keepIds(narrative.thesis_message_ids);
  narrative.key_turning_point.message_ids = keepIds(narrative.key_turning_point.message_ids);
  narrative.key_quotes = narrative.key_quotes.filter((quote) => {
    const source = byId.get(quote.message_id);
    return source && source.sender === quote.sender && source.cleaned_text.includes(quote.quote);
  });
  narrative.what_user_is_doing_wrong.forEach((point) => {
    point.message_ids = keepIds(point.message_ids);
  });
  narrative.what_user_is_doing_right.forEach((point) => {
    point.message_ids = keepIds(point.message_ids);
  });
  narrative.what_other_person_may_be_experiencing.forEach((point) => {
    point.message_ids = keepIds(point.message_ids);
  });
  narrative.kind_next_moves.forEach((move) => {
    move.message_ids = keepIds(move.message_ids);
  });
  return narrative;
}

type ModelReply = {
  content: string;
  // True when the model stopped because it hit max_tokens, so the reply is cut off.
  truncated: boolean;
};

async function requestModelStep(
  systemPrompt: string,
  userData: unknown,
  maxTokens: number,
): Promise<ModelReply> {
  "use step";

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new FatalError("Model access is not configured correctly. Check the server model settings.");
  }
  // No retryOptions: callStructuredModel owns retries, and SDK retries would overrun the step timeout.
  const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: MODEL_CALL_TIMEOUT_MS } });

  let response: GenerateContentResponse;
  try {
    response = await client.models.generateContent({
      model: process.env.MODEL_NAME || DEFAULT_MODEL,
      contents: JSON.stringify(userData),
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
        // Thinking tokens count toward maxOutputTokens and add latency; each stage returns bounded JSON.
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      // Gemini reports an invalid key as a 400, not a 401.
      const keyRejected =
        error.status === 401 || error.status === 403 || /API_KEY_INVALID|API key not valid/i.test(error.message);
      throw new FatalError(
        keyRejected
          ? "The model rejected the API key. Check your model settings."
          : `The model service returned an error (${error.status}). Try again in a moment.`,
      );
    }
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new FatalError("The model took too long to complete a pipeline stage. Try again.");
    }
    if (error instanceof TypeError) {
      throw new FatalError("Could not reach the configured model service. Check your connection and try again.");
    }
    throw error;
  }

  const finishReason = response.candidates?.[0]?.finishReason;
  if (response.promptFeedback?.blockReason || (finishReason && BLOCKED_FINISH_REASONS.has(finishReason))) {
    throw new FatalError("The model declined to analyze this conversation.");
  }
  const truncated = finishReason === FinishReason.MAX_TOKENS;
  const content = response.text ?? "";
  // A reply cut off during thinking can be empty; let the format retry handle it.
  if (!content && !truncated) throw new FatalError("The model service returned an empty response.");
  return { content, truncated };
}

async function callStructuredModel(
  systemPrompt: string,
  userData: unknown,
  maxTokens: number,
  checkShape?: (value: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  let formatProblem = "";
  let wasTruncated = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt =
      attempt === 0
        ? systemPrompt
        : wasTruncated
          ? `${systemPrompt}\nYour previous response ran out of room before the JSON object was complete. Write more concisely so the complete object fits, with every requested field and section and no surrounding prose or markdown.`
          : `${systemPrompt}\nYour previous response was not a complete JSON object matching the requested schema (${formatProblem}). Return a complete object with every requested field and section, with no surrounding prose or markdown.`;
    // The retry gets more room, capped so one call still finishes within the step timeout.
    const tokenLimit = attempt === 0 ? maxTokens : Math.min(6_000, Math.ceil(maxTokens * 1.5));
    const { content, truncated } = await requestModelStep(prompt, userData, tokenLimit);
    try {
      const value = parseJsonObject(content);
      checkShape?.(value);
      return value;
    } catch (error) {
      if (!(error instanceof ReportFormatError)) throw error;
      if (attempt === 1) {
        throw new FatalError(
          truncated
            ? `The model ran out of room for its reply (${tokenLimit.toLocaleString("en-US")}-token limit) after one retry. Try again.`
            : `The model returned invalid JSON after one format retry (${error.message}). Try again.`,
        );
      }
      formatProblem = error.message;
      wasTruncated = truncated;
    }
  }
  throw new FatalError("The model did not return a complete JSON response.");
}

function hasHighRiskFlags(analysis: AnalystOutput): boolean {
  return analysis.safety_flags.some((flag) => flag.severity === "high" || flag.severity === "imminent");
}

function isReviewApproved(review: SafetyReview, analysis: AnalystOutput): boolean {
  const hasSeriousIssues = review.issues.some(
    (issue) => issue.severity === "blocking" || issue.severity === "major",
  );
  const safetyHandled =
    !hasHighRiskFlags(analysis) ||
    (review.safety_assessment.safety_first_required &&
      Boolean(review.safety_assessment.user_safety_note));
  return review.decision === "pass" && !hasSeriousIssues && safetyHandled;
}

function applySafetyReview(report: ChatReport, review: SafetyReview, analysis: AnalystOutput): ChatReport {
  if (review.safety_assessment.user_safety_note) {
    report.safety_note = review.safety_assessment.user_safety_note;
  }
  if (
    (review.safety_assessment.safety_first_required || hasHighRiskFlags(analysis)) &&
    !report.safety_note
  ) {
    throw new FatalError("Quality review requires a safety-first note but did not provide one.");
  }
  return report;
}

function validateEvidence(report: ChatReport, input: AnalysisWorkflowInput): void {
  const issues = validateReportEvidence(report, input.sourceMessages, input.participants);
  if (issues.length) {
    throw new FatalError(`The report failed its evidence and safety checks after one repair pass. ${issues.join(" ")}`);
  }
}

async function saveReportStep(
  report: ChatReport,
  input: AnalysisWorkflowInput,
): Promise<{ storedReport: StoredReport; storedRemotely: boolean }> {
  "use step";

  const storedReport: StoredReport = {
    id: input.reportId,
    created_at: new Date().toISOString(),
    title: report.title,
    participants: input.participants,
    message_count: input.messageCount,
    settings: input.settings,
    report,
  };
  if (!hasBlobConfiguration()) return { storedReport, storedRemotely: false };

  await put(
    `reports/${input.ownerHash}/${input.reportId}.json`,
    JSON.stringify(storedReport),
    {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    },
  );
  return { storedReport, storedRemotely: true };
}

async function writeReport(
  input: AnalysisWorkflowInput,
  writerPayload: Record<string, unknown>,
  repairInstructions = "",
): Promise<ChatReport> {
  // A repair rewrites against a larger payload (previous report and issues), so it gets more room.
  const maxTokens = repairInstructions
    ? input.settings.depth === "deep_dive" ? 6_000 : 5_000
    : input.settings.depth === "deep_dive" ? 5_000 : 4_000;
  const [openingIds, closingIds] = WRITER_PART_SECTION_IDS;
  const opening = await callStructuredModel(
    writerSystemPrompt(input.settings, 1, repairInstructions),
    writerPayload,
    maxTokens,
    (value) => checkReportPart(value, openingIds, true),
  );
  const closing = await callStructuredModel(
    writerSystemPrompt(input.settings, 2, repairInstructions),
    { ...writerPayload, report_so_far: opening },
    maxTokens,
    (value) => checkReportPart(value, closingIds, false),
  );
  return parseChatReport(mergeReportParts(opening, closing, ...WRITER_PART_SECTION_IDS));
}

async function reviewReport(
  input: AnalysisWorkflowInput,
  report: ChatReport,
  analysis: AnalystOutput,
  narrative: NarrativeBrief,
): Promise<SafetyReview> {
  return parseSafetyReview(
    await callStructuredModel(
      QUALITY_REVIEW_PROMPT,
      {
        report,
        analysis,
        narrative,
        source_messages: input.sourceMessages,
        participants: input.participants,
        settings: input.settings,
      },
      // Reviews list issues, scores, and repair instructions, which overran 1,200 tokens.
      2_000,
    ),
  );
}

export async function analyzeConversation(
  input: AnalysisWorkflowInput,
): Promise<AnalysisWorkflowResult> {
  "use workflow";

  const analystPayload = {
    prompt_version: PROMPT_VERSION,
    participants: input.participants,
    selected_user: input.selectedUser,
    settings: input.settings,
    metrics: input.metrics,
    original_chat_stats: input.originalChatStats,
    normalization_notes: input.normalizationNotes,
    messages: input.messages,
  };
  const analysis = filterAnalystEvidence(
    parseAnalystOutput(
      await callStructuredModel(
        analystSystemPrompt(input.settings),
        analystPayload,
        // The prompt bounds findings to about 20 short entries, which fits within this cap.
        3_000,
      ),
      input.participants,
    ),
    input.sourceMessages,
    input.participants,
  );

  const narrative = filterNarrativeEvidence(
    parseNarrativeBrief(
      await callStructuredModel(
        narrativeSystemPrompt(input.settings),
        {
          analysis,
          metrics: input.metrics,
          participants: input.participants,
          selected_user: input.selectedUser,
        },
        1_800,
      ),
    ),
    input.sourceMessages,
  );
  if (hasHighRiskFlags(analysis)) narrative.safety_mode = true;

  const writerPayload = {
    analysis,
    narrative,
    participants: input.participants,
    selected_user: input.selectedUser,
    messages: input.sourceMessages,
    prompt_version: PROMPT_VERSION,
  };
  let report = await writeReport(input, writerPayload);

  // A draft that fails the exact-quote check goes straight to the single repair pass;
  // reviewing it first would only spend a model call on text that must be rewritten.
  const evidenceIssues = validateReportEvidence(report, input.sourceMessages, input.participants);
  let review = evidenceIssues.length ? null : await reviewReport(input, report, analysis, narrative);

  if (evidenceIssues.length || (review && review.decision !== "reject" && !isReviewApproved(review, analysis))) {
    const repairInstructions = [
      ...(evidenceIssues.length
        ? [
            "The automatic checker rejected the previous draft. Rewrite every passage listed below instead of copying it from previous_report: if the quoted text is suggested wording, put the label Suggested script: immediately before its opening quotation mark; if it is chat text, copy it character-for-character from the cited message; otherwise remove the quotation marks. If a passage is flagged as potentially unsafe advice, reword it so the flagged word no longer appears anywhere in the report.",
          ]
        : []),
      ...evidenceIssues,
      ...(review?.repair_instructions ?? []),
      ...(hasHighRiskFlags(analysis)
        ? ["Include compassionate, safety-first framing and do not minimize any high-risk safety flag."]
        : []),
    ];
    report = await writeReport(
      input,
      {
        ...writerPayload,
        previous_report: report,
        ...(review ? { review } : { evidence_issues: evidenceIssues }),
      },
      repairInstructions.join("\n"),
    );
    validateEvidence(report, input);
    review = await reviewReport(input, report, analysis, narrative);
  }

  if (!review || !isReviewApproved(review, analysis)) {
    throw new FatalError("The independent quality review did not approve this report.");
  }
  report = applySafetyReview(report, review, analysis);
  const saved = await saveReportStep(report, input);
  return { report, ...saved };
}
