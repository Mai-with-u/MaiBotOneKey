import type { PtyBufferSnapshot, PtyOutputChunk } from "../../shared/contracts";

/** Keep the geometry with the VT stream: cursor positions depend on it. */
export class PtyOutputHistory {
  private chunks: PtyOutputChunk[] = [];
  private length = 0;
  private sequence = 0;

  constructor(private readonly limit = 5_000_000) {}

  append(data: string, cols: number, rows: number): PtyOutputChunk {
    const chunk = { data, cols, rows, sequence: ++this.sequence };
    const previous = this.chunks.at(-1);
    if (previous && previous.cols === cols && previous.rows === rows && previous.data.length + data.length < 65_536) {
      previous.data += data;
      previous.sequence = chunk.sequence;
    } else {
      this.chunks.push({ ...chunk });
    }
    this.length += data.length;
    // Bound both text and resize-only history; don't introduce additional cuts inside chunks.
    while ((this.length > this.limit || this.chunks.length > 10_000) && this.chunks.length > 0) {
      this.length -= this.chunks.shift()!.data.length;
    }
    return chunk;
  }

  clear(): void {
    this.chunks = [];
    this.length = 0;
  }

  snapshot(cols: number, rows: number, startedAt: number): PtyBufferSnapshot {
    return { chunks: this.chunks.map((chunk) => ({ ...chunk })), lastSequence: this.sequence, cols, rows, startedAt };
  }
}
