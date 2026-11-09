import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogStore } from "../../../src/main/services/log-store";
import { PtyOutputHistory } from "../../../src/main/pty/output-history";
import type { RuntimePaths } from "../../../src/shared/contracts";

test("ordinary logs and files strip terminal controls while PTY history retains colors", async () => {
  const logsRoot = await mkdtemp(join(tmpdir(), "maibot-log-controls-"));
  const logs = new LogStore({ logsRoot } as RuntimePaths);
  const history = new PtyOutputHistory();
  const raw = "\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[38;5;117m\x1b[H"
    + "正在启动 MaiBot\x1b]0;C:\\MaiBot\\python.exe\x07\x1b[?25h\x1b[m\r\n";
  try {
    history.append(raw, 100, 32);
    let emitted = "";
    logs.onEntry((entry) => { emitted = entry.message; });
    logs.append("maibot", "stdout", raw);
    expect(logs.list()[0].message).toBe("正在启动 MaiBot");
    expect(emitted).toBe("正在启动 MaiBot");
    expect(history.snapshot(100, 32, 1).chunks[0].data).toBe(raw);
    await (logs as any).writeQueue;
    const saved = await readFile(logs.getServiceLogPath("maibot"), "utf8");
    expect(saved).toContain("[stdout] 正在启动 MaiBot\n");
    expect(saved).not.toContain("\x1b");
    expect(saved).not.toContain("python.exe");
  } finally {
    await (logs as any).writeQueue;
    await rm(logsRoot, { recursive: true, force: true });
  }
});
