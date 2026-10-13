import type { PtyBufferSnapshot, PtyDataEvent, PtyOutputChunk } from "@shared/contracts";

interface OutputTerminal {
  cols: number;
  rows: number;
  reset(): void;
  resize(cols: number, rows: number): void;
  write(data: string, callback: () => void): void;
}

/** Serialize resize/write operations and merge replay with the live stream exactly once. */
export class TerminalOutput {
  private tail = Promise.resolve();
  private pending: PtyDataEvent[] = [];
  private loading: Promise<void> | null = null;
  private queued = 0;
  private startedAt = 0;
  private sequence = 0;
  applyingSize = false;

  constructor(private readonly terminal: OutputTerminal, private readonly onIdle: () => void = () => {}) {}

  get busy(): boolean {
    return this.loading !== null || this.queued > 0;
  }

  async flush(): Promise<void> {
    await this.loading;
    await this.tail;
  }

  private resize(cols: number, rows: number): void {
    if (this.terminal.cols === cols && this.terminal.rows === rows) return;
    this.applyingSize = true;
    try {
      this.terminal.resize(cols, rows);
    } finally {
      this.applyingSize = false;
    }
  }

  private async write(chunk: PtyOutputChunk): Promise<void> {
    this.resize(chunk.cols, chunk.rows);
    if (chunk.data) await new Promise<void>((resolve) => this.terminal.write(chunk.data, resolve));
  }

  push(event: PtyDataEvent): void {
    if (this.loading) {
      this.pending.push(event);
      return;
    }
    if (event.startedAt < this.startedAt) return;
    if (event.startedAt !== this.startedAt) {
      this.startedAt = event.startedAt;
      this.sequence = 0;
    }
    if (event.sequence <= this.sequence) return;
    this.sequence = event.sequence;
    this.queued++;
    this.tail = this.tail.then(() => this.write(event)).finally(() => {
      this.queued--;
      if (!this.busy) this.onIdle();
    });
  }

  restore(fetch: () => Promise<PtyBufferSnapshot | null>, beforeReplay: () => void): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.replay(fetch, beforeReplay).finally(() => {
      this.loading = null;
      const pending = this.pending;
      this.pending = [];
      for (const event of pending) this.push(event);
      if (!this.busy) this.onIdle();
    });
    return this.loading;
  }

  private async replay(fetch: () => Promise<PtyBufferSnapshot | null>, beforeReplay: () => void): Promise<void> {
    const snapshot = await fetch();
    await this.tail;
    if (!snapshot) return;
    this.terminal.reset();
    this.startedAt = snapshot.startedAt;
    this.sequence = snapshot.lastSequence;
    const first = snapshot.chunks[0] ?? snapshot;
    this.resize(first.cols, first.rows);
    beforeReplay();
    // Drain desktop log writes before changing the geometry for the PTY stream.
    await new Promise<void>((resolve) => this.terminal.write("", resolve));
    for (const chunk of snapshot.chunks) await this.write(chunk);
    this.resize(snapshot.cols, snapshot.rows);
  }
}
