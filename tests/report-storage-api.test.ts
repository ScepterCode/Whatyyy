import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/reports/route";
import { getOwnerHash } from "../lib/storage/device-capability";
import { del, list } from "@vercel/blob";

vi.mock("@vercel/blob", () => ({
  del: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  put: vi.fn(),
}));

const DEVICE_KEY_A = "A".repeat(43);
const DEVICE_KEY_B = "B".repeat(43);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(del).mockReset();
  vi.mocked(list).mockReset();
});

describe("private Vercel Blob report API", () => {
  it("rejects report access without a device capability", async () => {
    vi.stubEnv("BLOB_STORE_ID", "private-store");

    const response = await GET(new Request("https://app.example/api/reports"));

    expect(response.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("lists only the namespace derived from the requesting device key", async () => {
    vi.stubEnv("BLOB_STORE_ID", "private-store");
    vi.mocked(list).mockImplementation(async (options) => ({
      blobs: [],
      hasMore: false,
      cursor: undefined,
    }));

    const response = await GET(
      new Request("https://app.example/api/reports", {
        headers: { Authorization: `Bearer ${DEVICE_KEY_A}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reports: [] });
    expect(list).toHaveBeenCalledWith({
      prefix: `reports/${getOwnerHash(DEVICE_KEY_A)}/`,
      limit: 1_000,
      cursor: undefined,
    });
  });

  it("cannot delete reports outside the requesting device namespace", async () => {
    vi.stubEnv("BLOB_STORE_ID", "private-store");
    const reportId = "90a54af5-8840-4f6d-9a2f-2a862bffbb59";
    const request = new Request(`https://app.example/api/reports?id=${reportId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${DEVICE_KEY_B}` },
    });
    const { DELETE } = await import("../app/api/reports/route");

    const response = await DELETE(request);

    expect(response.status).toBe(200);
    expect(del).toHaveBeenCalledWith([
      `reports/${createHash("sha256").update(DEVICE_KEY_B).digest("hex")}/${reportId}.json`,
    ]);
    expect(del).not.toHaveBeenCalledWith([
      `reports/${createHash("sha256").update(DEVICE_KEY_A).digest("hex")}/${reportId}.json`,
    ]);
  });
});
