import { RetryableError } from "workflow";
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
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.stubEnv("MODEL_NAME", "");
  vi.stubEnv("BLOB_STORE_ID", "");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("VERCEL", "");
}

function modelResponse(content: unknown, finishReason = "STOP"): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: typeof content === "string" ? content : JSON.stringify(content) }],
          },
          finishReason,
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

type ModelRequest = {
  systemInstruction: { parts: Array<{ text: string }> };
  contents: Array<{ parts: Array<{ text: string }> }>;
  generationConfig: { maxOutputTokens: number };
};

const systemOf = (request: unknown) => (request as ModelRequest).systemInstruction.parts[0].text;
const userOf = (request: unknown) => (request as ModelRequest).contents[0].parts[0].text;
const maxTokensOf = (request: unknown) => (request as ModelRequest).generationConfig.maxOutputTokens;

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

function reportParts(report: ReturnType<typeof reportPayload> = reportPayload()): unknown[] {
  return [
    { ...report, sections: report.sections.slice(0, 8) },
    { sections: report.sections.slice(8) },
  ];
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
    ...reportParts(),
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
    vi.stubEnv("GEMINI_API_KEY", "");

    const response = await POST(analyzeRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("GEMINI_API_KEY"),
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("requires explicit consent before starting a workflow", async () => {
    configureModel();

    const response = await POST(analyzeRequest(false));
    expect(response.status).toBe(400);
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
    const analystUser = userOf(requests[0].body);

    expect(result.report.sections).toHaveLength(15);
    expect(result.report.sections.find((section) => section.id === "real_time_reading")?.quotes).toEqual([
      { message_id: 2, sender: "Sam", text: "We can talk tomorrow." },
    ]);
    expect(requests).toHaveLength(5);
    const writerSystem = (index: number) => systemOf(requests[index].body);
    expect(writerSystem(2)).toContain('["cold_open","short_version"');
    expect(writerSystem(2)).not.toContain('"what_you_are_doing_right","real_time_reading"');
    expect(writerSystem(3)).toContain('["what_you_are_doing_right","real_time_reading"');
    expect(
      JSON.parse(userOf(requests[3].body)),
    ).toMatchObject({ report_so_far: { title: reportPayload().title } });
    expect(analystUser).toContain("[phone]");
    expect(analystUser).toContain("[email]");
    expect(requests.every((item) => item.headers.get("x-goog-api-key") === "test-key")).toBe(true);
    expect(result.storedRemotely).toBe(false);
  });

  it("calls the default Gemini model with minimal thinking and JSON output", async () => {
    configureModel();
    const urls: string[] = [];
    const requests: Array<Record<string, unknown>> = [];
    const responses = validPipelineResponses();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(url));
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return modelResponse(responses.shift());
      }),
    );

    await analyzeConversation(workflowInput());

    expect(urls[0]).toContain("gemini-3.5-flash-lite");
    expect(requests[0]).toMatchObject({
      generationConfig: {
        maxOutputTokens: 3_000,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: "MINIMAL" },
      },
    });
    expect(systemOf(requests[0])).toContain("You are the Analyst stage");
  });

  it("uses MODEL_NAME to choose another Gemini model", async () => {
    configureModel();
    vi.stubEnv("MODEL_NAME", "gemini-3.8-flash");
    const urls: string[] = [];
    const responses = validPipelineResponses();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        urls.push(String(url));
        return modelResponse(responses.shift());
      }),
    );

    await analyzeConversation(workflowInput());

    expect(urls.every((url) => url.includes("gemini-3.8-flash"))).toBe(true);
  });

  it("treats an invalid API key error as a rejected key", async () => {
    configureModel();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" } }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    await expect(analyzeConversation(workflowInput())).rejects.toThrow("The model rejected the API key.");
  });

  it("reports a refusal instead of treating it as a reply", async () => {
    configureModel();
    vi.stubGlobal("fetch", vi.fn(async () => modelResponse("", "SAFETY")));

    await expect(analyzeConversation(workflowInput())).rejects.toThrow(
      "The model declined to analyze this conversation.",
    );
  });

  it("retries a malformed model response once with a formatting instruction", async () => {
    configureModel();
    const responses: unknown[] = ["not-json", ...validPipelineResponses()];
    const fetchMock = vi.fn(async () => modelResponse(responses.shift()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeConversation(workflowInput())).resolves.toMatchObject({
      report: { sections: expect.any(Array) },
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("retries a writer half that leaves out one of its sections", async () => {
    configureModel();
    const requests: Array<Record<string, unknown>> = [];
    const responses = validPipelineResponses();
    const [, closing] = reportParts() as Array<{ sections: Array<{ id: string }> }>;
    responses.splice(3, 0, { sections: closing.sections.filter((section) => section.id !== "verdict") });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return modelResponse(responses.shift());
      }),
    );

    await expect(analyzeConversation(workflowInput())).resolves.toMatchObject({
      report: { sections: expect.any(Array) },
    });
    expect(requests).toHaveLength(6);
    expect(maxTokensOf(requests[4])).toBe(6_000);
    expect(systemOf(requests[4])).toContain("missing sections verdict");
  });

  it("names a section left empty in both attempts and tells the writer to fill every section", async () => {
    configureModel();
    const requests: Array<Record<string, unknown>> = [];
    const responses = validPipelineResponses();
    const [, closing] = reportParts() as Array<{ sections: Array<{ id: string; body: string }> }>;
    const emptied = {
      sections: closing.sections.map((section) =>
        section.id === "linguistic_autopsy" ? { ...section, body: "" } : section,
      ),
    };
    responses.splice(3, 2, emptied, emptied);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return modelResponse(responses.shift());
      }),
    );

    await expect(analyzeConversation(workflowInput())).rejects.toThrow(
      "The model's reply did not match the required format after one retry (sections without a title or body: linguistic_autopsy).",
    );
    expect(systemOf(requests[3])).toContain("Every requested section must have a non-empty title and body");
  });

  it("reports a reply cut off at the token limit as running out of room", async () => {
    configureModel();
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return modelResponse('{"participants":["Maya"', "MAX_TOKENS");
      }),
    );

    await expect(analyzeConversation(workflowInput())).rejects.toThrow(
      "The model ran out of room for its reply (4,500-token limit) after one retry.",
    );
    expect(requests).toHaveLength(2);
    expect(systemOf(requests[1])).toContain("ran out of room before the JSON object was complete");
  });

  it("rejects an unapproved quality review", async () => {
    configureModel();
    const responses = validPipelineResponses();
    responses[4] = {
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
    responses[4] = {
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
    responses.push(...reportParts(), {
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
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("blocks reports whose unsupported quoted text survives the repair pass", async () => {
    configureModel();
    const responses = validPipelineResponses();
    const invalidReport = reportPayload();
    invalidReport.sections.find((section) => section.id === "real_time_reading")!.quotes = [
      { message_id: 2, sender: "Sam", text: "We secretly moved to Paris." },
    ];
    responses.splice(2, 2, ...reportParts(invalidReport), ...reportParts(invalidReport));
    const fetchMock = vi.fn(async () => modelResponse(responses.shift()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeConversation(workflowInput())).rejects.toThrow(
      /evidence and safety checks after one repair pass.*unsupported quote/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("sends exact-quote failures through the repair pass before review", async () => {
    configureModel();
    const requests: Array<Record<string, unknown>> = [];
    const responses = validPipelineResponses();
    const invalidReport = reportPayload();
    invalidReport.sections.find((section) => section.id === "real_time_reading")!.quotes = [
      { message_id: 2, sender: "Sam", text: "We secretly moved to Paris." },
    ];
    responses.splice(2, 0, ...reportParts(invalidReport));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return modelResponse(responses.shift());
      }),
    );

    await expect(analyzeConversation(workflowInput())).resolves.toMatchObject({
      report: { sections: expect.any(Array) },
    });
    expect(requests).toHaveLength(7);
    expect(requests.map(maxTokensOf)).toEqual([3_000, 1_800, 4_000, 4_000, 5_000, 5_000, 2_000]);
    const repairSystem = systemOf(requests[4]);
    expect(repairSystem).toContain("REQUIRED REVISIONS");
    expect(repairSystem).toContain(
      'Section "real_time_reading" contains an unsupported quote for message 2: "We secretly moved to Paris.".',
    );
    expect(
      JSON.parse(userOf(requests[4])),
    ).toMatchObject({ evidence_issues: [expect.stringContaining("unsupported quote")] });
  });

  it("sends each stage's JSON schema and leaves overload errors for the workflow to retry", async () => {
    configureModel();
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await expect(analyzeConversation(workflowInput())).rejects.toBeInstanceOf(RetryableError);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      generationConfig: {
        responseJsonSchema: { properties: { findings: { type: "array" } } },
      },
    });
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
