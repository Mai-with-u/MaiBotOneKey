import { isWindowsLongPathError } from "./windows-long-path";

/** Translate evidence in installer errors without guessing an unknown cause. */
export function explainMaiBotUpdateError(detail: string, stage = "更新 MaiBot"): string {
  let reason: string;
  let action: string;
  if (isWindowsLongPathError(detail)) {
    reason = "安装文件路径超过 Windows 长度限制";
    action = "请在弹窗中开启长路径支持，重启电脑后重新安装。更换 Python 包源无法解决此问题。";
  } else if (/cancelled|canceled|AbortError|aborted/iu.test(detail)) {
    reason = "更新已取消";
    action = "需要时可以重新更新。";
  } else if (/timed?\s*out|timeout|ReadTimeout|ConnectTimeout/iu.test(detail)) {
    reason = "下载或安装依赖超时";
    action = "请检查网络，或在设置中切换 Python 包源后重试。";
  } else if (/ENOSPC|No space left|not enough space|磁盘空间不足/iu.test(detail)) {
    reason = "磁盘剩余空间不足";
    action = "请清理实例所在磁盘和系统临时目录所在磁盘的空间后重试。";
  } else if (/ResolutionImpossible|conflicting dependencies|dependency conflict/iu.test(detail)) {
    reason = "MaiBot 或插件需要的依赖版本互相冲突";
    action = "请展开技术详情，查看发生冲突的包和版本。";
  } else if (/No matching distribution|Could not find a version that satisfies/iu.test(detail)) {
    reason = "当前包源找不到符合要求的依赖版本";
    action = "请切换 Python 包源后重试；仍失败时请提供技术详情。";
  } else if (/EPERM|EACCES|PermissionError|Permission denied|Access is denied|WinError (?:5|32)/iu.test(detail)) {
    reason = "无法访问安装文件，文件可能被占用或访问被系统拒绝";
    action = "请停止该实例并退出其他使用此实例 Python 的程序后重试；仍失败时检查安全软件的拦截记录。";
  } else if (/ConnectionError|Connection refused|connection reset|Failed to establish|NameResolutionError|getaddrinfo|CERTIFICATE_VERIFY_FAILED|SSLError|ProxyError|Network is unreachable/iu.test(detail)) {
    reason = "连接 Python 包源失败";
    action = "请检查网络、代理和 Python 包源设置后重试。";
  } else {
    reason = "安装程序执行失败，暂时无法确定具体原因";
    action = "请展开技术详情，将完整错误提供给维护者。";
  }
  return `失败步骤：${stage}。\n原因：${reason}。\n处理方法：${action}`;
}

export function maiBotUpdateErrorSummary(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u, "")
    .split("\n\n技术详情：")[0];
}
