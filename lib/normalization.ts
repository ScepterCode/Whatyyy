import type { ChatMessage } from "./chat";

export type NormalizedMessage = {
  message_id: number;
  sender: string;
  timestamp: string | null;
  raw_timestamp: string | null;
  raw_text: string;
  cleaned_text: string;
  message_type:
    | "text"
    | "image"
    | "voice"
    | "video"
    | "sticker"
    | "system"
    | "omitted_media"
    | "unknown";
  reply_to_message_id: number | null;
  media_description: string | null;
  word_count: number;
  detected_language: string | null;
  conversation_day: string | null;
  seconds_since_previous: number | null;
  is_conversation_starter: boolean;
  is_conversation_ender: boolean;
};

export type NormalizedChatMetrics = {
  message_count: number;
  participant_metrics: Array<{
    participant: string;
    message_count: number;
    conversation_starters: number;
    conversation_enders: number;
    average_message_length_words: number | null;
    average_response_seconds: number | null;
    emoji_frequency: Record<string, number>;
    question_count: number;
    apology_count: number;
    affection_expression_count: number;
    repeated_phrases: string[];
  }>;
  silence_events: Array<{
    start_message_id: number;
    end_message_id: number;
    seconds: number;
    participants: string[];
  }>;
  daily_message_volume: Array<{ period: string; message_count: number }>;
  weekly_message_volume: Array<{ period: string; message_count: number }>;
  emoji_frequency: Record<string, number>;
  repeated_phrases: string[];
  unanswered_questions: number[];
  media_sharing_patterns: string[];
  timestamp_coverage: number;
  longest_silence_seconds: number | null;
  message_initiations: Record<string, number>;
  late_night_message_ids: number[];
};

export type NormalizedConversation = {
  schema_version: "1.0";
  normalization_notes: string[];
  normalized_messages: NormalizedMessage[];
  chat_metrics: NormalizedChatMetrics;
};

const CONVERSATION_GAP_SECONDS = 6 * 60 * 60;
const MAJOR_SILENCE_SECONDS = 24 * 60 * 60;
const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
const EMOJI_PATTERN = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;
const APOLOGY_PATTERN = /\b(sorry|apolog(?:y|ies|ize|ise|ized|ised)|my bad|lo siento|perd[oó]n|desculpa)\b/i;
const AFFECTION_PATTERN = /\b(love you|miss you|i love|i adore|mi amor|te quiero|te amo|je t'aime)\b/i;

function inferMessageType(text: string): NormalizedMessage["message_type"] {
  const value = text.trim().toLowerCase();
  if (!value) return "unknown";
  if (/<(?:media omitted|attached|image omitted|video omitted|audio omitted)>/.test(value)) {
    return "omitted_media";
  }
  if (/\b(image|photo|picture)\s+(?:attached|omitted)|<image:/i.test(value)) return "image";
  if (/\b(voice message|audio message|voice note)\b|<audio:/i.test(value)) return "voice";
  if (/\bvideo\s+(?:attached|omitted)|<video:/i.test(value)) return "video";
  if (/\bsticker\b|<sticker:/i.test(value)) return "sticker";
  return "text";
}

function mondayWeek(date: Date): string {
  const day = date.getUTCDay() || 7;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - day + 1);
  return monday.toISOString().slice(0, 10);
}

function increment(record: Record<string, number>, key: string, amount = 1) {
  record[key] = (record[key] ?? 0) + amount;
}

function repeatedTexts(messages: NormalizedMessage[]): string[] {
  const counts = new Map<string, number>();
  const originals = new Map<string, string>();
  for (const message of messages) {
    const normalized = message.cleaned_text.trim().toLocaleLowerCase();
    if (normalized.length < 4 || message.message_type !== "text") continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    if (!originals.has(normalized)) originals.set(normalized, message.cleaned_text.trim());
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([normalized]) => originals.get(normalized) ?? normalized);
}

