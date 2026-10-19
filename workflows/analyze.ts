import { put } from "@vercel/blob";
import { FatalError } from "workflow";
import {
  analystSystemPrompt,
  narrativeSystemPrompt,
  PROMPT_VERSION,
  QUALITY_REVIEW_PROMPT,
  writerSystemPrompt,
} from "../lib/pipeline-prompts";
import {
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

function getResponseContent(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const choices = (result as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

function isSecureModelUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

async function requestModelStep(
  systemPrompt: string,
  userData: unknown,
  maxTokens: number,
): Promise<string> {
  "use step";

  const apiUrl = process.env.MODEL_API_URL;
  const apiKey = process.env.MODEL_API_KEY;
  const model = process.env.MODEL_NAME;
  if (!apiUrl || !apiKey || !model || !isSecureModelUrl(apiUrl)) {
    throw new FatalError("Model access is not configured correctly. Check the server model settings.");
  }

  let response: Response;
  try {
    const nvidiaOptions =
      new URL(apiUrl).hostname === "integrate.api.nvidia.com" ||
      model.toLowerCase().startsWith("nvidia/")
        ? {
            chat_template_kwargs: { enable_thinking: true, low_effort: true },
            reasoning_budget: 1_024,
          }
        : {};
    response = await fetch(apiUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: maxTokens,
        ...nvidiaOptions,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userData) },
        ],
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new FatalError("The model took too long to complete a pipeline stage. Try again.");
    }
    if (error instanceof TypeError) {
      throw new FatalError("Could not reach the configured model service. Check its URL and try again.");
    }
    throw error;
  }

  if (!response.ok) {
    const status = response.status;
    throw new FatalError(
      status === 401 || status === 403
        ? "The model rejected the API key. Check your model settings."
        : `The model service returned an error (${status}). Try again in a moment.`,
    );
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new FatalError("The model returned an unreadable response. Check the chat-completions endpoint.");
    }
    throw error;
  }
  const content = getResponseContent(result);
  if (!content) throw new FatalError("The model service returned an empty response.");
  return content;
}

async function callStructuredModel(
  systemPrompt: string,
  userData: unknown,
  maxTokens: number,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt =
      attempt === 0
        ? systemPrompt
        : `${systemPrompt}\nYour previous response was not a complete JSON object. Return a complete object matching the requested schema, with no surrounding prose or markdown.`;
    const content = await requestModelStep(prompt, userData, attempt === 0 ? maxTokens : Math.min(5_000, Math.ceil(maxTokens * 1.5)));
    try {
      return parseJsonObject(content);
    } catch (error) {
      if (!(error instanceof ReportFormatError)) throw error;
      if (attempt === 1) {
        throw new FatalError(`The model returned invalid JSON after one format retry (${error.message}). Try again.`);
      }
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
  if (issues.length) throw new FatalError(issues.join(" "));
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
        2_000,
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
        1_200,
      ),
    ),
    input.sourceMessages,
  );
  if (hasHighRiskFlags(analysis)) narrative.safety_mode = true;

  let report = parseChatReport(
    await callStructuredModel(
      writerSystemPrompt(input.settings),
      {
        analysis,
        narrative,
        participants: input.participants,
        selected_user: input.selectedUser,
        messages: input.sourceMessages,
        prompt_version: PROMPT_VERSION,
      },
      input.settings.depth === "deep_dive" ? 3_600 : 2_600,
    ),
  );
  validateEvidence(report, input);

  let review = parseSafetyReview(
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
      1_200,
    ),
  );

  if (review.decision !== "reject" && !isReviewApproved(review, analysis)) {
    const repairInstructions = [
      ...review.repair_instructions,
      ...(hasHighRiskFlags(analysis)
        ? ["Include compassionate, safety-first framing and do not minimize any high-risk safety flag."]
        : []),
    ];
    report = parseChatReport(
      await callStructuredModel(
        writerSystemPrompt(input.settings, repairInstructions.join("\n")),
        {
          analysis,
          narrative,
          participants: input.participants,
          selected_user: input.selectedUser,
          messages: input.sourceMessages,
          previous_report: report,
          review,
          prompt_version: PROMPT_VERSION,
        },
        input.settings.depth === "deep_dive" ? 3_600 : 2_600,
      ),
    );
    validateEvidence(report, input);
    review = parseSafetyReview(
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
        1_200,
      ),
    );
  }

  if (!isReviewApproved(review, analysis)) {
    throw new FatalError("The independent quality review did not approve this report.");
  }
  report = applySafetyReview(report, review, analysis);
  const saved = await saveReportStep(report, input);
  return { report, ...saved };
}
