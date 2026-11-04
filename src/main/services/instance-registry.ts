import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isLockOwnerAlive } from "./lock-owner";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LauncherInstance, LauncherInstanceState, InstanceCreateRequest, RuntimeResourcePathKey } from "../../shared/contracts";
import { readStoredResourcePaths } from "./runtime-resource-paths";
import { ensureSharedProtocols, readSharedProtocols } from "./shared-protocols";

const keys: RuntimeResourcePathKey[] = ["maibot", "napcat", "snowluma"];
export function instancePath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  return dirname(absolute) === absolute ? absolute : join(instancePath(dirname(absolute)), basename(absolute));
}
function overlaps(a: string, b: string): boolean {
  const normalize = (p: string) => process.platform === "win32" ? instancePath(p).toLowerCase() : instancePath(p);
  const inside = (parent: string, child: string) => { const diff = relative(parent, child); return !diff || (!isAbsolute(diff) && diff !== ".." && !diff.startsWith(`..${sep}`)); };
  return inside(normalize(a), normalize(b)) || inside(normalize(b), normalize(a));
}
export function componentDefaults(root: string): LauncherInstance["paths"] {
  return { maibot: join(root, "modules", "MaiBot"), napcat: join(root, "modules", "napcat"), snowluma: join(root, "modules", "SnowLuma") };
}
export function readInstallerInstanceRoot(installRoot: string): string | undefined {
  const file = join(installRoot, "instance-location.ini");
  return existsSync(file) ? readFileSync(file, "utf16le").replace(/^\uFEFF/u, "").match(/^root=(.*)$/mu)?.[1]?.trim() || undefined : undefined;
}

