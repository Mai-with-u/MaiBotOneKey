import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

// WebUI credentials are independent of OneBot websocket accessToken.
export class SnowLumaWebuiAuth {
  private initialPassword?: string;
  private verifiedKey?: string;
  private verifiedPassword?: string;

  constructor(private readonly root: string, private readonly userDataRoot: string) {}

  private get credentialPath(): string {
    return join(this.userDataRoot, "snowluma-webui-credential.json");
  }

  async savePassword(password: string): Promise<void> {
    if (typeof password !== "string" || password.length < 10 || !/[a-z]/u.test(password)
      || !/[A-Z]/u.test(password) || !/[^A-Za-z0-9\s]/u.test(password) || /\s/u.test(password)) {
      throw new Error("密码须至少 10 位，包含大小写字母和特殊符号，且不能包含空白字符。");
    }
    const configPath = join(this.root, "config", "webui.json");
    const readOptional = async (path: string) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    const configText = await readOptional(configPath);
    const config = configText === undefined ? {} : JSON.parse(configText);
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("SnowLuma WebUI 配置格式错误。");
    const previousCredential = await readOptional(this.credentialPath);
    const salt = randomBytes(16);
    const now = new Date().toISOString();
    const state = {
      passwordHash: scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex"),
      passwordSalt: salt.toString("hex"),
      mustChangePassword: false,
      generatedAt: typeof config.generatedAt === "string" && Number.isFinite(Date.parse(config.generatedAt)) ? config.generatedAt : now,
      updatedAt: now,
      ...(config.totp !== undefined ? { totp: config.totp } : {}),
    };
    const replaceFile = async (path: string, content: string) => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    };
    // Write the remembered credential first; restore it if config replacement fails.
    await replaceFile(this.credentialPath, JSON.stringify({ password }));
    try {
      await replaceFile(configPath, JSON.stringify(state, null, 2));
    } catch (error) {
      if (previousCredential === undefined) await rm(this.credentialPath, { force: true });
      else await replaceFile(this.credentialPath, previousCredential);
      throw error;
    }
    this.initialPassword = undefined;
    this.verifiedKey = undefined;
    this.verifiedPassword = undefined;
  }

  async prepareEnvironment(): Promise<Record<string, string>> {
    this.initialPassword = undefined;
    try {
      await readFile(join(this.root, "config", "webui.json"), "utf8");
      return {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return {};
    }
    // Let SnowLuma create its own hash/config using its supported bootstrap API.
    const password = randomBytes(24).toString("base64url");
    await mkdir(dirname(this.credentialPath), { recursive: true });
    await writeFile(this.credentialPath, JSON.stringify({ password }), { mode: 0o600 });
    return { SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD: password };
  }

  captureOutput(line: string): void {
    const clean = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
    const match = /\[WebUI\].*initial credentials: user=admin password=(\S+)/u.exec(clean);
    if (match) this.initialPassword = match[1];
  }

  async resolveUrl(fallback: string): Promise<string> {
    try {
      const url = new URL(fallback);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return fallback;
      const config = JSON.parse(await readFile(join(this.root, "config", "webui.json"), "utf8"));
      let password: string | undefined;
      if (typeof config.passwordHash === "string") {
        if (!/^[a-f0-9]{128}$/iu.test(config.passwordHash) || !/^[a-f0-9]{32}$/iu.test(config.passwordSalt)) return fallback;
        const saved = await readFile(this.credentialPath, "utf8").then((text) => JSON.parse(text)).catch(() => ({}));
        const candidate = this.initialPassword ?? saved.password;
        if (typeof candidate !== "string" || !candidate) return fallback;
        const key = JSON.stringify([candidate, config.passwordHash, config.passwordSalt]);
        if (key !== this.verifiedKey) {
          const hash = scryptSync(candidate, Buffer.from(config.passwordSalt, "hex"), 64, { N: 16384, r: 8, p: 1 });
          this.verifiedPassword = timingSafeEqual(hash, Buffer.from(config.passwordHash, "hex")) ? candidate : undefined;
          this.verifiedKey = key;
        }
        password = this.verifiedPassword;
      } else if (typeof config.token === "string") {
        password = config.token;
      }
      if (!password) return fallback;
      url.searchParams.set("token", password);
      return url.toString();
    } catch {
      return fallback;
    }
  }
}
