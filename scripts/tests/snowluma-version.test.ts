import { expect, test } from "bun:test";
import { isSnowLumaUpgradeAvailable } from "../../src/shared/snowluma-version";

test("SnowLuma upgrade compares numeric versions and prereleases without suggesting downgrades", () => {
  expect(isSnowLumaUpgradeAvailable("1.14.22", "2.0.3")).toBe(true);
  expect(isSnowLumaUpgradeAvailable("2.0.9", "2.0.10")).toBe(true);
  expect(isSnowLumaUpgradeAvailable("v2.0.3", "2.0.3+build")).toBe(false);
  expect(isSnowLumaUpgradeAvailable("2.0.4", "2.0.3")).toBe(false);
  expect(isSnowLumaUpgradeAvailable("2.0.3-dev.9", "2.0.3-dev.10")).toBe(true);
  expect(isSnowLumaUpgradeAvailable("2.0.3-dev.10", "2.0.3")).toBe(true);
  expect(isSnowLumaUpgradeAvailable("2.0.3", "2.0.3-dev.10")).toBe(false);
  expect(isSnowLumaUpgradeAvailable(undefined, "2.0.3")).toBe(false);
  expect(isSnowLumaUpgradeAvailable("2.0.3", "unknown")).toBe(false);
});
