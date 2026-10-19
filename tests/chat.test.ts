import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { calculateChatStats, parseWhatsAppExport } from "../lib/chat";
import { extractWhatsAppTextFromZip } from "../lib/import";
import { normalizeConversation } from "../lib/normalization";

describe("parseWhatsAppExport", () => {
  it("parses bracketed exports and joins wrapped message lines", () => {
    const parsed = parseWhatsAppExport(
      "[12/03/26, 09:14:22] Maya: Are we still meeting?\nThis is the next line.\n[12/03/26, 9:16 AM] Sam: Yes",
    );

    expect(parsed.participants).toEqual(["Maya", "Sam"]);
    expect(parsed.messages).toEqual([
      {
        sender: "Maya",
        timestamp: "2026-03-12T09:14:22.000Z",
        text: "Are we still meeting?\nThis is the next line.",
      },
      {
        sender: "Sam",
        timestamp: "2026-03-12T09:16:00.000Z",
        text: "Yes",
      },
    ]);
  });

  it("ignores system lines that do not have a sender", () => {
    const parsed = parseWhatsAppExport(
      "12/03/26, 09:14 - Maya: hello\n12/03/26, 09:15 - Messages and calls are end-to-end encrypted.\n12/03/26, 09:16 - Sam: hi",
    );
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.participants).toEqual(["Maya", "Sam"]);
  });

  it("counts messages and calculates lengths and gaps", () => {
    const { messages } = parseWhatsAppExport(
      "[12/03/26, 09:14] Maya: hey\n[12/03/26, 10:14] Sam: hello",
    );
    expect(calculateChatStats(messages)).toMatchObject({
      messageCount: 2,
      participantCounts: { Maya: 1, Sam: 1 },
      averageMessageLength: { Maya: 3, Sam: 5 },
      longestSilenceHours: 1,
    });
  });
});

describe("extractWhatsAppTextFromZip", () => {
  it("extracts the chat text and ignores media files", async () => {
    const chat = "[12/03/26, 09:14] Maya: Hello\n[12/03/26, 09:15] Sam: Hi";
    const archive = zipSync({
      "WhatsApp Chat with Sam.txt": new TextEncoder().encode(chat),
      "IMG-001.jpg": new Uint8Array([1, 2, 3]),
      "__MACOSX/._WhatsApp Chat with Sam.txt": new Uint8Array([4, 5]),
    });

    await expect(extractWhatsAppTextFromZip(archive)).resolves.toBe(chat);
  });

  it("rejects archives with multiple chat text files", async () => {
    const archive = zipSync({
      "chat-one.txt": new TextEncoder().encode("first"),
      "chat-two.txt": new TextEncoder().encode("second"),
    });

    await expect(extractWhatsAppTextFromZip(archive)).rejects.toThrow(
      "more than one .txt file",
    );
  });

  it("rejects oversized extracted text", async () => {
    const archive = zipSync({
      "chat.txt": new TextEncoder().encode("a".repeat(1_500_001)),
    });

    await expect(extractWhatsAppTextFromZip(archive)).rejects.toThrow(
      "chat text in this ZIP is over 1.5 MB",
    );
  });

  it("rejects a ZIP archive over the compressed input limit", async () => {
    const archive = new Uint8Array(50_000_001);

    await expect(extractWhatsAppTextFromZip(archive)).rejects.toThrow(
      "This ZIP is over 50 MB",
    );
  });

  it("rejects archives without a chat text file", async () => {
    const archive = zipSync({
      "IMG-001.jpg": new Uint8Array([1, 2, 3]),
    });

    await expect(extractWhatsAppTextFromZip(archive)).rejects.toThrow(
      "couldn’t find a .txt chat export",
    );
  });
});

describe("normalizeConversation", () => {
  it("assigns stable IDs and detects conversation boundaries and silences", () => {
    const normalized = normalizeConversation([
      { sender: "Maya", timestamp: "2026-03-12T09:00:00.000Z", text: "Are we still meeting?" },
      { sender: "Sam", timestamp: "2026-03-12T09:05:00.000Z", text: "Yes 🙂" },
      { sender: "Maya", timestamp: "2026-03-14T10:00:00.000Z", text: "Sorry about yesterday." },
      { sender: "Maya", timestamp: "2026-03-14T10:01:00.000Z", text: "What now?" },
    ]);
    expect(normalized.normalized_messages.map((message) => message.message_id)).toEqual([1, 2, 3, 4]);
    expect(normalized.normalized_messages[2].is_conversation_starter).toBe(true);
    expect(normalized.chat_metrics.silence_events).toHaveLength(1);
    expect(normalized.chat_metrics.unanswered_questions).toEqual([4]);
    expect(normalized.chat_metrics.participant_metrics.find((person) => person.participant === "Sam")?.emoji_frequency).toEqual({ "🙂": 1 });
  });
});
