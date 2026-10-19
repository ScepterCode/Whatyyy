const DEVICE_KEY_STORAGE_KEY = "between-the-lines:device-key:v1";

export function getOrCreateDeviceKey(): string {
  if (typeof window === "undefined" || !window.localStorage || !window.crypto?.getRandomValues) {
    throw new Error("This browser can’t create a private report-storage key.");
  }
  const existing = window.localStorage.getItem(DEVICE_KEY_STORAGE_KEY);
  if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) return existing;

  const bytes = window.crypto.getRandomValues(new Uint8Array(32));
  const binary = String.fromCharCode(...bytes);
  const key = window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  window.localStorage.setItem(DEVICE_KEY_STORAGE_KEY, key);
  return key;
}
