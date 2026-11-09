// The two ways a store can refuse. Every store reports its failures as one of these, so sync treats them alike.

/** A failure worth retrying (the store slow, down or rate-limited), and when to try again at the earliest. */
export class TransientError extends Error {
  constructor(message, retryAt = null) {
    super(message);
    this.transient = true;
    this.retryAt = retryAt;
  }
}

/** A failure that retrying won't fix (no such item, no access, a rejected edit): it needs a person. */
export class PermanentError extends Error {}
