"""Publish verified CI artifacts using the checked-out version and changelog."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


REPO = "Mai-with-u/MaiBotOneKey"


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True).strip()


def release_notes(root):
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    version = package["version"]
    if package["name"] != "maibot-onekey-desktop" or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Expected OneKey with a stable version in package.json")
    changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
    match = re.search(rf"(?ms)^## {re.escape(version)}(?:\s[^\n]*)?\n(.+?)(?=^## |\Z)", changelog)
    if not match or not match[1].strip():
        raise ValueError(f"CHANGELOG.md has no release notes for {version}")
    return version, match[0].strip()


def validate_assets(directory, version):
    files = sorted(path for path in directory.iterdir() if path.is_file())
    names = {path.name for path in files}
    installer = f"MaiBot-OK-{version}-win.exe"
    required = {installer, installer + ".blockmap", "latest.yml", "latest-win.yml", "SHA256SUMS.txt"}
    if not required <= names or not any(path.suffix == ".dmg" and version in path.name for path in files):
        raise ValueError("Missing Windows installer, update files, checksums or macOS DMG")
    for name in ("latest.yml", "latest-win.yml"):
        content = (directory / name).read_text(encoding="utf-8")
        if f"version: {version}\n" not in content or f"path: {installer}\n" not in content:
            raise ValueError(f"Version or installer mismatch in {name}")
    for line in (directory / "SHA256SUMS.txt").read_text(encoding="utf-8-sig").splitlines():
        digest, name = line.split("  ", 1)
        if name not in names or hashlib.sha256((directory / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f"Artifact checksum mismatch: {name}")
    if any(path.stat().st_size == 0 for path in files):
        raise ValueError("Empty release artifact")
    return files


def main():
    root = Path.cwd()
    version, notes = release_notes(root)
    dry_run = os.environ.get("DRY_RUN") == "true"
    commit = os.environ["GITHUB_SHA"]
    if os.environ["GITHUB_REPOSITORY"] != REPO:
        raise ValueError("This workflow only publishes Mai-with-u/MaiBotOneKey")
    if os.environ["GITHUB_REF"] != "refs/heads/main":
        raise ValueError("Run the release workflow on main")
    # Do not replace a release built from a different commit.
    tag = subprocess.run(["git", "rev-parse", "--verify", f"refs/tags/{version}^{{commit}}"], capture_output=True, text=True)
    if not dry_run and tag.returncode == 0 and tag.stdout.strip() != commit:
        raise ValueError(f"Tag {version} already belongs to another commit; bump package.json and CHANGELOG.md")
    if sys.argv[1] == "prepare":
        if not dry_run and not os.environ.get("CNB_TOKEN"):
            raise ValueError("Configure CNB_TOKEN before starting a full release")
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"version={version}\n")
        print(f"Validated {version}\n{notes}")
        return
    files = validate_assets(root / "release-assets", version)
    if dry_run:
        print(f"Dry run passed: {version}, {len(files)} artifacts; nothing published")
        return
    notes_path = root / "release-notes.md"
    notes_path.write_text(notes, encoding="utf-8")
    releases = json.loads(gh("api", "--paginate", "--slurp", f"repos/{REPO}/releases?per_page=100"))
    existing = next((item for page in releases for item in page if item["tag_name"] == version), None)
    if existing is None:
        gh("release", "create", version, "--repo", REPO, "--target", commit, "--title", version,
           "--notes-file", str(notes_path), "--draft")
    elif existing["target_commitish"] != commit and tag.returncode != 0:
        raise ValueError("Existing release does not point to this commit")
    remote = json.loads(gh("release", "view", version, "--repo", REPO, "--json", "assets,isDraft"))
    assets = {asset["name"]: asset for asset in remote["assets"]}
    for path in files:
        prior = assets.get(path.name)
        digest = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        if prior:
            if prior["state"] != "uploaded" or prior["digest"] != digest or prior["size"] != path.stat().st_size:
                raise ValueError(f"Existing asset differs: {path.name}; refusing to overwrite")
        else:
            if not remote["isDraft"]:
                raise ValueError("Published release is missing assets; refusing to modify it")
            gh("release", "upload", version, str(path), "--repo", REPO)
    verified = json.loads(gh("release", "view", version, "--repo", REPO, "--json", "assets"))
    expected = {path.name: "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
    if {asset["name"]: asset["digest"] for asset in verified["assets"] if asset["state"] == "uploaded"} != expected:
        raise ValueError("Uploaded assets do not match the verified build")
    gh("release", "edit", version, "--repo", REPO, "--notes-file", str(notes_path), "--draft=false", "--latest")
    print(f"Published https://github.com/{REPO}/releases/tag/{version}")


if __name__ == "__main__":
    main()
