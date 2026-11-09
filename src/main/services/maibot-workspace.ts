import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export interface WorkspaceBot { bot_id: string; name: string; directory: string }
const execute = promisify(execFile);

export async function saveWorkspaceWebUiPort(root: string, python: string, packaged: boolean, port: number): Promise<void> {
  const script = `
from dataclasses import replace
from pathlib import Path
import sys
import tomlkit
from src.common.process_lease import ProcessLease
from src.host.config import HostConfig, config_from_bot, save_host_config
from src.host.config_transaction import write_private

root, port = Path(sys.argv[1]), int(sys.argv[2])
path = root / "host" / "config.toml"
path.parent.mkdir(parents=True, exist_ok=True)
with ProcessLease(path.parent / "run.lock"):
    if path.exists():
        document = tomlkit.parse(path.read_text(encoding="utf-8"))
        document["webui"]["port"] = port
        write_private(path, tomlkit.dumps(document))
    else:
        legacy = root / "config" / "bot_config.toml"
        config = config_from_bot(legacy) if legacy.exists() else HostConfig()
        save_host_config(root, replace(config, port=port))
`;
  await execute(python, [...(packaged ? ["-I"] : []), "-X", "utf8", "-c", script, root, String(port)], {
    cwd: root, windowsHide: true, timeout: 10_000,
  });
}

/** Read only: listing must neither migrate a workspace nor require the host to be running. */
export async function readWorkspaceBots(root: string, python: string): Promise<WorkspaceBot[]> {
  const database = join(root, "host", "registry.sqlite3");
  if (!existsSync(database)) return [];
  const script = [
    "import json, pathlib, sqlite3, sys",
    "with sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri() + '?mode=ro', uri=True) as db:",
    " db.row_factory = sqlite3.Row",
    " bots = [dict(row) for row in db.execute('SELECT bot_id, name, directory FROM bots ORDER BY created_at, bot_id')]",
    " for bot in bots:",
    "  bot['directory'] = str((pathlib.Path(sys.argv[2]) / bot['directory']).resolve())",
    " print(json.dumps(bots))",
  ].join("\n");
  const { stdout } = await execute(python, ["-I", "-X", "utf8", "-c", script, database, root], { windowsHide: true, timeout: 10_000 });
  return JSON.parse(stdout);
}

/** Reuse Core's import transaction: shared settings are stripped and model names are remapped there. */
export async function importWorkspaceConfig(root: string, python: string, packaged: boolean, bot: WorkspaceBot, fileName: string, source: string): Promise<void> {
  const script = `
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import json, sys, zipfile
from src.common.process_lease import ProcessLease, instance_lock_path
from src.host.registry import Registry
from src.host.transfer_service import TransferService
from src.host.transfer_storage import import_archive
root, bot_id, name, source = Path(sys.argv[1]), sys.argv[2], sys.argv[3], Path(sys.argv[4])
with ProcessLease(root / 'host' / 'run.lock'):
    bot = Registry(root).get_bot(bot_id)
    with TemporaryDirectory() as temporary:
        archive = Path(temporary) / 'config.zip'
        with zipfile.ZipFile(archive, 'w') as output:
            output.writestr('manifest.json', json.dumps({'format':'maibot-data-archive','format_version':1}))
            output.write(source, 'config/' + name)
        service = TransferService(bot.directory, root / 'host' / 'transfers' / bot_id, '1.4.0')
        job = SimpleNamespace(manifest=None, processed_files=0, processed_bytes=0, checkpoint=lambda: None)
        with ProcessLease(instance_lock_path(bot.directory)):
            import_archive(bot, root / 'host', service, archive, {'config'}, job)
`;
  await execute(python, [...(packaged ? ["-I"] : []), "-X", "utf8", "-c", script, root, bot.bot_id, fileName, source], {
    cwd: root, windowsHide: true, timeout: 60_000,
    env: { ...process.env, MAIBOT_INSTANCE_DIR: root },
  });
}

export async function resetWorkspaceBotData(root: string, python: string, packaged: boolean, bot: WorkspaceBot): Promise<string[]> {
  const script = `
from pathlib import Path
import json, shutil, sys
from src.common.process_lease import ProcessLease, instance_lock_path
from src.host.registry import Registry
root, bot_id = Path(sys.argv[1]), sys.argv[2]
with ProcessLease(root / 'host' / 'run.lock'):
    bot = Registry(root).get_bot(bot_id)
    data = bot.directory / 'data'
    if data.is_symlink() or data.is_junction() or not data.resolve().is_relative_to(bot.directory.resolve()):
        raise ValueError('数据目录不能指向机器人目录之外')
    with ProcessLease(instance_lock_path(bot.directory)):
        entries = list(data.iterdir()) if data.exists() else []
        for path in entries:
            if path.is_symlink(): path.unlink()
            elif path.is_junction(): path.rmdir()
            elif path.is_dir(): shutil.rmtree(path)
            else: path.unlink()
        print(json.dumps([str(path) for path in entries]))
`;
  const { stdout } = await execute(python, [...(packaged ? ["-I"] : []), "-X", "utf8", "-c", script, root, bot.bot_id], {
    cwd: root, windowsHide: true, timeout: 120_000, env: { ...process.env, MAIBOT_INSTANCE_DIR: root },
  });
  return JSON.parse(stdout);
}
