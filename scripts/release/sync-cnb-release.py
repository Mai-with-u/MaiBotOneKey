"""Mirror one published GitHub release. Tokens are read only from the environment."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

REPO = "Mai-with-u/MaiBotOneKey"
CNB = f"https://cnb.cool/{REPO}"
API = "https://api.cnb.cool"
GITHUB_API = f"https://api.github.com/repos/{REPO}"
MANIFEST_BRANCH = "cnb-updates"


def request(url, method="GET", body=None, token=None, headers=None):
    fields = {"User-Agent": "MaiBotOneKey-release-sync", **(headers or {})}
    if token:
        fields["Authorization"] = f"Bearer {token}"
    if isinstance(body, dict):
        body = json.dumps(body).encode()
        fields["Content-Type"] = "application/json"
    return urllib.request.urlopen(urllib.request.Request(url, data=body, headers=fields, method=method), timeout=120)


def api(url, token, method="GET", body=None, missing=False):
    try:
        with request(url, method, body, token) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        if missing and error.code == 404:
            return None
        # Do not print response bodies, authorization headers or signed URLs.
        raise RuntimeError(f"{method} API request failed: HTTP {error.code}") from None


def validate_release(release):
    tag = release.get("tag_name", "")
    if release.get("draft") or release.get("prerelease") or not re.fullmatch(r"v?\d+\.\d+\.\d+", tag):
        raise ValueError("Only published stable semver releases can be mirrored")
    assets = release.get("assets", [])
    if not any(a["name"].lower().endswith(".exe") for a in assets):
        raise ValueError("Release must contain a Windows installer; retry after assets are uploaded")
    names = set()
    for asset in assets:
        name = asset["name"]
        if not name or name in (".", "..") or re.search(r'[/\\\x00-\x1f]', name) or name in names:
            raise ValueError("Invalid or duplicate release asset name")
        if not 0 < asset["size"] < 5_000_000_000:
            raise ValueError("Attachment must be nonempty and smaller than 5 GB")
        names.add(name)
    return tag, assets


def download(asset, destination):
    url = asset["browser_download_url"]
    if not url.startswith(f"https://github.com/{REPO}/releases/download/"):
        raise ValueError("Unexpected GitHub asset URL")
    digest = hashlib.sha256()
    size = 0
    with request(url) as response, destination.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            digest.update(chunk)
            output.write(chunk)
    if size != asset["size"]:
        raise ValueError("GitHub attachment size mismatch")
    sha256 = digest.hexdigest()
    if asset.get("digest") and asset["digest"] != f"sha256:{sha256}":
        raise ValueError("GitHub attachment SHA-256 mismatch")
    return sha256


def public_asset_url(tag, name):
    return f"{CNB}/-/releases/download/{urllib.parse.quote(tag, safe='')}/{urllib.parse.quote(name, safe='')}"


def verify_public_asset(tag, name, size):
    with request(public_asset_url(tag, name), headers={"Range": "bytes=0-1023"}) as response:
        if response.status not in (200, 206) or "text/html" in response.headers.get("Content-Type", ""):
            raise RuntimeError("CNB asset is not anonymously downloadable")
        if response.status == 200 and int(response.headers.get("Content-Length", "0")) != size:
            raise RuntimeError("CNB asset size mismatch")
        if not response.read(1):
            raise RuntimeError("CNB returned an empty attachment")


def git(cwd, env, *args):
    result = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True)
    if result.returncode:
        detail = result.stderr
        for key in ("CNB_TOKEN", "GH_TOKEN", "GIT_CONFIG_VALUE_0"):
            if env.get(key):
                detail = detail.replace(env[key], "[redacted]")
        raise RuntimeError(f"Git {args[0]} failed: {detail[-2000:]}")
    return result.stdout.strip()


def merge_manifest(previous, release, latest_tag):
    releases = [release] + [item for item in previous.get("releases", []) if item["tag_name"] != release["tag_name"]]
    if not any(item["tag_name"] == latest_tag for item in releases):
        # Backfilling an old release must not advertise it as the latest release.
        return None
    return {"schema": 1, "latestTag": latest_tag, "releases": releases}


def main():
    token = os.environ.get("CNB_TOKEN")
    if not token:
        raise ValueError("Missing GitHub Actions secret CNB_TOKEN")
    gh_token = os.environ.get("GH_TOKEN")
    tag_input = os.environ.get("RELEASE_TAG", "").strip()
    latest = api(f"{GITHUB_API}/releases/latest", gh_token)
    release = api(f"{GITHUB_API}/releases/tags/{urllib.parse.quote(tag_input, safe='')}", gh_token) if tag_input else latest
    tag, assets = validate_release(release)
    endpoint = f"{API}/{REPO}/-/releases"
    # Scope credentials to CNB Git only, and keep them out of process arguments and repository config.
    auth = base64.b64encode(f"cnb:{token}".encode()).decode()
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_COUNT": "1",
           "GIT_CONFIG_KEY_0": "http.https://cnb.cool/.extraheader", "GIT_CONFIG_VALUE_0": f"Authorization: Basic {auth}"}
    with tempfile.TemporaryDirectory(prefix="onekey-cnb-") as directory:
        root = Path(directory)
        git(root, env, "init", "--quiet")
        git(root, env, "config", "user.name", "MaiBot Release Sync")
        git(root, env, "config", "user.email", "release-sync@users.noreply.github.com")
        git(root, env, "fetch", f"https://github.com/{REPO}.git", f"refs/tags/{tag}:refs/tags/{tag}")
        git(root, env, "push", f"{CNB}.git", f"refs/tags/{tag}:refs/tags/{tag}")
        remote = api(f"{endpoint}/tags/{urllib.parse.quote(tag, safe='')}", token, missing=True)
        if not remote:
            remote = api(endpoint, token, "POST", {"tag_name": tag, "name": release["name"] or tag,
                         "body": release["body"] or "", "draft": True, "prerelease": False, "make_latest": "false"})
        release_id = urllib.parse.quote(str(remote["id"]), safe="")
        mirrored_assets = []
        for asset in assets:
            print(f"Syncing {asset['name']}", flush=True)
            # Use a fixed local filename: release names are never interpreted as local paths.
            file = root / "attachment.bin"
            sha256 = download(asset, file)
            existing = next((a for a in remote.get("assets", []) if a["name"] == asset["name"]), None)
            if existing:
                known_hash = existing.get("hash_value") if existing.get("hash_algo", "").lower().replace("-", "") == "sha256" else None
                if not known_hash and not remote.get("draft"):
                    with request(public_asset_url(tag, asset["name"])) as response:
                        digest = hashlib.sha256()
                        while chunk := response.read(1024 * 1024):
                            digest.update(chunk)
                        known_hash = digest.hexdigest()
                if known_hash != sha256 or existing.get("size") != asset["size"]:
                    raise ValueError("Existing CNB attachment cannot be verified; refusing to overwrite it")
            else:
                upload = api(f"{endpoint}/{release_id}/asset-upload-url", token, "POST",
                             {"asset_name": asset["name"], "size": asset["size"], "overwrite": False, "ttl": 0})
                upload_url = urllib.parse.urlparse(upload["upload_url"])
                if upload_url.scheme != "https":
                    raise ValueError("Upload requires HTTPS")
                with file.open("rb") as body, request(upload["upload_url"], "PUT", body,
                        headers={"Content-Length": str(asset["size"]), "Content-Type": "application/octet-stream"}) as response:
                    response.read()
                verify_url = urllib.parse.urljoin(API, upload["verify_url"])
                if not verify_url.startswith(f"{endpoint}/{release_id}/asset-upload-confirmation/"):
                    raise ValueError("Unexpected upload confirmation URL")
                api(verify_url, token, "POST")
            mirrored_assets.append({"name": asset["name"], "size": asset["size"], "sha256": sha256})
            file.unlink()
        api(f"{endpoint}/{release_id}", token, "PATCH", {"draft": False, "prerelease": False,
            "name": release["name"] or tag, "body": release["body"] or "",
            "make_latest": "true" if latest["tag_name"] == tag else "false"})
        for asset in assets:
            verify_public_asset(tag, asset["name"], asset["size"])
        branch = f"refs/heads/{MANIFEST_BRANCH}"
        previous = {}
        if git(root, env, "ls-remote", "--heads", f"{CNB}.git", branch):
            git(root, env, "fetch", "--depth=1", f"{CNB}.git", branch)
            git(root, env, "checkout", "-b", MANIFEST_BRANCH, "FETCH_HEAD")
            previous = json.loads((root / "latest.json").read_text(encoding="utf-8"))
        else:
            git(root, env, "checkout", "--orphan", MANIFEST_BRANCH)
        latest = api(f"{GITHUB_API}/releases/latest", gh_token)
        manifest = merge_manifest(previous, {"tag_name": tag, "name": release["name"] or tag,
                                  "body": release["body"] or "", "assets": mirrored_assets}, latest["tag_name"])
        if manifest is None:
            print("Release mirrored. Manifest unchanged: sync the current GitHub latest release next.")
            return
        (root / "latest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        git(root, env, "add", "latest.json")
        if git(root, env, "status", "--porcelain"):
            git(root, env, "commit", "-m", f"chore: 同步 {tag} 更新清单")
            git(root, env, "push", f"{CNB}.git", f"HEAD:{branch}")
        with request(f"{CNB}/-/raw/{MANIFEST_BRANCH}/latest.json") as response:
            if json.load(response) != manifest:
                raise RuntimeError("Public update manifest verification failed")
        print(f"Verified CNB release {tag} and public update manifest")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # urllib exceptions may contain signed URLs; avoid printing their details.
        if isinstance(error, (ValueError, RuntimeError)):
            print(f"Sync failed: {error}", flush=True)
        else:
            print(f"Sync failed: {type(error).__name__}; rerun after checking network and permissions", flush=True)
        raise SystemExit(1)
