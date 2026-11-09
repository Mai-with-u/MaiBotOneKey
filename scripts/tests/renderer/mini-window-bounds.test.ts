import { expect, test } from "bun:test";
import { getMiniWindowBounds } from "../../../src/main/mini-window-bounds";

test("mini window uses phone dimensions centered in the display work area", () => {
  expect(getMiniWindowBounds({ x: 0, y: 0, width: 1920, height: 1040 })).toEqual({
    x: 750, y: 100, width: 420, height: 840,
  });
});

test("mini window fits small and offset displays while keeping the phone ratio", () => {
  for (const workArea of [
    { x: -1280, y: 100, width: 1280, height: 680 },
    { x: 1920, y: -200, width: 300, height: 900 },
  ]) {
    const bounds = getMiniWindowBounds(workArea);
    expect(Math.abs(bounds.height - bounds.width * 2)).toBeLessThanOrEqual(1);
    expect(bounds.x).toBeGreaterThanOrEqual(workArea.x);
    expect(bounds.y).toBeGreaterThanOrEqual(workArea.y);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height);
  }
});
