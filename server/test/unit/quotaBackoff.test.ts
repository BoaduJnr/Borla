import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attachQuotaBackoff } from "../../src/jobs/workers.js";

/**
 * A minimal fake matching exactly the BackoffableWorker interface attachQuotaBackoff depends on
 * (on/pause/resume) — no real BullMQ Worker or Redis connection needed to exercise this logic,
 * the same "fake just enough of the real interface" approach as MapView.test.tsx's FakeMap.
 */
function makeFakeWorker() {
  let errorHandler: ((err: Error) => void) | null = null;
  return {
    on: vi.fn((event: string, cb: (err: Error) => void) => {
      if (event === "error") errorHandler = cb;
    }),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    fireError(message: string) {
      errorHandler?.(new Error(message));
    },
  };
}

const QUOTA_MESSAGE =
  "ERR max requests limit exceeded. Limit: 500000, Usage: 500010. See https://upstash.com/docs/redis/troubleshooting/max_requests_limit for details";

describe("attachQuotaBackoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pauses the worker on a quota-exceeded error", () => {
    const worker = makeFakeWorker();
    attachQuotaBackoff(worker, "fanout");

    worker.fireError(QUOTA_MESSAGE);

    expect(worker.pause).toHaveBeenCalledTimes(1);
    expect(worker.resume).not.toHaveBeenCalled();
  });

  it("resumes automatically after the backoff window", () => {
    const worker = makeFakeWorker();
    attachQuotaBackoff(worker, "fanout");

    worker.fireError(QUOTA_MESSAGE);
    expect(worker.resume).not.toHaveBeenCalled();

    vi.advanceTimersByTime(59_000);
    expect(worker.resume).not.toHaveBeenCalled(); // not yet — still mid-backoff

    vi.advanceTimersByTime(1_000); // crosses the 60s mark
    expect(worker.resume).toHaveBeenCalledTimes(1);
  });

  it("does not stack multiple pause/timers while already backing off", () => {
    const worker = makeFakeWorker();
    attachQuotaBackoff(worker, "fanout");

    // BullMQ's real loop would keep re-firing this same error every retry until the pause takes
    // effect — the circuit breaker must collapse repeats into a single pause/resume cycle, not
    // one timer per error.
    worker.fireError(QUOTA_MESSAGE);
    worker.fireError(QUOTA_MESSAGE);
    worker.fireError(QUOTA_MESSAGE);

    expect(worker.pause).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(worker.resume).toHaveBeenCalledTimes(1);
  });

  it("re-arms after resuming — a second quota error later triggers another backoff cycle", () => {
    const worker = makeFakeWorker();
    attachQuotaBackoff(worker, "fanout");

    worker.fireError(QUOTA_MESSAGE);
    vi.advanceTimersByTime(60_000);
    expect(worker.pause).toHaveBeenCalledTimes(1);
    expect(worker.resume).toHaveBeenCalledTimes(1);

    worker.fireError(QUOTA_MESSAGE);
    expect(worker.pause).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(worker.resume).toHaveBeenCalledTimes(2);
  });

  it("does not pause for an unrelated error", () => {
    const worker = makeFakeWorker();
    attachQuotaBackoff(worker, "fanout");

    worker.fireError("ECONNRESET: socket hang up");

    expect(worker.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(worker.resume).not.toHaveBeenCalled();
  });
});
