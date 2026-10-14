import { isIP, BlockList } from "node:net";
import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupAllOptions } from "node:dns";

type PublicResolver = (
  hostname: string,
  options: LookupAllOptions,
) => Promise<LookupAddress[]>;

const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(ip, prefix, "ipv4");
// Fail closed outside globally routable unicast, excluding special-purpose ranges.
const excluded6 = new BlockList();
for (const [ip, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  excluded6.addSubnet(ip, prefix, "ipv6");
const public6 = new BlockList();
public6.addSubnet("2000::", 3, "ipv6");
export function isPublicAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, "");
  if (isIP(normalized) === 4) return !blocked.check(normalized, "ipv4");
  if (isIP(normalized) === 6)
    return (
      public6.check(normalized, "ipv6") && !excluded6.check(normalized, "ipv6")
    );
  return false;
}
export function publicUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new Error("unsafe_url");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    (!hostname.includes(".") && !isIP(hostname))
  )
    throw new Error("unsafe_url");
  if (isIP(hostname) && !isPublicAddress(hostname))
    throw new Error("unsafe_url");
  return url;
}
export async function resolvePublicUrl(
  value: string,
  resolver: PublicResolver = lookup,
  signal?: AbortSignal,
): Promise<{ url: URL; address: string; family: number }> {
  signal?.throwIfAborted();
  const url = publicUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const answers = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await new Promise<LookupAddress[]>((resolve, reject) => {
        const cancel = (): void => {
          finish();
          reject(new Error("cancelled"));
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error("timeout"));
        }, 5000);
        const finish = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
        };
        signal?.addEventListener("abort", cancel, { once: true });
        void resolver(hostname, { all: true, verbatim: true }).then(
          (value) => {
            finish();
            resolve(value);
          },
          (error) => {
            finish();
            reject(error);
          },
        );
        if (signal?.aborted) cancel();
      });
  if (
    !answers.length ||
    answers.some((answer) => !isPublicAddress(answer.address))
  )
    throw new Error("unsafe_address");
  const selected = answers.find((answer) => answer.family === 4) ?? answers[0];
  return { url, ...selected };
}
