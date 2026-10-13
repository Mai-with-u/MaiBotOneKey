import type { InitState, QqProtocol, QqProtocolOptions } from "@shared/contracts";

export async function saveQqProtocol(protocol: QqProtocol, options?: QqProtocolOptions): Promise<InitState> {
  const bridge = window.maibotDesktop;
  if (typeof bridge?.adapters?.setQqProtocol !== "function") {
    throw new Error("当前窗口仍使用旧版桌面接口，请完全退出启动器后重新打开；开发模式请停止并重新运行 bun run dev。刷新页面无法更新此接口。");
  }
  return bridge.adapters.setQqProtocol(protocol, options);
}
