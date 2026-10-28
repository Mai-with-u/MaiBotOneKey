import { expect, test } from "bun:test";
import { LauncherAutoStart, readOpenAtLogin, saveOpenAtLogin } from "../../src/main/services/launcher-startup";
import { defaultServiceStartupSettings } from "../../src/main/services/service-startup-defaults";

const ready = () => ({
  serviceStartupSettings: { useLocalDashboard: false, autoStartServices: true },
  initState: { isReady: true, messagePlatformConfigured: true, qqProtocol: "snowluma" },
  startupAgreement: { isConfirmed: true },
  services: [], runtimeOperation: undefined,
}) as any;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("auto-start waits for initialization, agreement, QQ configuration and resource operations, then runs once", async () => {
  let starts = 0;
  const controller = new LauncherAutoStart(true, async () => { starts++; }, (error) => { throw error; });
  for (const patch of [
    { initState: { ...ready().initState, isReady: false } },
    { startupAgreement: { isConfirmed: false } },
    { initState: { ...ready().initState, messagePlatformConfigured: false } },
    { runtimeOperation: "迁移目录" },
  ]) controller.consider({ ...ready(), ...patch });
  await flush();
  expect(starts).toBe(0);
  controller.consider(ready());
  controller.consider(ready());
  await flush();
  expect(starts).toBe(1);
  // Stopping later in this session must not trigger another start.
  controller.consider(ready());
  await flush();
  expect(starts).toBe(1);
});

test("disabled sessions, disabling while waiting, and manual service actions never auto-start later", async () => {
  let starts = 0;
  for (const scenario of ["disabled-at-launch", "disabled-while-waiting", "manual", "already-running"]) {
    const controller = new LauncherAutoStart(scenario !== "disabled-at-launch", async () => { starts++; }, () => {});
    if (scenario === "disabled-while-waiting") controller.consider({ ...ready(), serviceStartupSettings: { autoStartServices: false } });
    if (scenario === "manual") controller.cancel();
    if (scenario === "already-running") controller.consider({ ...ready(), services: [{ status: "starting" }] });
    controller.consider(ready());
  }
  await flush();
  expect(starts).toBe(0);
  expect(defaultServiceStartupSettings().autoStartServices).toBe(false);
});

test("official QQ waits for credentials and startup failure is reported once without retries", async () => {
  let starts = 0;
  const failures: unknown[] = [];
  const failure = new Error("端口占用");
  const controller = new LauncherAutoStart(true, async () => { starts++; throw failure; }, (error) => failures.push(error));
  const snapshot = ready();
  snapshot.initState = { ...snapshot.initState, qqProtocol: "official", messagePlatformConfigured: false, qqOfficialConfigured: false };
  controller.consider(snapshot);
  await flush();
  expect(starts).toBe(0);
  snapshot.initState.qqOfficialConfigured = true;
  controller.consider(snapshot);
  await flush();
  controller.consider(snapshot);
  await flush();
  expect(starts).toBe(1);
  expect(failures).toEqual([failure]);
});

test("login startup uses installed executable, reflects OS state, and never registers a development build", () => {
  const calls: unknown[] = [];
  let state = false;
  let blocked = false;
  const app = {
    isPackaged: true,
    getLoginItemSettings: () => ({ openAtLogin: state, executableWillLaunchAtLogin: !blocked }),
    setLoginItemSettings: (options: { openAtLogin: boolean; path: string }) => { calls.push(options); state = options.openAtLogin; },
  };
  expect(readOpenAtLogin(app, "win32")).toBe(false);
  saveOpenAtLogin(app, true, "win32");
  expect(readOpenAtLogin(app, "win32")).toBe(true);
  expect(calls).toEqual([{ openAtLogin: true, path: process.execPath }]);
  blocked = true;
  expect(readOpenAtLogin(app, "win32")).toBe(false);
  expect(() => saveOpenAtLogin(app, true, "win32")).toThrow("系统未应用");
  blocked = false;
  saveOpenAtLogin(app, false, "win32");
  expect(readOpenAtLogin(app, "win32")).toBe(false);
  app.isPackaged = false;
  const count = calls.length;
  expect(readOpenAtLogin(app, "win32")).toBeUndefined();
  expect(() => saveOpenAtLogin(app, true, "win32")).toThrow("正式安装版");
  saveOpenAtLogin(app, false, "win32");
  expect(calls).toHaveLength(count);
});
