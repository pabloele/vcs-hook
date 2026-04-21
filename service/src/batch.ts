import { rebuildAndUpdate } from "./chain.js";
import { config } from "./config.js";

let _timer: ReturnType<typeof setTimeout> | null = null;

// Schedule a rebuild after delayMs. If a timer is already active, ignore.
export function scheduleDefault(): void {
  if (_timer) return;
  _schedule(config.defaultWindowMs);
}

// Reschedule with a custom delay. Cancels any existing timer.
// delayMs === 0 → flush immediately.
export function reschedule(delayMs: number): void {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  if (delayMs === 0) {
    flush();
    return;
  }
  _schedule(delayMs);
}

export async function flush(): Promise<void> {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  await rebuildAndUpdate();
}

function _schedule(delayMs: number): void {
  console.log(`Batch window: rebuild in ${delayMs}ms`);
  _timer = setTimeout(async () => {
    _timer = null;
    await rebuildAndUpdate().catch((err) =>
      console.error("rebuildAndUpdate failed:", err)
    );
  }, delayMs);
}
