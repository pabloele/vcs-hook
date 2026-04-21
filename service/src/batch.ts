import { rebuildAndUpdate } from "./chain.js";
import { config } from "./config.js";

const _timers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleDefault(hookAddress: string): void {
  const key = hookAddress.toLowerCase();
  if (_timers.has(key)) return;
  _schedule(key, config.defaultWindowMs);
}

export function reschedule(hookAddress: string, delayMs: number): void {
  const key = hookAddress.toLowerCase();
  const existing = _timers.get(key);
  if (existing) { clearTimeout(existing); _timers.delete(key); }
  if (delayMs === 0) {
    flush(hookAddress);
    return;
  }
  _schedule(key, delayMs);
}

export async function flush(hookAddress: string): Promise<void> {
  const key = hookAddress.toLowerCase();
  const existing = _timers.get(key);
  if (existing) { clearTimeout(existing); _timers.delete(key); }
  await rebuildAndUpdate(hookAddress);
}

function _schedule(key: string, delayMs: number): void {
  console.log(`Hook ${key}: rebuild in ${delayMs}ms`);
  _timers.set(key, setTimeout(async () => {
    _timers.delete(key);
    await rebuildAndUpdate(key).catch((err) =>
      console.error(`Hook ${key}: rebuildAndUpdate failed:`, err)
    );
  }, delayMs));
}
