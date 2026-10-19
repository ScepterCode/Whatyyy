import { createHash } from "node:crypto";

const DEVICE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function getDeviceKey(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const deviceKey = authorization.slice("Bearer ".length);
  return DEVICE_KEY_PATTERN.test(deviceKey) ? deviceKey : null;
}

export function getOwnerHash(deviceKey: string): string {
  return createHash("sha256").update(deviceKey).digest("hex");
}
