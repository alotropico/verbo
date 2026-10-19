const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let clockNow = Date.now();
const clockListeners = new Set<() => void>();
let clockTimer: number | undefined;

export function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockTimer === undefined) {
    clockTimer = window.setInterval(() => {
      clockNow = Date.now();
      clockListeners.forEach((entry) => entry());
    }, 15_000);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== undefined) {
      window.clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

export function readClock(): number {
  return clockNow;
}

export function formatTimeAgo(at: number, now: number, long = false): string {
  const delta = Math.max(0, now - at);
  if (delta < 45_000) return "just now";
  if (delta < HOUR) {
    const minutes = Math.max(1, Math.round(delta / MINUTE));
    return long
      ? `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`
      : `${minutes}m ago`;
  }
  if (delta < DAY) {
    const hours = Math.round(delta / HOUR);
    return long
      ? `${hours} ${hours === 1 ? "hour" : "hours"} ago`
      : `${hours}h ago`;
  }
  if (delta < 14 * DAY) {
    const days = Math.round(delta / DAY);
    return long ? `${days} ${days === 1 ? "day" : "days"} ago` : `${days}d ago`;
  }
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(at);
}

export function formatLocalInstant(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  }).format(at);
}
