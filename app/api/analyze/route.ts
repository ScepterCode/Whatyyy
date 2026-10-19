import { get, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { getRun, start } from "workflow/api";
import { calculateChatStats, type ChatMessage } from "../../../lib/chat";
import { normalizeConversation } from "../../../lib/normalization";
import { getDeviceKey, getOwnerHash } from "../../../lib/storage/device-capability";
import { analyzeConversation, type AnalysisWorkflowInput } from "../../../workflows/analyze";
import type { ChatReport, ReportSettings } from "../../../lib/report";
import type { StoredReport } from "../../../lib/storage/report-storage";

export const runtime = "nodejs";
export const maxDuration = 10;

const MAX_MESSAGES = 5_000;
const MAX_TEXT_LENGTH = 1_500_000;
const MAX_SAMPLE_MESSAGES = 180;
const MAX_CONTEXT_CHARACTERS = 120_000;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVATE_CACHE_HEADERS = { "Cache-Control": "private, no-store" };

type AnalyzeRequest = {
  messages?: ChatMessage[];
  self?: string;
  consented?: boolean;
  settings?: Partial<ReportSettings>;
};

function redactSensitiveText(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[sensitive ID]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[payment number]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[phone]")
    .replace(
      /\b\d{1,6}\s+(?:[A-Z0-9.'-]+\s+){0,5}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way)\b/gi,
      "[street address]",
    );
}

function sampleMessages<T>(messages: T[], limit: number): T[] {
  if (messages.length <= limit) return messages;
  const selected = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    selected.add(Math.floor((index * (messages.length - 1)) / (limit - 1)));
  }
  return [...selected].sort((a, b) => a - b).map((index) => messages[index]);
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

function getSettings(
  value: Partial<ReportSettings> | undefined,
  participantCount: number,
): ReportSettings {
  const relationshipTypes: ReportSettings["relationship_type"][] = [
    "romantic",
    "friendship",
    "family",
    "group",
    "workplace",
    "unknown",
  ];
  const tones: ReportSettings["tone"][] = ["gentle", "direct", "brutal_but_fair"];
  const depths: ReportSettings["depth"][] = ["standard", "deep_dive", "group_chat"];
  const relationship_type = relationshipTypes.includes(
    value?.relationship_type as ReportSettings["relationship_type"],
  )
    ? (value?.relationship_type as ReportSettings["relationship_type"])
    : participantCount > 2
      ? "group"
      : "unknown";
  return {
    relationship_type,
    tone: tones.includes(value?.tone as ReportSettings["tone"])
      ? (value?.tone as ReportSettings["tone"])
      : "direct",
    depth: depths.includes(value?.depth as ReportSettings["depth"])
      ? (value?.depth as ReportSettings["depth"])
      : relationship_type === "group"
        ? "group_chat"
        : "standard",
    language:
      typeof value?.language === "string" &&
      /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value.language)
        ? value.language
        : "en",
  };
}

function hasBlobConfiguration(): boolean {
  return Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
}

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_CACHE_HEADERS });
}

function workflowFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return "The report could not be completed. Try again.";
  const safeMessages = [
    "The model took too long to complete a pipeline stage.",
    "Could not reach the configured model service.",
    "The model rejected the API key.",
    "The model service returned an error (",
    "The model returned an unreadable response.",
    "The model service returned an empty response.",
    "The model returned invalid JSON after one format retry",
    "The model did not return a complete JSON response.",
    "The independent quality review did not approve this report.",
    "Quality review requires a safety-first note but did not provide one.",
  ];
  const match = safeMessages
    .map((message) => ({ message, index: error.message.indexOf(message) }))
    .find((candidate) => candidate.index >= 0);
  return match
    ? error.message.slice(match.index, match.index + 400)
    : "The report could not be completed. Try again.";
}

function parseRequestBody(value: unknown): AnalyzeRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as AnalyzeRequest;
}

