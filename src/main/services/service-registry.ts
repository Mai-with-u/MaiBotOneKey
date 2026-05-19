import type { ServiceDescriptor } from "../../shared/contracts";

const defaultServices: ServiceDescriptor[] = [
  {
    id: "maibot",
    name: "MaiBot Core",
    port: 8001,
    ports: [8001],
    url: "http://127.0.0.1:8001",
    status: "stopped",
    health: "unknown",
    managed: false,
    desired: false,
    detail: "等待初始化向导接入启动流程",
  },
  {
    id: "napcat",
    name: "NapCat",
    port: 6099,
    ports: [6099],
    url: "http://127.0.0.1:6099/webui",
    status: "stopped",
    health: "unknown",
    managed: false,
    desired: false,
    detail: "仅负责启动并提供 WebUI 快捷入口",
  },
];

export function createServiceSnapshot(): ServiceDescriptor[] {
  return defaultServices.map((service) => ({ ...service }));
}
