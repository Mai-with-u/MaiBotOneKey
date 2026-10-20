import { expect, test } from "bun:test";
import { explainMaiBotUpdateError, maiBotUpdateErrorSummary } from "../../src/shared/maibot-update-error";

for (const [raw, reason] of [
  ["Python command timed out after 600s", "超时"],
  ["ReadTimeoutError: HTTPSConnectionPool", "超时"],
  ["EPERM: unlink python.exe", "文件可能被占用"],
  ["ERROR: ResolutionImpossible", "依赖版本互相冲突"],
  ["No matching distribution found for example==2", "找不到符合要求"],
  ["OSError: [Errno 28] No space left on device", "空间不足"],
  ["ProxyError: Connection refused", "连接 Python 包源失败"],
  ["unexpected installer exit", "暂时无法确定"],
  ["Python dependency install was cancelled", "更新已取消"],
]) {
  test(`update window explains ${raw}`, () => {
    const message = explainMaiBotUpdateError(raw, "正在安装依赖");
    expect(message).toContain("失败步骤：正在安装依赖");
    expect(message).toContain(reason);
    expect(message).toContain("处理方法：");
  });
}

test("IPC error summaries hide transport boilerplate and keep raw details separate", () => {
  expect(maiBotUpdateErrorSummary("Error invoking remote method 'modules:updateMaibot': Error: 失败步骤：正在安装依赖。\n原因：下载超时。\n\n技术详情：Traceback"))
    .toBe("失败步骤：正在安装依赖。\n原因：下载超时。");
});
