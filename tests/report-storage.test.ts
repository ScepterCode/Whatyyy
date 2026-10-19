import { afterEach, describe, expect, it, vi } from "vitest";
import { REPORT_SECTION_IDS, type ChatReport } from "../lib/report";
import { LocalReportStorage, REPORT_STORAGE_KEY, type StoredReport } from "../lib/storage/report-storage";

function fixture(id = "report-1"): StoredReport {
  const report: ChatReport = {
    title: "A clear, careful read",
    persona_name: "Ada",
    persona_description: "A thoughtful outside reader.",
    central_thesis: "There is not enough evidence to infer a broader pattern.",
    safety_note: null,
    sections: REPORT_SECTION_IDS.map((sectionId) => ({
      id: sectionId,
      title: sectionId,
      body: "The available evidence is limited.",
      evidence_message_ids: [],
      quotes: [],
    })),
  };
  return {
    id,
    created_at: "2026-03-12T09:15:00.000Z",
    title: report.title,
    participants: ["Maya", "Sam"],
    message_count: 12,
    settings: {
      relationship_type: "friendship",
      tone: "direct",
      depth: "standard",
      language: "en",
    },
    report,
  };
}

function installStorage() {
  const records = new Map<string, string>();
  const localStorage = {
    getItem: vi.fn((key: string) => records.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => records.set(key, value)),
    removeItem: vi.fn((key: string) => records.delete(key)),
  };
  vi.stubGlobal("window", { localStorage });
  return { records, localStorage };
}

afterEach(() => vi.unstubAllGlobals());

describe("LocalReportStorage", () => {
  it("saves and lists reports without storing chat messages", async () => {
    const { records } = installStorage();
    const storage = new LocalReportStorage();
    await storage.save(fixture());

    const stored = records.get(REPORT_STORAGE_KEY) ?? "";
    expect(stored).not.toContain("message text");
    await expect(storage.list()).resolves.toMatchObject([{ id: "report-1", title: "A clear, careful read" }]);
  });

  it("deletes individual reports and clears the full history", async () => {
    installStorage();
    const storage = new LocalReportStorage();
    await storage.save(fixture("report-1"));
    await storage.save(fixture("report-2"));
    await storage.delete("report-1");
    await expect(storage.list()).resolves.toMatchObject([{ id: "report-2" }]);
    await storage.clear();
    await expect(storage.list()).resolves.toEqual([]);
  });

  it("reports a full browser storage quota clearly", async () => {
    const { localStorage } = installStorage();
    localStorage.setItem.mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    await expect(new LocalReportStorage().save(fixture())).rejects.toThrow("browser storage is full");
  });

  it("does not silently accept corrupted history", async () => {
    const { records } = installStorage();
    records.set(REPORT_STORAGE_KEY, "{broken");
    await expect(new LocalReportStorage().list()).rejects.toThrow("Saved report history is unreadable");
  });
});
