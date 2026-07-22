function requireFunction(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
}

export class FrameQueue {
  #requestFrame;

  #cancelFrame;

  #generationFor;

  #pending = new Map();

  #scheduled = null;

  #alive = true;

  constructor(callbacks) {
    if (callbacks === null || typeof callbacks !== 'object') {
      throw new TypeError('FrameQueue callbacks must be an object');
    }

    const { requestFrame, cancelFrame, generationFor } = callbacks;
    requireFunction('requestFrame', requestFrame);
    requireFunction('cancelFrame', cancelFrame);
    requireFunction('generationFor', generationFor);

    this.#requestFrame = requestFrame;
    this.#cancelFrame = cancelFrame;
    this.#generationFor = generationFor;
  }

  enqueue(candidate) {
    if (!this.#alive) {
      throw new Error('Cannot enqueue into a destroyed FrameQueue');
    }
    if (candidate === null || typeof candidate !== 'object') {
      throw new TypeError('FrameQueue job must be an object');
    }

    const {
      key,
      generation,
      read,
      write,
      onError,
    } = candidate;
    requireFunction('read', read);
    requireFunction('write', write);
    if (onError !== undefined) {
      requireFunction('onError', onError);
    }

    this.#pending.delete(key);
    this.#pending.set(key, {
      key,
      generation,
      read,
      write,
      onError,
    });
    this.#schedule();
  }

  cancel(key) {
    if (!this.#pending.delete(key) || this.#pending.size !== 0 || this.#scheduled === null) {
      return;
    }

    const scheduled = this.#scheduled;
    this.#scheduled = null;
    this.#cancelFrame(scheduled.id);
  }

  destroy() {
    if (!this.#alive) {
      return;
    }

    this.#alive = false;
    this.#pending.clear();
    if (this.#scheduled !== null) {
      this.#cancelFrame(this.#scheduled.id);
      this.#scheduled = null;
    }
  }

  #schedule() {
    if (this.#scheduled !== null) {
      return;
    }

    const token = { id: undefined };
    this.#scheduled = token;
    try {
      token.id = this.#requestFrame(() => this.#flush(token));
    } catch (error) {
      if (this.#scheduled === token) {
        this.#scheduled = null;
      }
      throw error;
    }
  }

  #flush(token) {
    if (!this.#alive || this.#scheduled !== token) {
      return;
    }

    this.#scheduled = null;
    const jobs = this.#pending;
    this.#pending = new Map();
    const reads = [];

    for (const job of jobs.values()) {
      if (!this.#alive) {
        return;
      }

      let currentGeneration;
      try {
        currentGeneration = this.#generationFor(job.key);
      } catch (error) {
        this.#report(job, error);
        continue;
      }
      if (currentGeneration !== job.generation) {
        continue;
      }

      try {
        reads.push({ job, value: job.read() });
      } catch (error) {
        this.#report(job, error);
      }
    }

    for (const entry of reads) {
      if (!this.#alive) {
        return;
      }

      let currentGeneration;
      try {
        currentGeneration = this.#generationFor(entry.job.key);
      } catch (error) {
        this.#report(entry.job, error);
        continue;
      }
      if (currentGeneration !== entry.job.generation) {
        continue;
      }

      try {
        entry.job.write(entry.value);
      } catch (error) {
        this.#report(entry.job, error);
      }
    }
  }

  #report(job, error) {
    if (job.onError === undefined) {
      return;
    }

    try {
      job.onError(error);
    } catch {
      // Error reporting is isolated from the rest of the frame.
    }
  }
}