export async function POST(request: Request) {
  const apiUrl = process.env.MODEL_API_URL;
  if (!apiUrl || !process.env.MODEL_API_KEY || !process.env.MODEL_NAME) {
    return NextResponse.json(
      { error: "Model access isn’t configured yet. Add MODEL_API_URL, MODEL_API_KEY, and MODEL_NAME." },
      { status: 503 },
    );
  }
  if (!isSecureModelUrl(apiUrl)) {
    return NextResponse.json(
      { error: "Set MODEL_API_URL to an HTTPS endpoint. HTTP is only allowed for a local model during development." },
      { status: 500 },
    );
  }
  const deviceKey = getDeviceKey(request);
  if (!deviceKey) {
    return NextResponse.json({ error: "This browser’s private report key is missing or invalid." }, { status: 401 });
  }
  const hasBlob = hasBlobConfiguration();
  if (process.env.VERCEL && !hasBlob) {
    return NextResponse.json(
      { error: "Connect a private Vercel Blob store before starting an analysis." },
      { status: 503 },
    );
  }

  let body: AnalyzeRequest | null;
  try {
    body = parseRequestBody(await request.json());
  } catch {
    body = null;
  }
  if (!body) return NextResponse.json({ error: "The request body must be a valid JSON object." }, { status: 400 });

  const messages = body.messages;
  if (
    !Array.isArray(messages) ||
    messages.length < 2 ||
    messages.length > MAX_MESSAGES ||
    messages.some(
      (message) =>
        !message ||
        typeof message.sender !== "string" ||
        message.sender.trim().length === 0 ||
        message.sender.length > 100 ||
        typeof message.text !== "string" ||
        (message.timestamp !== null &&
          (typeof message.timestamp !== "string" ||
            message.timestamp.length > 64 ||
            !Number.isFinite(Date.parse(message.timestamp)))),
    )
  ) {
    return NextResponse.json(
      { error: `Choose a chat with 2 to ${MAX_MESSAGES.toLocaleString()} valid messages.` },
      { status: 400 },
    );
  }
  const totalTextLength = messages.reduce((sum, message) => sum + message.text.length, 0);
  if (totalTextLength > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { error: "This export is too large to analyze. Choose a file under 1.5 MB of message text." },
      { status: 413 },
    );
  }
  const participants = [...new Set(messages.map((message) => message.sender.trim()))];
  if (participants.length < 2 || participants.length > 30) {
    return NextResponse.json({ error: "The export needs 2 to 30 distinct participants." }, { status: 400 });
  }
  if (typeof body.self !== "string" || !participants.includes(body.self.trim())) {
    return NextResponse.json({ error: "Choose your name from the participants in this chat." }, { status: 400 });
  }
  if (body.consented !== true) {
    return NextResponse.json(
      { error: "Confirm permission to analyze this chat and send a redacted sample to the configured AI model." },
      { status: 400 },
    );
  }

  const settings = getSettings(body.settings, participants.length);
  const safeMessages = messages.map((message) => ({
    ...message,
    sender: message.sender.trim(),
    text: redactSensitiveText(message.text),
  }));
  const normalized = normalizeConversation(safeMessages);
  const selected = sampleMessages(normalized.normalized_messages, MAX_SAMPLE_MESSAGES);
  const boundedMessages: typeof selected = [];
  let contextLength = 0;
  for (const message of selected) {
    const text = message.cleaned_text.slice(0, 1_500);
    const normalizedMessage = { ...message, cleaned_text: text, raw_text: text };
    const size = JSON.stringify(normalizedMessage).length;
    if (contextLength + size > MAX_CONTEXT_CHARACTERS) continue;
    contextLength += size;
    boundedMessages.push(normalizedMessage);
  }
  const jobId = crypto.randomUUID();
  const ownerHash = getOwnerHash(deviceKey);
  const workflowInput: AnalysisWorkflowInput = {
    reportId: crypto.randomUUID(),
    ownerHash,
    participants,
    selectedUser: body.self.trim(),
    settings,
    messageCount: messages.length,
    metrics: normalized.chat_metrics,
    originalChatStats: calculateChatStats(safeMessages),
    normalizationNotes: normalized.normalization_notes,
    messages: boundedMessages.map((message) => ({
      message_id: message.message_id,
      sender: message.sender,
      timestamp: message.timestamp,
      message_type: message.message_type,
      cleaned_text: message.cleaned_text,
      seconds_since_previous: message.seconds_since_previous,
      is_conversation_starter: message.is_conversation_starter,
      is_conversation_ender: message.is_conversation_ender,
    })),
    sourceMessages: boundedMessages.map(({ message_id, sender, cleaned_text }) => ({
      message_id,
      sender,
      cleaned_text,
    })),
  };

  try {
    const run = await start(analyzeConversation, [workflowInput]);
    if (hasBlob) {
      await put(
        `jobs/${ownerHash}/${jobId}.json`,
        JSON.stringify({ runId: run.runId }),
        {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: "application/json",
        },
      );
    }
    return privateJson({ jobId: hasBlob ? jobId : run.runId }, 202);
  } catch (error) {
    console.error("Could not start the report workflow", error);
    return NextResponse.json({ error: "The report could not be queued. Try again." }, { status: 503 });
  }
}

