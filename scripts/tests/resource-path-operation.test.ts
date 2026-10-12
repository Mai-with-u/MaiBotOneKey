import { expect, test } from "bun:test";
import { isResourcePathCancellation, RESOURCE_PATH_CANCELLED_MESSAGE } from "../../src/shared/resource-path-operation";
test("only completed cancellation is presented as cancelled; rollback failures remain errors", () => {
  expect(isResourcePathCancellation(new Error(RESOURCE_PATH_CANCELLED_MESSAGE))).toBe(true);
  expect(isResourcePathCancellation(new Error(`Error invoking remote method: Error: ${RESOURCE_PATH_CANCELLED_MESSAGE}`))).toBe(true);
  expect(isResourcePathCancellation(new Error(`${RESOURCE_PATH_CANCELLED_MESSAGE}；目标文件回滚失败。已保留目标副本。`))).toBe(false);
});
