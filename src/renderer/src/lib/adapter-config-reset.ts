import type { QqBackend } from "@shared/contracts";

const ADAPTER_CONFIG_PARSE_MARKER = "ADAPTER_CONFIG_PARSE_FAILED::";

export interface AdapterConfigResetRequest {
  backend: QqBackend;
  configPath: string;
  detail: string;
}

export function adapterBackendLabel(backend: QqBackend): string {
  return backend === "snowluma" ? "SnowLuma 适配器" : "NapCat 适配器";
}

export function adapterConfigResetRequestFromError(error: unknown): AdapterConfigResetRequest | null {
  const message = error instanceof Error ? error.message : String(error);
  const markerIndex = message.indexOf(ADAPTER_CONFIG_PARSE_MARKER);
  if (markerIndex < 0) {
    return null;
  }

  const payload = message.slice(markerIndex + ADAPTER_CONFIG_PARSE_MARKER.length);
  const [backend, configPath, ...detailParts] = payload.split("::");
  if (backend !== "napcat" && backend !== "snowluma") {
    return null;
  }

  return {
    backend,
    configPath: configPath || "config.toml",
    detail: detailParts.join("::") || "配置文件格式无法解析",
  };
}
