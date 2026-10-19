import { parseChatReport, type ChatReport, type ReportSettings } from "../report";

export type StoredReport = {
  id: string;
  created_at: string;
  title: string;
  participants: string[];
  message_count: number;
  settings: ReportSettings;
  report: ChatReport;
};

export interface ReportStorage {
  list(): Promise<StoredReport[]>;
  save(report: StoredReport): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export const REPORT_STORAGE_KEY = "between-the-lines:reports:v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseSettings(value: unknown): ReportSettings | null {
  if (!isRecord(value) || typeof value.language !== "string") return null;
  const relationship_type: ReportSettings["relationship_type"] | null =
    value.relationship_type === "romantic" ||
    value.relationship_type === "friendship" ||
    value.relationship_type === "family" ||
    value.relationship_type === "group" ||
    value.relationship_type === "workplace" ||
    value.relationship_type === "unknown"
      ? value.relationship_type
      : null;
  const tone: ReportSettings["tone"] | null =
    value.tone === "gentle" || value.tone === "direct" || value.tone === "brutal_but_fair"
      ? value.tone
      : null;
  const depth: ReportSettings["depth"] | null =
    value.depth === "standard" || value.depth === "deep_dive" || value.depth === "group_chat"
      ? value.depth
      : null;
  if (!relationship_type || !tone || !depth) return null;
  return { relationship_type, tone, depth, language: value.language };
}

export function parseStoredReport(value: unknown): StoredReport {
  if (!isRecord(value)) {
    throw new Error("Saved report history has an unsupported format. Clear report storage to continue.");
  }
  const settings = parseSettings(value.settings);
  if (
    typeof value.id !== "string" ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    typeof value.title !== "string" ||
    !Array.isArray(value.participants) ||
    !value.participants.every((participant) => typeof participant === "string") ||
    typeof value.message_count !== "number" ||
    !Number.isInteger(value.message_count) ||
    !settings ||
    !isRecord(value.report)
  ) {
    throw new Error("Saved report history has an unsupported format. Clear report storage to continue.");
  }
  return {
    id: value.id,
    created_at: value.created_at,
    title: value.title,
    participants: value.participants,
    message_count: value.message_count,
    settings,
    report: parseChatReport(value.report),
  };
}

export class LocalReportStorage implements ReportStorage {
  async list(): Promise<StoredReport[]> {
    const value = this.read();
    return [...value].sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async save(report: StoredReport): Promise<void> {
    const reports = this.read().filter((existing) => existing.id !== report.id);
    reports.push(report);
    try {
      this.storage().setItem(REPORT_STORAGE_KEY, JSON.stringify(reports));
    } catch (error) {
      if (error instanceof DOMException && error.name === "QuotaExceededError") {
        throw new Error("This report couldn’t be saved because browser storage is full. Delete older reports and try again.");
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const reports = this.read().filter((report) => report.id !== id);
    this.storage().setItem(REPORT_STORAGE_KEY, JSON.stringify(reports));
  }

  async clear(): Promise<void> {
    this.storage().removeItem(REPORT_STORAGE_KEY);
  }

  private read(): StoredReport[] {
    const raw = this.storage().getItem(REPORT_STORAGE_KEY);
    if (raw === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Saved report history is unreadable. Clear browser report storage to continue.");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Saved report history has an unsupported format. Clear browser report storage to continue.");
    }
    return parsed.map(parseStoredReport);
  }

  private storage(): Storage {
    if (typeof window === "undefined" || !window.localStorage) {
      throw new Error("Browser storage is unavailable. This report can’t be saved on this device.");
    }
    return window.localStorage;
  }
}
