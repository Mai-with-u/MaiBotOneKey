import { afterEach, expect, test } from "bun:test";
import { scryptSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnowLumaWebuiAuth } from "../../../src/main/services/snowluma-webui-auth";

const roots: string[] = [];
const fallback = "http://127.0.0.1:5099/";
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "snowluma-webui-auth-"));
  roots.push(root);
  const data = join(root, "launcher");
  await mkdir(join(root, "config"));
  const configPath = join(root, "config", "webui.json");
  const writeConfig = (config: unknown) => writeFile(configPath, JSON.stringify(config));
  const writePassword = (password: string) => {
    const salt = Buffer.alloc(16, 42);
    return writeConfig({
      passwordSalt: salt.toString("hex"),
      passwordHash: scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex"),
      mustChangePassword: false,
    });
  };
  return { root, data, auth: new SnowLumaWebuiAuth(root, data), configPath, writeConfig, writePassword };
}

test("fresh bootstrap survives launcher restart and stops supplying a changed password", async () => {
  const f = await fixture();
  const env = await f.auth.prepareEnvironment();
  const password = env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD;
  expect(password.length).toBeGreaterThanOrEqual(32);
  await f.writePassword(password);
  expect(new URL(await f.auth.resolveUrl(fallback)).searchParams.get("token")).toBe(password);
  const restarted = new SnowLumaWebuiAuth(f.root, f.data);
  expect(await restarted.prepareEnvironment()).toEqual({});
  expect(new URL(await restarted.resolveUrl(fallback)).searchParams.get("token")).toBe(password);
  await f.writePassword("user-changed-password");
  expect(await restarted.resolveUrl(fallback)).toBe(fallback);
});

test("captures current initial password from ANSI logs without replacing existing configuration", async () => {
  const f = await fixture();
  await f.writePassword("initial-password");
  const original = await readFile(f.configPath, "utf8");
  expect(await f.auth.prepareEnvironment()).toEqual({});
  expect(await f.auth.resolveUrl(fallback)).toBe(fallback);
  f.auth.captureOutput("12:00 INFO \x1b[32m[WebUI]\x1b[0m initial credentials: user=admin password=initial-password");
  expect(new URL(await f.auth.resolveUrl(fallback)).searchParams.get("token")).toBe("initial-password");
  expect(await readFile(f.configPath, "utf8")).toBe(original);
  await f.auth.prepareEnvironment();
  expect(await f.auth.resolveUrl(fallback)).toBe(fallback);
});

test("legacy WebUI token is encoded and never taken from OneBot or sent to a remote origin", async () => {
  const f = await fixture();
  await f.writeConfig({ token: "test+/=?#&" });
  const result = new URL(await f.auth.resolveUrl(`${fallback}?existing=1`));
  expect(result.searchParams.get("token")).toBe("test+/=?#&");
  expect(result.searchParams.get("existing")).toBe("1");
  expect(await f.auth.resolveUrl("http://example.com:5099/")).toBe("http://example.com:5099/");
  await f.writeConfig({ accessToken: "onebot-token" });
  expect(await f.auth.resolveUrl(fallback)).toBe(fallback);
});

test("missing, malformed or unknown credentials fall back without overwriting them", async () => {
  const f = await fixture();
  expect(await f.auth.resolveUrl(fallback)).toBe(fallback);
  await writeFile(f.configPath, "invalid json");
  expect(await f.auth.prepareEnvironment()).toEqual({});
  expect(await f.auth.resolveUrl(fallback)).toBe(fallback);
  expect(await readFile(f.configPath, "utf8")).toBe("invalid json");
});

test("manual save updates both password files, preserves TOTP and restores automatic login after restart", async () => {
  const f = await fixture();
  await f.writePassword("OldPassword!");
  const previous = JSON.parse(await readFile(f.configPath, "utf8"));
  const totp = { enabled: true, secret: "fixture-secret" };
  await f.writeConfig({ ...previous, generatedAt: "2026-01-01T00:00:00.000Z", totp });
  f.auth.captureOutput("[WebUI] initial credentials: user=admin password=OldPassword!");
  await f.auth.savePassword("NewPassword!");
  const config = JSON.parse(await readFile(f.configPath, "utf8"));
  const saved = JSON.parse(await readFile(join(f.data, "snowluma-webui-credential.json"), "utf8"));
  expect(saved.password).toBe("NewPassword!");
  expect(config.totp).toEqual(totp);
  expect(config.generatedAt).toBe("2026-01-01T00:00:00.000Z");
  expect(config.mustChangePassword).toBe(false);
  expect(config.passwordSalt).not.toBe(previous.passwordSalt);
  const hash = scryptSync(saved.password, Buffer.from(config.passwordSalt, "hex"), 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  expect(hash).toBe(config.passwordHash);
  expect(new URL(await f.auth.resolveUrl(fallback)).searchParams.get("token")).toBe(saved.password);
  const restarted = new SnowLumaWebuiAuth(f.root, f.data);
  expect(await restarted.prepareEnvironment()).toEqual({});
  expect(new URL(await restarted.resolveUrl(fallback)).searchParams.get("token")).toBe(saved.password);
});

test("manual save creates valid auth state without needing an old password", async () => {
  const f = await fixture();
  await f.auth.savePassword("FreshPassword!");
  const config = JSON.parse(await readFile(f.configPath, "utf8"));
  expect(config.passwordHash).toMatch(/^[a-f0-9]{128}$/u);
  expect(config.passwordSalt).toMatch(/^[a-f0-9]{32}$/u);
  expect(Number.isFinite(Date.parse(config.generatedAt))).toBe(true);
  expect(Number.isFinite(Date.parse(config.updatedAt))).toBe(true);
  expect(new URL(await f.auth.resolveUrl(fallback)).searchParams.get("token")).toBe("FreshPassword!");
});

test("invalid passwords and invalid existing config never change either file", async () => {
  const f = await fixture();
  await f.auth.savePassword("OriginalPassword!");
  const beforeConfig = await readFile(f.configPath, "utf8");
  const beforeCredential = await readFile(join(f.data, "snowluma-webui-credential.json"), "utf8");
  for (const password of ["", "Short!A", "alllowercase!", "ALLUPPERCASE!", "NoSpecial123", "Has Space!A"]) {
    await expect(f.auth.savePassword(password)).rejects.toThrow("密码须至少");
  }
  expect(await readFile(f.configPath, "utf8")).toBe(beforeConfig);
  expect(await readFile(join(f.data, "snowluma-webui-credential.json"), "utf8")).toBe(beforeCredential);
  await writeFile(f.configPath, "not JSON");
  await expect(f.auth.savePassword("AnotherPassword!")).rejects.toThrow();
  expect(await readFile(f.configPath, "utf8")).toBe("not JSON");
  expect(await readFile(join(f.data, "snowluma-webui-credential.json"), "utf8")).toBe(beforeCredential);
});
