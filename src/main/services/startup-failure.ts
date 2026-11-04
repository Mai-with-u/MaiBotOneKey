import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function describeStartupFailure(error: unknown): { title: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const failure = error as NodeJS.ErrnoException | null | undefined;
  if (failure?.code !== "EPERM" && failure?.code !== "EACCES") {
    return { title: "MaiBot OneKey 启动失败", message };
  }
  const path = typeof failure.path === "string" ? `\n无法访问的位置：\n${failure.path}\n` : "";
  return {
    title: "MaiBot OneKey 无法访问所需文件或目录",
    message: [
      "系统拒绝了启动器访问所需文件或目录。为避免配置写入失败，启动已停止。",
      path,
      "可能原因：当前账户缺少访问权限、安全软件拦截，或文件被其他进程占用。仅凭此错误无法确定具体原因。",
      "建议按顺序尝试：",
      "1. 关闭其他 MaiBot OneKey 启动器，在任务管理器中确认没有残留启动器进程，再重新打开。",
      "2. 检查 Windows 安全中心或其他安全软件的拦截记录，确认是否阻止了启动器访问上述位置。",
      "3. 在该文件或目录的“属性 → 安全”中，确认当前账户具有所需的读取、写入和修改权限。",
      "4. 可临时尝试“以管理员身份运行”辅助排查；若这样可以启动，请修复权限后恢复普通方式运行。",
      "请勿直接删除配置目录或实例数据。处理后重新打开启动器即可重试。",
      `\n技术详情：${message}`,
    ].filter(Boolean).join("\n\n"),
  };
}

/** Logging must never hide the original failure, including when the profile is inaccessible. */
export function writeStartupFailureLog(error: unknown, roots: string[]): string {
  const details = error instanceof Error ? error.stack ?? error.message : String(error);
  const failures: string[] = [];
  for (const root of new Set(roots)) {
    try {
      mkdirSync(root, { recursive: true });
      const path = join(root, "desktop.log");
      appendFileSync(path, `[${new Date().toISOString()}] [system] 启动失败: ${details}\n${failures.join("\n")}\n`);
      return `${failures.length ? "常规日志不可写，诊断日志已保存到备用位置" : "诊断日志"}：${path}`;
    } catch (logError) {
      failures.push(`日志写入失败（${root}）：${String(logError)}`);
    }
  }
  return `诊断日志无法保存，可截图保留此提示。\n${failures.join("\n")}`;
}
