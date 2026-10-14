import { describe, expect, it, vi } from "vitest";
import { isPublicAddress, publicUrl, resolvePublicUrl } from "./public-network";

describe("public network boundary", () => {
  it("rejects private, mapped, reserved and link-local IPv4/IPv6 destinations", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "224.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
    ])
      expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("rejects unsafe schemes/credentials/ports and numeric localhost disguises", () => {
    for (const value of [
      "file:///C:/secret",
      "data:text/plain,x",
      "javascript:alert(1)",
      "http://localhost/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://example.com:9999/",
      "https://user:password@example.com/",
    ])
      expect(() => publicUrl(value)).toThrow();
  });
  it("rejects DNS answers containing any private address and returns the exact validated address", async () => {
    const privateResolver = async (): Promise<
      Array<{ address: string; family: number }>
    > => [{ address: "127.0.0.1", family: 4 }];
    await expect(
      resolvePublicUrl("https://example.com/", privateResolver),
    ).rejects.toThrow("unsafe_address");
    const publicResolver = async (): Promise<
      Array<{ address: string; family: number }>
    > => [{ address: "8.8.8.8", family: 4 }];
    expect(
      (await resolvePublicUrl("https://example.com/", publicResolver)).address,
    ).toBe("8.8.8.8");
  });
  it("bounds stalled DNS and cancels without waiting for resolver completion", async () => {
    const resolver = (): Promise<Array<{ address: string; family: number }>> =>
      new Promise(() => {});
    const controller = new AbortController();
    const pending = resolvePublicUrl(
      "https://example.com/",
      resolver,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    vi.useFakeTimers();
    try {
      const stalled = expect(
        resolvePublicUrl("https://example.com/", resolver),
      ).rejects.toThrow("timeout");
      await vi.advanceTimersByTimeAsync(5000);
      await stalled;
    } finally {
      vi.useRealTimers();
    }
  });
});
