import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../lib/chat";
import { normalizeConversation } from "../lib/normalization";

const cases: Array<{
  name: string;
  messages: ChatMessage[];
  verify: (metrics: ReturnType<typeof normalizeConversation>["chat_metrics"]) => void;
}> = [
  {
    name: "distinct conversation starters",
    messages: [
      { sender: "Ari", timestamp: "2026-01-01T08:00:00Z", text: "Morning" },
      { sender: "Bea", timestamp: "2026-01-01T08:01:00Z", text: "Hi" },
      { sender: "Ari", timestamp: "2026-01-01T16:00:00Z", text: "Are we still on?" },
    ],
    verify: (metrics) => expect(metrics.message_initiations.Ari).toBe(2),
  },
  {
    name: "apology language",
    messages: [
      { sender: "Ari", timestamp: "2026-01-01T08:00:00Z", text: "I'm sorry I was late." },
      { sender: "Bea", timestamp: "2026-01-01T08:02:00Z", text: "Thanks for saying that." },
    ],
    verify: (metrics) => expect(metrics.participant_metrics[0].apology_count).toBe(1),
  },
  {
    name: "affection language",
    messages: [
      { sender: "Ari", timestamp: "2026-01-01T08:00:00Z", text: "Love you, talk soon." },
      { sender: "Bea", timestamp: "2026-01-01T08:02:00Z", text: "Talk soon." },
    ],
    verify: (metrics) => expect(metrics.participant_metrics[0].affection_expression_count).toBe(1),
  },
  {
    name: "major silence detection",
    messages: [
      { sender: "Ari", timestamp: "2026-01-01T08:00:00Z", text: "Good night." },
      { sender: "Bea", timestamp: "2026-01-02T14:00:00Z", text: "Good morning." },
    ],
    verify: (metrics) => expect(metrics.silence_events).toHaveLength(1),
  },
  {
    name: "question without a following reply",
    messages: [
      { sender: "Ari", timestamp: "2026-01-01T08:00:00Z", text: "Would you like to meet?" },
      { sender: "Ari", timestamp: "2026-01-01T08:01:00Z", text: "Let me know." },
    ],
    verify: (metrics) => expect(metrics.unanswered_questions).toEqual([1]),
  },
  {
    name: "repeated exact phrases",
    messages: [
      { sender: "Ari", timestamp: "2026-01-01T08:00:00Z", text: "Sounds good to me" },
      { sender: "Bea", timestamp: "2026-01-01T08:01:00Z", text: "Sounds good to me" },
    ],
    verify: (metrics) => expect(metrics.repeated_phrases).toContain("Sounds good to me"),
  },
  {
    name: "emoji frequencies",
    messages: [
      { sender: "Ari", timestamp: "2026-01-01T08:00:00Z", text: "See you ❤️" },
      { sender: "Bea", timestamp: "2026-01-01T08:01:00Z", text: "❤️🙂" },
    ],
    verify: (metrics) => expect(metrics.emoji_frequency["❤️"]).toBe(2),
  },
  {
    name: "missing timestamp coverage",
    messages: [
      { sender: "Ari", timestamp: null, text: "Hi" },
      { sender: "Bea", timestamp: null, text: "Hello" },
    ],
    verify: (metrics) => expect(metrics.timestamp_coverage).toBe(0),
  },
  {
    name: "omitted media remains a distinct message type",
    messages: [
      { sender: "Ari", timestamp: "2026-01-01T08:00:00Z", text: "<Media omitted>" },
      { sender: "Bea", timestamp: "2026-01-01T08:01:00Z", text: "What was that?" },
    ],
    verify: (metrics) => expect(metrics.media_sharing_patterns[0]).toContain("1 messages"),
  },
  {
    name: "six-hour gap starts a new conversation",
    messages: [
      { sender: "Ari", timestamp: "2026-01-01T08:00:00Z", text: "Hi" },
      { sender: "Bea", timestamp: "2026-01-01T14:00:00Z", text: "Hello" },
    ],
    verify: (metrics) => expect(metrics.message_initiations).toEqual({ Ari: 1, Bea: 1 }),
  },
];

describe("synthetic pipeline evaluation fixtures", () => {
  it.each(cases)("$name", ({ messages, verify }) => {
    const normalized = normalizeConversation(messages);
    expect(normalized.normalized_messages.map((message) => message.message_id)).toEqual(
      messages.map((_, index) => index + 1),
    );
    expect(normalized.chat_metrics.message_count).toBe(messages.length);
    verify(normalized.chat_metrics);
  });
});
