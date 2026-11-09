import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { READ_MAIBOT_CONTENT_SCRIPT, waitForWebviewContent } from "../../../src/renderer/src/lib/webview-readiness";

test("HTML shell and hidden root children do not count as a rendered WebUI", () => {
  const read = (children: unknown[] | undefined) => runInNewContext(READ_MAIBOT_CONTENT_SCRIPT, {
    document: { getElementById: () => children ? { children } : null },
    getComputedStyle: (element: { display: string }) => ({ display: element.display, visibility: "visible" }),
  });
  expect(read(undefined)).toBe(false);
  expect(read([])).toBe(false);
  expect(read([{ display: "none", getClientRects: () => [{}] }])).toBe(false);
  expect(read([{ display: "block", getClientRects: () => [] }])).toBe(false);
  expect(read([{ display: "block", getClientRects: () => [{}] }])).toBe(true);
});

test("readiness waits through document loading and a transient navigation failure", async () => {
  let attempts = 0;
  expect(await waitForWebviewContent(async () => {
    attempts += 1;
    if (attempts === 2) throw new Error("guest navigated");
    return attempts >= 3;
  }, new AbortController().signal, 1000, 1)).toBe(true);
  expect(attempts).toBe(3);
});

test("a hung guest request cannot leave the loading screen stuck indefinitely", async () => {
  expect(await waitForWebviewContent(() => new Promise(() => {}), new AbortController().signal, 10, 1)).toBe(false);
});

test("unmount cancels polling and discards a late successful guest result", async () => {
  const controller = new AbortController();
  let complete!: (ready: boolean) => void;
  let attempts = 0;
  const result = waitForWebviewContent(() => {
    attempts += 1;
    return new Promise<boolean>((resolve) => { complete = resolve; });
  }, controller.signal, 1000, 1);
  controller.abort();
  expect(await result).toBe(false);
  complete(true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(attempts).toBe(1);
});