export function normalizeConversation(
  messages: ChatMessage[],
): NormalizedConversation {
  const normalizationNotes = [
    "Message IDs are assigned by order in the imported export.",
    "Language detection, reply threading, and attachment descriptions are left unknown unless explicit export metadata provides them.",
    "Conversation boundaries use a six-hour inactivity gap; major silences use a 24-hour threshold.",
  ];
  const normalizedMessages: NormalizedMessage[] = messages.map((message, index) => {
    const timestamp =
      message.timestamp && Number.isFinite(Date.parse(message.timestamp))
        ? new Date(message.timestamp).toISOString()
        : null;
    const previousTimestamp =
      index > 0 && messages[index - 1].timestamp
        ? Date.parse(messages[index - 1].timestamp as string)
        : Number.NaN;
    const currentTime = timestamp ? Date.parse(timestamp) : Number.NaN;
    const secondsSincePrevious =
      Number.isFinite(currentTime) && Number.isFinite(previousTimestamp)
        ? Math.max(0, (currentTime - previousTimestamp) / 1000)
        : null;
    const isConversationStarter =
      index === 0 ||
      (secondsSincePrevious !== null &&
        secondsSincePrevious >= CONVERSATION_GAP_SECONDS);
    const nextTimestamp =
      index + 1 < messages.length && messages[index + 1].timestamp
        ? Date.parse(messages[index + 1].timestamp as string)
        : Number.NaN;
    const secondsUntilNext =
      Number.isFinite(currentTime) && Number.isFinite(nextTimestamp)
        ? Math.max(0, (nextTimestamp - currentTime) / 1000)
        : null;
    const isConversationEnder =
      index === messages.length - 1 ||
      (secondsUntilNext !== null &&
        secondsUntilNext >= CONVERSATION_GAP_SECONDS);
    const cleanedText = message.text
      .replace(/\r\n?/g, "\n")
      .replace(/\u0000/g, "")
      .trim();

    return {
      message_id: index + 1,
      sender: message.sender.trim(),
      timestamp,
      raw_timestamp: message.timestamp,
      raw_text: message.text,
      cleaned_text: cleanedText,
      message_type: inferMessageType(cleanedText),
      reply_to_message_id: null,
      media_description: null,
      word_count: cleanedText.match(WORD_PATTERN)?.length ?? 0,
      detected_language: null,
      conversation_day: timestamp ? timestamp.slice(0, 10) : null,
      seconds_since_previous: secondsSincePrevious,
      is_conversation_starter: isConversationStarter,
      is_conversation_ender: isConversationEnder,
    };
  });

  const participantMessages = new Map<string, NormalizedMessage[]>();
  const responseTimes = new Map<string, number[]>();
  const participantEmoji = new Map<string, Record<string, number>>();
  const emojiFrequency: Record<string, number> = {};
  const dailyCounts: Record<string, number> = {};
  const weeklyCounts: Record<string, number> = {};
  const messageInitiations: Record<string, number> = {};
  const silenceEvents: NormalizedChatMetrics["silence_events"] = [];
  const unansweredQuestions: number[] = [];
  const lateNightMessageIds: number[] = [];
  let longestSilenceSeconds: number | null = null;
  let timestampCount = 0;

  for (let index = 0; index < normalizedMessages.length; index += 1) {
    const message = normalizedMessages[index];
    const participant = participantMessages.get(message.sender) ?? [];
    participant.push(message);
    participantMessages.set(message.sender, participant);

    if (message.timestamp) {
      timestampCount += 1;
      increment(dailyCounts, message.timestamp.slice(0, 10));
      increment(weeklyCounts, mondayWeek(new Date(message.timestamp)));
      const hour = new Date(message.timestamp).getUTCHours();
      if (hour < 5 || hour >= 23) lateNightMessageIds.push(message.message_id);
    }

    if (message.is_conversation_starter) {
      increment(messageInitiations, message.sender);
    }

    const emojis = message.cleaned_text.match(EMOJI_PATTERN) ?? [];
    const participantEmojis = participantEmoji.get(message.sender) ?? {};
    for (const emoji of emojis) {
      increment(emojiFrequency, emoji);
      increment(participantEmojis, emoji);
    }
    participantEmoji.set(message.sender, participantEmojis);

    const elapsed = message.seconds_since_previous;
    if (elapsed !== null && elapsed >= MAJOR_SILENCE_SECONDS && index > 0) {
      const previous = normalizedMessages[index - 1];
      silenceEvents.push({
        start_message_id: previous.message_id,
        end_message_id: message.message_id,
        seconds: elapsed,
        participants: [...new Set([previous.sender, message.sender])],
      });
      longestSilenceSeconds = Math.max(longestSilenceSeconds ?? 0, elapsed);
    }

    if (message.cleaned_text.includes("?")) {
      const next = normalizedMessages[index + 1];
      if (!next || next.sender === message.sender) {
        unansweredQuestions.push(message.message_id);
      }
    }

    if (index > 0) {
      const previous = normalizedMessages[index - 1];
      if (
        previous.sender !== message.sender &&
        elapsed !== null &&
        elapsed < CONVERSATION_GAP_SECONDS
      ) {
        const samples = responseTimes.get(message.sender) ?? [];
        samples.push(elapsed);
        responseTimes.set(message.sender, samples);
      }
    }
  }

  const allRepeatedPhrases = repeatedTexts(normalizedMessages);
  const participantMetrics = [...participantMessages.entries()].map(
    ([participant, participantItems]) => {
      const responseSamples = responseTimes.get(participant) ?? [];
      const words = participantItems.reduce((sum, message) => sum + message.word_count, 0);
      return {
        participant,
        message_count: participantItems.length,
        conversation_starters: participantItems.filter((item) => item.is_conversation_starter).length,
        conversation_enders: participantItems.filter((item) => item.is_conversation_ender).length,
        average_message_length_words:
          participantItems.length > 0 ? words / participantItems.length : null,
        average_response_seconds:
          responseSamples.length > 0
            ? responseSamples.reduce((sum, value) => sum + value, 0) / responseSamples.length
            : null,
        emoji_frequency: participantEmoji.get(participant) ?? {},
        question_count: participantItems.filter((item) => item.cleaned_text.includes("?")).length,
        apology_count: participantItems.filter((item) => APOLOGY_PATTERN.test(item.cleaned_text)).length,
        affection_expression_count: participantItems.filter((item) => AFFECTION_PATTERN.test(item.cleaned_text)).length,
        repeated_phrases: allRepeatedPhrases.filter((phrase) =>
          participantItems.some((item) => item.cleaned_text.trim().toLocaleLowerCase() === phrase.toLocaleLowerCase()),
        ),
      };
    },
  );

  const messagesWithText = normalizedMessages.filter((message) => message.cleaned_text.length > 0);
  const metrics: NormalizedChatMetrics = {
    message_count: normalizedMessages.length,
    participant_metrics: participantMetrics,
    silence_events: silenceEvents,
    daily_message_volume: Object.entries(dailyCounts).map(([period, message_count]) => ({ period, message_count })),
    weekly_message_volume: Object.entries(weeklyCounts).map(([period, message_count]) => ({ period, message_count })),
    emoji_frequency: emojiFrequency,
    repeated_phrases: allRepeatedPhrases,
    unanswered_questions: unansweredQuestions,
    media_sharing_patterns: [
      `${normalizedMessages.filter((message) => message.message_type !== "text").length} messages are marked as media or non-text.`,
    ],
    timestamp_coverage:
      normalizedMessages.length > 0 ? timestampCount / normalizedMessages.length : 0,
    longest_silence_seconds: longestSilenceSeconds,
    message_initiations: messageInitiations,
    late_night_message_ids: lateNightMessageIds,
  };

  return {
    schema_version: "1.0",
    normalization_notes: normalizationNotes,
    normalized_messages: normalizedMessages,
    chat_metrics: metrics,
  };
}
