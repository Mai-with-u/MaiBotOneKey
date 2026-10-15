import { expect, test } from "bun:test";
import { publishedStableReleaseTags, resolveMaiBotUpdateTarget } from "../../src/shared/maibot-update-target";

test("stable updates pin the published package version and normalize legacy tags", () => {
  expect(resolveMaiBotUpdateTarget("stable", "v1.3.3", "v1.2.0"))
    .toEqual({ type: "package", name: "1.3.3" });
});

test("missing release metadata cannot fall back to main or a history tag", () => {
  expect(resolveMaiBotUpdateTarget("stable", undefined, "v1.3.3")).toBeUndefined();
});

test("historical versions only resolve to published package targets", () => {
  expect(resolveMaiBotUpdateTarget("other", "v1.3.3", "v1.2.0"))
    .toEqual({ type: "package", name: "1.2.0" });
  expect(resolveMaiBotUpdateTarget("other", "v1.3.3", undefined)).toBeUndefined();
});

test("drafts and prereleases cannot become the official release target", () => {
  expect(publishedStableReleaseTags([
    { tag_name: "v1.3.3", prerelease: false, draft: false },
    { tag_name: "v1.4.0", draft: true },
    { tag_name: "v1.5.0", prerelease: true },
    { tag_name: null },
    { tag_name: " " },
  ])).toEqual(["v1.3.3"]);
});
