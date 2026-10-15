import type { MaiBotModuleUpdateProgress, ModuleTagOption, ModuleUpdateTarget, ModuleUpdateResult, RuntimePaths } from "../../shared/contracts";
import type { MaiBotDeploymentManager } from "./maibot-deployment-manager";

/** Core updates only install published packages; source checkouts are never changed. */
export class ModuleUpdater {
  private deploymentManager?: MaiBotDeploymentManager;
  constructor(private readonly paths: RuntimePaths) {}
  setDeploymentManager(manager: MaiBotDeploymentManager): void { this.deploymentManager = manager; }
  isPackageMode(): boolean { return this.deploymentManager?.isPackageMode() ?? false; }
  async listMaiBotPackageVersions() {
    if (!this.deploymentManager) throw new Error("MaiBot 部署管理器未初始化");
    return this.deploymentManager.getPython().listMaiBotVersions();
  }
  async listMaiBotTags(): Promise<ModuleTagOption[]> {
    const packages = await this.listMaiBotPackageVersions();
    return packages.versions.map((item) => ({ name: item.version, isPrerelease: item.isPrerelease }));
  }
  async rollbackMaiBot(): Promise<void> {
    if (!this.deploymentManager) throw new Error("MaiBot 部署管理器未初始化");
    await this.deploymentManager.rollback();
  }
  async updateMaiBot(target?: ModuleUpdateTarget, onProgress?: (progress: MaiBotModuleUpdateProgress) => void): Promise<ModuleUpdateResult> {
    if (this.paths.maibotDevMode === "source") throw new Error("源码调试模式请在源码仓库中修改或更新代码；测试包版本请使用 bun run dev:pypi");
    // Validate at runtime as old renderer/IPC callers may still submit Git targets.
    if (!target || target.type !== "package" || typeof target.name !== "string" || !target.name.trim()) {
      throw new Error("Core 已停止支持 Git 升级，请选择 PyPI 包版本；旧源码实例可迁移到 PyPI");
    }
    if (!this.deploymentManager) throw new Error("MaiBot 部署管理器未初始化");
    return this.deploymentManager.install(target.name.trim(), onProgress);
  }
}
