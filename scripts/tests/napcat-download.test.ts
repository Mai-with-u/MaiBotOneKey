import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InitManager } from "../../src/main/services/init-manager";
import { runProcess } from "../../src/main/services/runtime-file-utils";
import type { RuntimePaths } from "../../src/shared/contracts";

const runtimeRoot = resolve("runtime");
const python = join(runtimeRoot, "python", "python.exe");
const releaseUrl = "https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest";
const assetName = "NapCat.Shell.Windows.Node.zip";
const downloadUrl = `https://github.com/NapNeko/NapCatQQ/releases/download/v4.0.0/${assetName}`;

test.skipIf(process.platform !== "win32" || !existsSync(python))(
  "explicit NapCat setup verifies the archive before configuring QQ and reuses installed files",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "onekey-napcat-test-"));
    const originalFetch = globalThis.fetch;
    try {
      const paths = {
        runtimeRoot,
        bundledModulesRoot: join(root, "bundled"),
        napcatRoot: join(root, "napcat"),
        snowlumaRoot: join(root, "snowluma"),
        maibotRoot: join(root, "maibot"),
        logsRoot: join(root, "logs"),
        userDataRoot: join(root, "settings"),
        maibotDevMode: "source",
      } as RuntimePaths;
      await mkdir(join(paths.bundledModulesRoot, "SnowLuma"), { recursive: true });
      const config = join(paths.napcatRoot, "napcat", "config");
      await mkdir(config, { recursive: true });
      await writeFile(join(config, "napcat.json"), '{"keep":true}');
      const zip = join(root, "fixture.zip");
      await runProcess(python, ["-I", "-c", [
        "import sys, zipfile",
        "with zipfile.ZipFile(sys.argv[1], 'w') as archive:",
        "    for path in ('node.exe', 'index.js', 'config.json', 'napcat/package.json', 'napcat/config/napcat.json'):",
        "        archive.writestr(path, '{}')",
      ].join("\n"), zip], root);
      const archive = await readFile(zip);
      const hash = createHash("sha256").update(archive).digest("hex");
      const requests: string[] = [];
      let digest = "0".repeat(64);
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url === releaseUrl) return Response.json({
          tag_name: "v4.0.0",
          assets: [{ name: assetName, size: archive.length, digest: `sha256:${digest}` }],
        });
        if (url === downloadUrl) return new Response(archive);
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch;

      const manager = new InitManager(paths);
      const account = "123456789";
      expect((await manager.getState({ refreshDependencies: false })).napCatDownloadRequired).toBe(true);
      expect(requests).toEqual([]);
      await expect(manager.setQqAccount(account, "test-token", "napcat")).rejects.toThrow("校验失败");
      expect(manager.getQqBackendSync()).toBe("snowluma");
      expect(manager.getMessagePlatformQqAccount("napcat")).toBeUndefined();
      expect(existsSync(join(paths.napcatRoot, "node.exe"))).toBe(false);

      digest = hash;
      const state = await manager.setQqAccount(account, "test-token", "napcat");
      expect(state.napCatDownloadRequired).toBe(false);
      expect(state.qqAccount).toBe(account);
      expect(await manager.readNapcatWebsocketToken(account)).toBe("test-token");
      expect(await readFile(join(config, "napcat.json"), "utf8")).toBe('{"keep":true}');

      await manager.setQqBackend("napcat");
      expect(requests).toEqual([releaseUrl, downloadUrl, releaseUrl, downloadUrl]);

      const legacyRoot = join(root, "legacy-napcat");
      await mkdir(join(legacyRoot, "versions"), { recursive: true });
      await writeFile(join(legacyRoot, "NapCatWinBootMain.exe"), "legacy");
      const legacy = new InitManager({ ...paths, napcatRoot: legacyRoot });
      await legacy.setQqBackend("napcat");
      expect(requests).toHaveLength(4);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  },
);
