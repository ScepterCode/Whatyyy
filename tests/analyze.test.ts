import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../app/api/analyze/route";
import { calculateChatStats, type ChatMessage } from "../lib/chat";
import { normalizeConversation } from "../lib/normalization";
import {
  parseChatReport,
  REPORT_SECTION_IDS,
  type ChatReport,
} from "../lib/report";
import { analyzeConversation, type AnalysisWorkflowInput } from "../workflows/analyze";
import { getRun, start } from "workflow/api";

vi.mock("workflow/api", () => ({
  getRun: vi.fn(),
  start: vi.fn(),
}));

const messages: ChatMessage[] = [
  {
    sender: "Maya",
    timestamp: "2026-03-12T09:14:22.000Z",
    text: "Text me at [phone] or [email].",
  },
  {
    sender: "Sam",
    timestamp: "2026-03-12T09:15:00.000Z",
    text: "We can talk tomorrow.",
  },
];
const DEVICE_KEY = "A".repeat(43);

function analyzeRequest(consented = true): Request {
  return new Request("http://localhost/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEVICE_KEY}`,
    },
    body: JSON.stringify({
      messages,
      self: "Maya",
      settings: {
        relationship_type: "friendship",
        tone: "direct",
        depth: "standard",
        language: "en",
      },
      consented,
    }),
  });
}

function configureModel() {
  vi.stubEnv("MODEL_API_URL", "https://model.example/v1/chat/completions");
  vi.stubEnv("MODEL_API_KEY", "test-key");
  vi.stubEnv("MODEL_NAME", "test-model");
  vi.stubEnv("BLOB_STORE_ID", "");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("VERCEL", "");
}

