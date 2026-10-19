import type { ReportStorage, StoredReport } from "./report-storage";
import { getOrCreateDeviceKey } from "./device-key";

export class RemoteReportStorage implements ReportStorage {
  async list(): Promise<StoredReport[]> {
    const response = await this.request("/api/reports");
    const value = (await response.json()) as { reports?: StoredReport[] };
    if (!Array.isArray(value.reports)) throw new Error("Saved reports returned an unsupported response.");
    return value.reports;
  }

  async save(report: StoredReport): Promise<void> {
    await this.request("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
  }

  async delete(id: string): Promise<void> {
    await this.request(`/api/reports?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async clear(): Promise<void> {
    await this.request("/api/reports?all=1", { method: "DELETE" });
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const deviceKey = getOrCreateDeviceKey();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${deviceKey}`);
    const response = await fetch(path, { ...init, headers });
    if (!response.ok) {
      const value = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(value?.error || "Report storage could not complete the request.");
    }
    return response;
  }
}