/** The index owns metadata only. Component files are never deleted by this class. */
export class InstanceRegistry {
  constructor(readonly root: string) {}
  private get file(): string { return join(this.root, "instances.json"); }
  read(): LauncherInstanceState {
    const data = JSON.parse(readFileSync(this.file, "utf8")) as LauncherInstanceState;
    if (data.version !== 1 || !Array.isArray(data.instances) || !data.instances.length || !data.instances.some(i => i.id === data.activeId)) throw new Error("实例索引损坏，请恢复 instances.json 后重试。");
    const ids = new Set<string>();
    const protocols = readSharedProtocols(this.root);
    for (const item of data.instances) {
      if (item?.paths && protocols) item.paths = { ...item.paths, ...protocols.paths };
      if (!item || typeof item.id !== "string" || ids.has(item.id) || typeof item.name !== "string" || !isAbsolute(item.settingsRoot) || !isAbsolute(item.resourceRoot) || keys.some(key => typeof item.paths?.[key] !== "string" || !isAbsolute(item.paths[key]))) throw new Error("实例索引包含无效或重复记录。");
      ids.add(item.id);
    }
    return data;
  }
  private write(data: LauncherInstanceState): void {
    mkdirSync(this.root, { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const stored = readSharedProtocols(this.root) ? { ...data, instances: data.instances.map(item => ({ ...item, paths: { maibot: item.paths.maibot } })) } : data;
    try { writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, { flag: "wx" }); renameSync(temp, this.file); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  private mutate<T>(action: () => T): T {
    mkdirSync(this.root, { recursive: true });
    const lock = join(this.root, "registry-write.lock");
    // Synchronous, short-lived guard: never overwrite another launcher's index.
    const acquire = () => writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: "wx" });
    try { acquire(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: number; startedAt?: number } | undefined;
      try { owner = JSON.parse(readFileSync(lock, "utf8")); } catch { /* An in-flight writer may not have flushed yet. */ }
      if (!owner?.pid || owner.pid === process.pid || isLockOwnerAlive(owner)) throw new Error("实例索引正被其他启动器修改，请稍后重试。");
      unlinkSync(lock); acquire();
    }
    try { return action(); } finally { unlinkSync(lock); }
  }
  initialize(legacyRoot: string, legacyResourceRoot: string, seedRoot?: string, scanLegacy = false, protectedRoots: string[] = []): LauncherInstanceState {
    return this.mutate(() => {
      const data: LauncherInstanceState = existsSync(this.file) ? this.read() : { version: 1, activeId: "", instances: [] };
      const candidates = new Set([legacyRoot]);
      if (scanLegacy && existsSync(dirname(legacyRoot))) for (const entry of readdirSync(dirname(legacyRoot), { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-f0-9]{12}$/u.test(entry.name)) candidates.add(join(dirname(legacyRoot), entry.name));
      }
      for (const candidate of candidates) {
        if (!existsSync(candidate) || !readdirSync(candidate).some(name => name !== "instance-registry")) continue;
        if (data.ignoredLegacyRoots?.includes(candidate) || data.instances.some(i => resolve(i.settingsRoot) === resolve(candidate) || resolve(i.resourceRoot) === resolve(candidate))) continue;
        const root = candidate === legacyRoot ? legacyResourceRoot : candidate;
        const item: LauncherInstance = { id: randomUUID(), name: candidate === legacyRoot ? "原有实例" : `旧实例 ${candidate.split(sep).pop()}`, settingsRoot: candidate, resourceRoot: root, paths: componentDefaults(root), legacy: true };
        // Validate old path files now; preserve them and their precedence verbatim.
        const stored = readStoredResourcePaths(candidate);
        // Other installation hashes can also belong to source development sessions.
        // Only discover those that actually have a component or a custom location.
        if (candidate !== legacyRoot && !Object.values(stored).some(Boolean) && !existsSync(item.paths.maibot)) continue;
        data.instances.push(item);
        if (!data.activeId) data.activeId = item.id;
      }
      if (!data.instances.length) {
        const id = randomUUID(), settingsRoot = join(this.root, "profiles", id);
        const resourceRoot = seedRoot?.trim() ? this.validPath(seedRoot) : legacyResourceRoot;
        const item: LauncherInstance = { id, name: "默认实例", settingsRoot, resourceRoot, paths: componentDefaults(resourceRoot) };
        if (seedRoot) {
          this.validatePaths(item.paths, [], [this.root, ...protectedRoots]);
          for (const path of Object.values(item.paths)) if (existsSync(path) && readdirSync(path).length) throw new Error("安装器指定的实例目录已有组件文件，请使用空目录，或在实例管理中接入已有实例。");
        }
        data.instances.push(item); data.activeId = id;
      }
      ensureSharedProtocols(this.root, data.instances.find(item => item.id === data.activeId)!);
      this.write(data); return this.read();
    });
  }
  effective(item: LauncherInstance): LauncherInstance["paths"] {
    const overrides = readStoredResourcePaths(item.settingsRoot);
    const effective = Object.fromEntries(keys.map(key => [key, key === "maibot" && item.development?.mode === "source" ? item.paths[key] : overrides[key] ?? item.paths[key]])) as LauncherInstance["paths"];
    return { ...effective, ...readSharedProtocols(this.root)?.paths };
  }
  initializeDevelopment(defaults: LauncherInstance[], preferredId?: string): LauncherInstanceState {
    return this.mutate(() => {
      const data: LauncherInstanceState = existsSync(this.file) ? this.read() : { version: 1, activeId: defaults[0].id, instances: [] };
      for (const item of defaults) {
        const existing = data.instances.find(entry => entry.id === item.id);
        if (!existing) data.instances.push(item);
        else if (preferredId === item.id) existing.development = item.development;
      }
      if (preferredId && data.instances.some(item => item.id === preferredId)) data.activeId = preferredId;
      ensureSharedProtocols(this.root, data.instances.find(item => item.id === data.activeId)!);
      this.write(data); return this.read();
    });
  }
  snapshot(): LauncherInstanceState {
    const data = this.read();
    return { ...data, instances: data.instances.map(item => ({ ...item, paths: this.effective(item) })) };
  }
  private validPath(value: string): string {
    if (typeof value !== "string" || !value.trim() || !isAbsolute(value.trim())) throw new Error("请为每个组件指定完整的绝对目录路径。");
    const path = instancePath(value.trim());
    if (dirname(path) === path) throw new Error("不能直接使用磁盘根目录。");
    return path;
  }
  validatePaths(paths: LauncherInstance["paths"], others: LauncherInstance[], protectedRoots: string[] = []): void {
    const values = keys.map(key => this.validPath(paths[key]));
    for (let index = 0; index < values.length; index++) {
      if (values.slice(index + 1).some(path => overlaps(path, values[index]))) throw new Error("组件目录不能相同或互相包含。");
      if (protectedRoots.some(path => overlaps(path, values[index]))) throw new Error("组件目录不能位于程序或启动器配置目录内，也不能包含它们。");
      if (others.some(item => overlaps(this.effective(item).maibot, values[index]))) throw new Error("目录已登记在其他实例中，不能重复使用或互相包含。");
    }
  }
  assertAvailable(paths: LauncherInstance["paths"], activeId: string, protectedRoots: string[]): void {
    this.validatePaths(paths, this.read().instances.filter(item => item.id !== activeId), protectedRoots);
  }
  create(request: InstanceCreateRequest, protectedRoots: string[]): LauncherInstanceState {
    return this.mutate(() => {
      if (!request || !["new", "existing"].includes(request.mode) || typeof request.name !== "string" || !request.name.trim() || request.name.length > 80) throw new Error("请输入 1–80 字的实例名称。");
      const data = this.read();
      const protocols = readSharedProtocols(this.root)!;
      const paths = { maibot: this.validPath(request.paths?.maibot), ...protocols.paths };
      this.validatePaths(paths, data.instances);
      if ([this.root, ...protectedRoots].some(path => overlaps(path, paths.maibot))) throw new Error("MaiBot 目录不能位于程序或启动器配置目录内，也不能包含它们。");
      if (request.mode === "new") {
        if (existsSync(paths.maibot) && readdirSync(paths.maibot).length) throw new Error("新实例需要空组件目录；接入已有文件请使用“接入已有实例”。");
      } else {
        const root = paths.maibot;
        if (!(existsSync(join(root, "bot.py")) && existsSync(join(root, "src"))) && !(existsSync(join(root, ".onekey-deployment.json")) && (existsSync(join(root, "host", "registry.sqlite3")) || (existsSync(join(root, "config", "bot_config.toml")) && existsSync(join(root, "config", "model_config.toml")))))) throw new Error("所选 MaiBot 目录不是有效的源码或已部署实例。");
      }
      const id = randomUUID(), settingsRoot = join(this.root, "profiles", id);
      data.instances.push({ id, name: request.name.trim(), settingsRoot, resourceRoot: settingsRoot, paths, attached: request.mode === "existing" });
      this.write(data); return this.snapshot();
    });
  }
  select(id: string): void {
    this.mutate(() => {
      const data = this.read(), item = data.instances.find(i => i.id === id);
      if (!item) throw new Error("实例不存在。");
      const paths = this.effective(item);
      if (item.development?.mode === "source" && (!existsSync(join(paths.maibot, "bot.py")) || !existsSync(join(paths.maibot, "src")) || !existsSync(join(paths.maibot, "pyproject.toml")) || existsSync(join(paths.maibot, ".onekey-deployment.json")))) {
        throw new Error("源码调试目录尚未准备好或已用于 PyPI 部署，请先运行 bun run dev:source:init，或使用独立的源码 checkout。");
      }
      for (const path of [item.settingsRoot, ...Object.values(paths)]) {
        let parent = path;
        while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
        accessSync(parent, constants.W_OK);
        for (const name of ["resource.lock", "instance.lock"]) {
          const file = join(path, name);
          if (existsSync(file) && isLockOwnerAlive(JSON.parse(readFileSync(file, "utf8")))) throw new Error(`目标实例正在被使用：${path}`);
        }
      }
      if ((item.legacy || item.attached) && !existsSync(paths.maibot)) throw new Error("已有 MaiBot 目录不可用，请检查磁盘或目录是否已移动。");
      data.activeId = id; this.write(data);
    });
  }
  rename(id: string, name: string): LauncherInstanceState {
    return this.mutate(() => { const data = this.read(), item = data.instances.find(i => i.id === id); if (!item || typeof name !== "string" || !name.trim() || name.length > 80) throw new Error("实例不存在或名称无效。"); item.name = name.trim(); this.write(data); return this.snapshot(); });
  }
  remove(id: string): LauncherInstanceState {
    if (this.read().instances.find(item => item.id === id)?.development) throw new Error("内置开发实例保留在列表中，不能移除。可重命名或切换到其他实例。");
    return this.mutate(() => { const data = this.read(); if (id === data.activeId) throw new Error("请先切换到其他实例，再移除此实例。"); const item = data.instances.find(i => i.id === id); if (item?.legacy) data.ignoredLegacyRoots = [...(data.ignoredLegacyRoots ?? []), item.settingsRoot]; data.instances = data.instances.filter(i => i.id !== id); this.write(data); return this.snapshot(); });
  }
}
