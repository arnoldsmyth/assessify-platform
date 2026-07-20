/**
 * Failed-PIN attempt counters + lockout timestamps (spec 05: "5 failed
 * attempts → 15-minute lockout ... store counters in Valkey").
 *
 * The schema deliberately has no attempt columns on `respondent_sessions` —
 * this state is volatile and belongs in Valkey. Valkey is not provisioned in
 * this repo yet, so the port ships with an in-memory implementation good for
 * a single process; swap in a Valkey-backed implementation behind the same
 * interface once the infra lands. The lockout POLICY (threshold, duration)
 * lives in the service layer — this store only counts and remembers.
 */

export interface PinAttemptState {
  failedAttempts: number;
  /** Non-null while the session is locked out. */
  lockedUntil: Date | null;
}

export interface PinAttemptStore {
  get(sessionId: string): Promise<PinAttemptState>;
  /** Record one failed attempt; resolves to the new failure count. */
  increment(sessionId: string): Promise<number>;
  /** Lock the session until the given instant (counter is retained). */
  lock(sessionId: string, until: Date): Promise<void>;
  /** Reset counters + lock (successful PIN entry, lockout expiry). */
  clear(sessionId: string): Promise<void>;
}

const EMPTY: PinAttemptState = { failedAttempts: 0, lockedUntil: null };

export function createInMemoryPinAttemptStore(): PinAttemptStore {
  const states = new Map<string, PinAttemptState>();

  return {
    async get(sessionId) {
      const state = states.get(sessionId);
      return state ? { ...state } : { ...EMPTY };
    },
    async increment(sessionId) {
      const state = states.get(sessionId) ?? { ...EMPTY };
      state.failedAttempts += 1;
      states.set(sessionId, state);
      return state.failedAttempts;
    },
    async lock(sessionId, until) {
      const state = states.get(sessionId) ?? { ...EMPTY };
      state.lockedUntil = until;
      states.set(sessionId, state);
    },
    async clear(sessionId) {
      states.delete(sessionId);
    },
  };
}
