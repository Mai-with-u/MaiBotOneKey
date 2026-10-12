import { expect, test } from "bun:test";
import { normalizeQqAccount } from "../../src/shared/qq-account";
test("all account entry points share QQ account normalization", () => {
  expect(normalizeQqAccount(" 123456 ")).toBe("123456");
  for (const value of [undefined, null, "", " ", "0", "000", "abc", "12a", 123456]) expect(normalizeQqAccount(value)).toBeUndefined();
});
