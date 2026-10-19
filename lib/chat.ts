export type ChatMessage = {
  sender: string;
  timestamp: string | null;
  text: string;
};

export type ChatStats = {
  messageCount: number;
  participantCounts: Record<string, number>;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  initiatorCounts: Record<string, number>;
  averageMessageLength: Record<string, number>;
  longestSilenceHours: number | null;
};

const DATE_TIME =
  /^(?:\[)?(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)(?:\])?(?:\s*(?:-|–|—|:)\s*|\s+)(.*)$/;

function toIsoTimestamp(date: string, time: string): string | null {
  const dateParts = date.split(/[./-]/).map(Number);
  let year: number;
  let month: number;
  let day: number;

  if (dateParts[0] > 999) {
    [year, month, day] = dateParts;
  } else {
    const [first, second, shortYear] = dateParts;
    year = shortYear < 100 ? 2000 + shortYear : shortYear;
    if (first > 12) {
      day = first;
      month = second;
    } else if (second > 12) {
      month = first;
      day = second;
    } else {
      day = first;
      month = second;
    }
  }

  const match = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap][Mm])?$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  const meridiem = match[4]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;

  const value = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  return value.toISOString();
}

function parseLineStart(line: string): {
  sender: string;
  timestamp: string | null;
  text: string;
} | null {
  const match = line.match(DATE_TIME);
  if (!match) return null;

  const messageParts = match[3].match(/^([^:]{1,100}):\s?(.*)$/);
  if (!messageParts) return null;

  return {
    sender: messageParts[1].trim(),
    timestamp: toIsoTimestamp(match[1], match[2]),
    text: messageParts[2],
  };
}

export function parseWhatsAppExport(source: string): {
  messages: ChatMessage[];
  participants: string[];
} {
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  const messages: ChatMessage[] = [];

  for (const line of lines) {
    const parsed = parseLineStart(line);
    if (parsed) {
      messages.push(parsed);
    } else if (
      messages.length > 0 &&
      line.trim() &&
      !/^(?:\[)?\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s+\d{1,2}:\d{2}/.test(line)
    ) {
      messages[messages.length - 1].text += `\n${line}`;
    }
  }

  const participants = [...new Set(messages.map((message) => message.sender))];
  return { messages, participants };
}

export function calculateChatStats(messages: ChatMessage[]): ChatStats {
  const participantCounts: Record<string, number> = Object.create(null);
  const initiatorCounts: Record<string, number> = Object.create(null);
  const totalLength: Record<string, number> = Object.create(null);
  const firstMessages = new Map<string, number>();
  const datedMessages = messages
    .map((message, index) => ({
      index,
      sender: message.sender,
      time: message.timestamp ? Date.parse(message.timestamp) : Number.NaN,
    }))
    .filter((message) => Number.isFinite(message.time))
    .sort((a, b) => a.time - b.time);

  for (const message of messages) {
    participantCounts[message.sender] = (participantCounts[message.sender] ?? 0) + 1;
    totalLength[message.sender] = (totalLength[message.sender] ?? 0) + message.text.length;
  }

  let previousDate: number | null = null;
  let longestSilenceMs = 0;
  for (const message of datedMessages) {
    if (!firstMessages.has(message.sender)) {
      firstMessages.set(message.sender, message.index);
    }
    if (previousDate !== null) {
      longestSilenceMs = Math.max(longestSilenceMs, message.time - previousDate);
    }
    previousDate = message.time;
  }

  const firstAtBySender = new Map<string, number>();
  for (const [sender, index] of firstMessages) {
    firstAtBySender.set(sender, index);
  }
  for (const message of messages) {
    if (!Object.prototype.hasOwnProperty.call(initiatorCounts, message.sender)) {
      initiatorCounts[message.sender] = 0;
    }
  }

  const orderedSenders = [...firstAtBySender.entries()].sort((a, b) => a[1] - b[1]);
  if (orderedSenders.length > 0) {
    const earliest = orderedSenders[0][0];
    initiatorCounts[earliest] = (initiatorCounts[earliest] ?? 0) + 1;
  }

  const firstTimestamp = datedMessages[0]?.time;
  const lastTimestamp = datedMessages[datedMessages.length - 1]?.time;
  return {
    messageCount: messages.length,
    participantCounts,
    firstMessageAt:
      firstTimestamp === undefined ? null : new Date(firstTimestamp).toISOString(),
    lastMessageAt:
      lastTimestamp === undefined ? null : new Date(lastTimestamp).toISOString(),
    initiatorCounts,
    averageMessageLength: Object.fromEntries(
      Object.entries(participantCounts).map(([sender, count]) => [
        sender,
        Math.round(totalLength[sender] / count),
      ]),
    ),
    longestSilenceHours:
      datedMessages.length < 2 ? null : Math.round(longestSilenceMs / 3_600_000),
  };
}