export async function GET(request: Request) {
  const deviceKey = getDeviceKey(request);
  if (!deviceKey) {
    return privateJson({ error: "This browser’s private report key is missing or invalid." }, 401);
  }
  const jobId = new URL(request.url).searchParams.get("jobId");
  if (!jobId || jobId.length > 100) {
    return privateJson({ error: "The report job could not be found." }, 400);
  }

  let runId = jobId;
  if (hasBlobConfiguration()) {
    if (!JOB_ID_PATTERN.test(jobId)) {
      return privateJson({ error: "The report job could not be found." }, 404);
    }
    const ownerHash = getOwnerHash(deviceKey);
    let marker;
    try {
      marker = await get(`jobs/${ownerHash}/${jobId}.json`, {
        access: "private",
        useCache: false,
      });
    } catch (error) {
      console.error("Could not check private report job ownership", error);
      return privateJson({ error: "The report job could not be loaded." }, 502);
    }
    if (!marker || marker.statusCode !== 200) {
      return privateJson({ error: "The report job could not be found." }, 404);
    }
    try {
      const value: unknown = await new Response(marker.stream).json();
      if (
        !value ||
        typeof value !== "object" ||
        !("runId" in value) ||
        typeof value.runId !== "string"
      ) {
        throw new Error("Invalid report job record.");
      }
      runId = value.runId;
    } catch (error) {
      console.error("Could not read private report job metadata", error);
      return privateJson({ error: "The report job could not be read." }, 500);
    }
  } else if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
    return privateJson({ error: "The report job could not be found." }, 404);
  }

  try {
    const run = getRun<{
      report: ChatReport;
      storedReport: StoredReport;
      storedRemotely: boolean;
    }>(runId);
    if (!(await run.exists)) {
      return privateJson({ error: "The report job could not be found." }, 404);
    }
    const status = await run.status;
    if (status === "completed") {
      const result = await run.returnValue;
      return privateJson({ status, ...result });
    }
    if (status === "failed" || status === "cancelled") {
      let errorMessage =
        status === "cancelled" ? "The report job was cancelled." : "The report could not be completed. Try again.";
      if (status === "failed") {
        try {
          await run.returnValue;
        } catch (error) {
          errorMessage = workflowFailureMessage(error);
        }
      }
      return privateJson({
        status,
        error: errorMessage,
      });
    }
    return privateJson({ status });
  } catch (error) {
    console.error("Could not read report workflow status", error);
    return privateJson({ error: "The report status could not be loaded." }, 502);
  }
}
