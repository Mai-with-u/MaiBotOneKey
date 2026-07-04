#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export LANG=C

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
qq_app="${NAPCAT_QQ_APP:-/Applications/QQ.app}"
qq_exe="$qq_app/Contents/MacOS/QQ"
qq_app_root="$qq_app/Contents/Resources/app"
qq_package="$qq_app_root/package.json"
qq_container="${NAPCAT_QQ_CONTAINER:-$HOME/Library/Containers/com.tencent.qq/Data}"
qq_documents="$qq_container/Documents"
qq_napcat="$qq_documents/napcat"
loader_path="$qq_documents/loadNapCat.js"
loader_relative="../../../../..$loader_path"
package_backup="$qq_package.maibot-onekey.bak"
qq_pid=""

quote_js_string() {
  printf "%s" "$1" | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g"
}

patch_qq_package() {
  local patched
  patched="$(mktemp)"
  cp "$qq_package" "$patched"

  LOADER_RELATIVE="$loader_relative" perl -0pi -e '
    my $value = $ENV{"LOADER_RELATIVE"};
    $value =~ s/\\/\\\\/g;
    $value =~ s/"/\\"/g;
    s/"main"\s*:\s*"[^"]*"/"main": "$value"/s or die "package.json main field not found\n";
  ' "$patched"

  if cmp -s "$patched" "$qq_package"; then
    rm -f "$patched"
    return
  fi

  echo "[napcat] Backing up QQ package.json"
  if ! cp "$qq_package" "$package_backup" 2>/dev/null; then
    sudo cp "$qq_package" "$package_backup"
  fi

  echo "[napcat] Patching QQ package.json. macOS may ask for your login password."
  if ! cp "$patched" "$qq_package" 2>/dev/null; then
    sudo cp "$patched" "$qq_package"
  fi
  rm -f "$patched"
}

restore_qq_package() {
  if [ ! -f "$package_backup" ]; then
    return
  fi

  echo "[napcat] Restoring QQ package.json"
  if ! cp "$package_backup" "$qq_package" 2>/dev/null; then
    sudo cp "$package_backup" "$qq_package"
  fi
}

cleanup_napcat_runtime() {
  rm -f "$loader_path"
  if [ -d "$qq_napcat" ]; then
    find "$qq_napcat" -mindepth 1 -maxdepth 1 ! -name config -exec rm -rf {} +
  fi
}

cleanup() {
  local exit_code=$?
  trap - EXIT HUP INT TERM

  if [ -n "$qq_pid" ] && kill -0 "$qq_pid" 2>/dev/null; then
    kill "$qq_pid" 2>/dev/null || true
    wait "$qq_pid" 2>/dev/null || true
  fi

  restore_qq_package || true
  cleanup_napcat_runtime || true
  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -x "$qq_exe" ]; then
  echo "[napcat] QQ executable not found: $qq_exe" >&2
  echo "[napcat] Install QQ for macOS, or set NAPCAT_QQ_APP=/path/to/QQ.app" >&2
  exit 1
fi

if [ ! -f "$qq_package" ]; then
  echo "[napcat] QQ package.json not found: $qq_package" >&2
  exit 1
fi

mkdir -p "$qq_documents" "$qq_napcat/config"
export NAPCAT_WORKDIR="$qq_napcat"

echo "[napcat] Syncing NapCat runtime files to QQ container"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude ".git/" \
    --exclude "config/**" \
    --exclude "cache/**" \
    --exclude "data/**" \
    --exclude "logs/**" \
    --exclude "temp/**" \
    --exclude "tmp/**" \
    "$script_dir/" "$qq_napcat/"
else
  cp -R "$script_dir/." "$qq_napcat/"
fi

if [ ! -f "$qq_napcat/config/napcat.json" ] && [ -f "$script_dir/config/napcat.json" ]; then
  cp "$script_dir/config/napcat.json" "$qq_napcat/config/napcat.json"
fi

napcat_main="$(quote_js_string "$qq_napcat/napcat.mjs")"
napcat_workdir="$(quote_js_string "$qq_napcat")"
qq_app_root_js="$(quote_js_string "$qq_app_root")"
cat > "$loader_path" <<EOF
const { pathToFileURL } = require("url");
const hasNapcatParam = process.argv.includes("--no-sandbox") || process.argv.includes("--maibot-napcat");
const qqAppRoot = '$qq_app_root_js';
const qqPackage = require(qqAppRoot + "/package.json");
process.env.NAPCAT_WORKDIR = process.env.NAPCAT_WORKDIR || '$napcat_workdir';

if (hasNapcatParam) {
  (async () => {
    await import(pathToFileURL('$napcat_main').href);
  })();
} else {
  require(qqAppRoot + "/app_launcher/index.js");
  setImmediate(() => {
    global.launcher.installPathPkgJson.main = ((version) => {
      if (version >= 29271) return "./application.asar/app_launcher/index.js";
      if (version >= 28060) return "./application/app_launcher/index.js";
      return "./app_launcher/index.js";
    })(qqPackage.buildVersion);
  });
}
EOF

patch_qq_package

echo "[napcat] Launching QQ with NapCat"
"$qq_exe" --no-sandbox --maibot-napcat "$@" &
qq_pid=$!
set +e
wait "$qq_pid"
qq_status=$?
set -e
qq_pid=""
exit "$qq_status"
