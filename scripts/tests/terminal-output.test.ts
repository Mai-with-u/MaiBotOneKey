import { expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { PtyOutputHistory } from "../../src/main/pty/output-history";
import { TerminalOutput } from "../../src/renderer/src/lib/terminal-output";
import type { PtyBufferSnapshot, PtyDataEvent } from "../../src/shared/contracts";

class RecordingTerminal {
  cols = 80;
  rows = 24;
  writes: Array<{ data: string; cols: number }> = [];
  resets = 0;
  reset() { this.writes = []; this.resets++; }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  write(data: string, callback: () => void) {
    // xterm parses asynchronously; resizing before its callback changes how text wraps.
    setTimeout(() => {
      if (data) this.writes.push({ data, cols: this.cols });
      callback();
    }, 0);
  }
}

function event(sequence: number, data: string, cols = 100, startedAt = 1): PtyDataEvent {
  return { sessionId: "service:maibot", sequence, data, cols, rows: 32, startedAt };
}

test("history retains the geometry of each output segment and returns immutable snapshots", () => {
  const history = new PtyOutputHistory();
  history.append("╔══╗\r\n", 100, 32);
  const before = history.snapshot(100, 32, 1);
  history.append("hello", 100, 32);
  history.append("", 60, 24);
  history.append("你好", 60, 24);
  const after = history.snapshot(60, 24, 1);
  expect(before.chunks[0].data).toBe("╔══╗\r\n");
  expect(after.chunks.map(({ cols, data }) => ({ cols, data }))).toEqual([
    { cols: 100, data: "╔══╗\r\nhello" }, { cols: 60, data: "你好" },
  ]);
  expect(after.lastSequence).toBe(4);
  history.clear();
  expect(history.snapshot(60, 24, 1).chunks).toEqual([]);
  expect(history.append("new", 60, 24).sequence).toBe(5);
});

test("replay parses each segment at its original width before applying the next resize", async () => {
  const terminal = new RecordingTerminal();
  const output = new TerminalOutput(terminal);
  const history = new PtyOutputHistory();
  history.append("wide border", 140, 32);
  history.append("narrow border", 90, 24);
  await output.restore(async () => history.snapshot(110, 30, 1), () => {});
  expect(terminal.writes).toEqual([
    { data: "wide border", cols: 140 }, { data: "narrow border", cols: 90 },
  ]);
  expect([terminal.cols, terminal.rows]).toEqual([110, 30]);
});

test("reconnect merges overlapping history and live output exactly once without losing new data", async () => {
  const terminal = new RecordingTerminal();
  const output = new TerminalOutput(terminal);
  let resolve!: (snapshot: PtyBufferSnapshot) => void;
  const fetch = new Promise<PtyBufferSnapshot>((done) => { resolve = done; });
  const restore = output.restore(() => fetch, () => {});
  const sameRestore = output.restore(() => { throw new Error("duplicate fetch"); }, () => {});
  expect(sameRestore).toBe(restore);
  output.push(event(1, "history"));
  output.push(event(2, "new", 120));
  resolve({ chunks: [event(1, "history")], lastSequence: 1, cols: 100, rows: 32, startedAt: 1 });
  await restore;
  await output.flush();
  expect(terminal.writes).toEqual([{ data: "history", cols: 100 }, { data: "new", cols: 120 }]);
  expect(terminal.resets).toBe(1);
});

test("a failed history request still drains live output and permits a later retry", async () => {
  const terminal = new RecordingTerminal();
  const output = new TerminalOutput(terminal);
  const restore = output.restore(async () => { throw new Error("offline"); }, () => {});
  output.push(event(1, "live"));
  await expect(restore).rejects.toThrow("offline");
  await output.flush();
  expect(terminal.writes).toEqual([{ data: "live", cols: 100 }]);
  await output.restore(async () => null, () => {});
  expect(output.busy).toBe(false);
});

test("new process sequences restart without accepting delayed output from the previous process", async () => {
  const terminal = new RecordingTerminal();
  const output = new TerminalOutput(terminal);
  output.push(event(15, "old", 100, 1));
  output.push(event(1, "new", 120, 2));
  output.push(event(16, "stale", 100, 1));
  await output.flush();
  expect(terminal.writes.map(({ data }) => data)).toEqual(["old", "new"]);
});

test("history stays bounded and clear does not reuse live sequence numbers", () => {
  const history = new PtyOutputHistory(12);
  history.append("12345678", 100, 32);
  history.append("ABCDEFGH", 90, 32);
  expect(history.snapshot(90, 32, 1).chunks.map(({ data }) => data).join("")).toBe("ABCDEFGH");
  history.clear();
  expect(history.append("x", 90, 32).sequence).toBe(3);
});

test("real xterm retains full-width colored Chinese panels across live output and reconnect", async () => {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  const output = new TerminalOutput(terminal);
  const cols = 151;
  const lines = [
    `╭${"─".repeat(cols - 2)}╮`,
    `│ 中文${" ".repeat(cols - 8)} │`,
    `╰${"─".repeat(cols - 2)}╯`,
  ];
  const history = new PtyOutputHistory();
  try {
    for (const line of lines) {
      const chunk = history.append(`\x1b[36m${line}\x1b[0m\r\n`, cols, 24);
      output.push({ ...chunk, sessionId: "service:maibot", startedAt: 1 });
    }
    await output.flush();
    const check = () => {
      for (const [i, text] of lines.entries()) {
        const line = terminal.buffer.active.getLine(i)!;
        expect(line.translateToString(true)).toBe(text);
        expect(line.isWrapped).toBe(false);
        expect(line.getCell(cols - 1)?.getChars()).toBe(i === 0 ? "╮" : i === 2 ? "╯" : "│");
      }
    };
    check();
    await output.restore(async () => history.snapshot(cols, 24, 1), () => {});
    check();
  } finally {
    terminal.dispose();
  }
});