function modelResponse(content: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function reportPayload() {
  return {
    title: "Maya and Sam: clear words, uneven context",
    persona_name: "Ada",
    persona_description: "A careful outside read.",
    central_thesis: "Maya asks directly, while Sam gives a clear answer without enough context to infer more.",
    safety_note: null,
    sections: REPORT_SECTION_IDS.map((id) => ({
      id,
      title: id.replaceAll("_", " "),
      body:
        id === "cold_open"
          ? "Maya and Sam exchange a direct question and a clear answer."
          : id === "kind_next_moves"
            ? "Ask one direct question about what each of you wants next. Agree on a specific time to talk, and leave room for either person to say they need more context."
            : "The available messages support only a limited reading.",
      evidence_message_ids: [2],
      quotes:
        id === "real_time_reading"
          ? [{ message_id: 2, sender: "Sam", text: "We can talk tomorrow." }]
          : [],
    })),
  };
}

function validPipelineResponses(): unknown[] {
  return [
    {
      participants: ["Maya", "Sam"],
      relationship_type: "friendship",
      relationship_stage: "unknown",
      findings: {},
      uncertainty_flags: [],
      safety_flags: [],
    },
    {
      central_thesis: "Maya asks directly, while Sam gives a clear answer without enough context to infer more.",
      thesis_message_ids: [2],
      thesis_confidence: "medium",
      key_turning_point: {
        message_ids: [],
        what_happened: "No turning point is established.",
        interpretation: "There is not enough evidence to identify a shift.",
        alternative_interpretation: "The export may omit relevant context.",
      },
      key_quotes: [],
      kind_next_moves: [],
    },
    reportPayload(),
    {
      decision: "pass",
      issues: [],
      quality_scores: {
        specificity: 4,
        evidence_grounding: 5,
        thesis_coherence: 4,
        voice_distinctiveness: 4,
        actionability: 4,
        name_accuracy: 5,
      },
      safety_assessment: {
        risk_detected: false,
        severity: "none",
        message_ids: [],
        safety_first_required: false,
        user_safety_note: null,
      },
      repair_instructions: [],
    },
  ];
}

function workflowInput(): AnalysisWorkflowInput {
  const normalized = normalizeConversation(messages);
  return {
    reportId: "90a54af5-8840-4f6d-9a2f-2a862bffbb59",
    ownerHash: "a".repeat(64),
    participants: ["Maya", "Sam"],
    selectedUser: "Maya",
    settings: {
      relationship_type: "friendship",
      tone: "direct",
      depth: "standard",
      language: "en",
    },
    messageCount: messages.length,
    metrics: normalized.chat_metrics,
    originalChatStats: calculateChatStats(messages),
    normalizationNotes: normalized.normalization_notes,
    messages: normalized.normalized_messages.map((message) => ({
      message_id: message.message_id,
      sender: message.sender,
      timestamp: message.timestamp,
      message_type: message.message_type,
      cleaned_text: message.cleaned_text,
      seconds_since_previous: message.seconds_since_previous,
      is_conversation_starter: message.is_conversation_starter,
      is_conversation_ender: message.is_conversation_ender,
    })),
    sourceMessages: normalized.normalized_messages.map(({ message_id, sender, cleaned_text }) => ({
      message_id,
      sender,
      cleaned_text,
    })),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(start).mockReset();
  vi.mocked(getRun).mockReset();
});

describe("POST /api/analyze", () => {
  it("requires model credentials without queuing a fallback job", async () => {
    vi.stubEnv("MODEL_API_URL", "");
    vi.stubEnv("MODEL_API_KEY", "");
    vi.stubEnv("MODEL_NAME", "");

    const response = await POST(analyzeRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("MODEL_API_URL"),
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("requires explicit consent before starting a workflow", async () => {
    configureModel();

    const response = await POST(analyzeRequest(false));
    expect(response.status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects a non-HTTPS model endpoint outside localhost", async () => {
    configureModel();
    vi.stubEnv("MODEL_API_URL", "http://model.example/v1/chat/completions");

    const response = await POST(analyzeRequest());
    expect(response.status).toBe(500);
    expect(start).not.toHaveBeenCalled();
  });

  it("queues a bounded, redacted workflow and returns a job identifier", async () => {
    configureModel();
    vi.mocked(start).mockResolvedValue({ runId: "run_1" } as never);
    const response = await POST(analyzeRequest());
    const result = (await response.json()) as { jobId: string };
    const startCall = vi.mocked(start).mock.calls[0] as unknown as [unknown, AnalysisWorkflowInput[]];
    const input = startCall[1][0];

    expect(response.status).toBe(202);
    expect(result.jobId).toBeTruthy();
    expect(input.messages).toHaveLength(2);
    expect(input.sourceMessages[0].cleaned_text).toContain("[phone]");
    expect(input.sourceMessages[0].cleaned_text).toContain("[email]");
    expect(input.sourceMessages[0].cleaned_text).not.toContain("202 555 0199");
  });

  it("rejects missing device capabilities before workflow execution", async () => {
    configureModel();
    const request = analyzeRequest();
    const response = await POST(
      new Request(request, { headers: { "Content-Type": "application/json" } }),
    );
    expect(response.status).toBe(401);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("GET /api/analyze", () => {
  it("returns workflow status and completed report only for the device capability", async () => {
    configureModel();
    const report = parseChatReport(reportPayload());
    const storedReport = {
      id: "90a54af5-8840-4f6d-9a2f-2a862bffbb59",
      created_at: "2026-03-12T09:15:00.000Z",
      title: report.title,
      participants: ["Maya", "Sam"],
      message_count: 2,
      settings: workflowInput().settings,
      report,
    };
    vi.mocked(getRun).mockReturnValue({
      exists: Promise.resolve(true),
      status: Promise.resolve("completed"),
      returnValue: Promise.resolve({ report, storedReport, storedRemotely: false }),
    } as never);

    const response = await GET(
      new Request("http://localhost/api/analyze?jobId=run_1", {
        headers: { Authorization: `Bearer ${DEVICE_KEY}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "completed", report, storedReport });
  });

  it("does not reveal whether a job exists without the device capability", async () => {
    configureModel();
    const response = await GET(new Request("http://localhost/api/analyze?jobId=run_1"));
    expect(response.status).toBe(401);
    expect(getRun).not.toHaveBeenCalled();
  });
});

describe("analyzeConversation workflow", () => {
  it("runs all stages with redacted source text and exact quote validation", async () => {
    configureModel();
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const responses = validPipelineResponses();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return modelResponse(responses[requests.length - 1]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeConversation(workflowInput());
    const analystUser = JSON.stringify(
      (requests[0].body.messages as Array<{ role: string; content: string }>)[1].content,
    );

    expect(result.report.sections).toHaveLength(15);
    expect(result.report.sections.find((section) => section.id === "real_time_reading")?.quotes).toEqual([
      { message_id: 2, sender: "Sam", text: "We can talk tomorrow." },
    ]);
    expect(requests).toHaveLength(4);
    expect(analystUser).toContain("[phone]");
    expect(analystUser).toContain("[email]");
    expect(requests.every((item) => item.headers.get("Authorization") === "Bearer test-key")).toBe(true);
    expect(requests[0].body).not.toHaveProperty("chat_template_kwargs");
    expect(result.storedRemotely).toBe(false);
  });

  it("uses NVIDIA low-effort reasoning to keep its model calls within a function step", async () => {
    configureModel();
    vi.stubEnv("MODEL_API_URL", "https://integrate.api.nvidia.com/v1/chat/completions");
    vi.stubEnv("MODEL_NAME", "nvidia/test-model");
    const requests: Array<Record<string, unknown>> = [];
    const responses = validPipelineResponses();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return modelResponse(responses.shift());
      }),
    );

    await analyzeConversation(workflowInput());

    expect(requests[0]).toMatchObject({
      chat_template_kwargs: { enable_thinking: true, low_effort: true },
      reasoning_budget: 1_024,
    });
  });

  it("retries a malformed model response once with a formatting instruction", async () => {
    configureModel();
    const responses: unknown[] = ["not-json", ...validPipelineResponses()];
    const fetchMock = vi.fn(async () => modelResponse(responses.shift()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeConversation(workflowInput())).resolves.toMatchObject({
      report: { sections: expect.any(Array) },
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("rejects an unapproved quality review", async () => {
    configureModel();
    const responses = validPipelineResponses();
    responses[3] = {
      decision: "reject",
      issues: [],
      safety_assessment: {
        risk_detected: false,
        severity: "none",
        message_ids: [],
        safety_first_required: false,
        user_safety_note: null,
      },
      repair_instructions: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => modelResponse(responses.shift())));

    await expect(analyzeConversation(workflowInput())).rejects.toThrow(
      "independent quality review did not approve",
    );
  });

  it("makes one repair pass when the independent reviewer requests revisions", async () => {
    configureModel();
    const responses = validPipelineResponses();
    responses[3] = {
      decision: "revise",
      issues: [{ code: "generic_report", severity: "major", description: "Make the report more specific.", message_ids: [2] }],
      quality_scores: {},
      safety_assessment: {
        risk_detected: false,
        severity: "none",
        message_ids: [],
        safety_first_required: false,
        user_safety_note: null,
      },
      repair_instructions: ["Make claims more specific to the cited evidence."],
    };
    responses.push(reportPayload(), {
      decision: "pass",
      issues: [],
      quality_scores: {},
      safety_assessment: {
        risk_detected: false,
        severity: "none",
        message_ids: [],
        safety_first_required: false,
        user_safety_note: null,
      },
      repair_instructions: [],
    });
    const fetchMock = vi.fn(async () => modelResponse(responses.shift()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeConversation(workflowInput())).resolves.toMatchObject({
      report: { title: expect.any(String) },
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("blocks reports containing unsupported quoted text", async () => {
    configureModel();
    const responses = validPipelineResponses();
    const invalidReport = reportPayload();
    invalidReport.sections.find((section) => section.id === "real_time_reading")!.quotes = [
      { message_id: 2, sender: "Sam", text: "We secretly moved to Paris." },
    ];
    responses[2] = invalidReport;
    const fetchMock = vi.fn(async () => modelResponse(responses.shift()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeConversation(workflowInput())).rejects.toThrow("unsupported quote");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a timed-out request beyond the step’s bounded duration", async () => {
    configureModel();
    const fetchMock = vi.fn(async () => {
      throw new DOMException("Timed out", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeConversation(workflowInput())).rejects.toThrow(
      "The model took too long to complete a pipeline stage",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
