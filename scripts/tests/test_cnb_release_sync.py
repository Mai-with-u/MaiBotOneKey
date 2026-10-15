import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("cnb_sync", Path(__file__).parents[1] / "release/sync-cnb-release.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class SyncTests(unittest.TestCase):
    def release(self):
        return {"tag_name": "0.7.0", "name": "0.7.0", "body": "Notes", "assets": [
            {"name": "installer.exe", "size": 3, "browser_download_url": f"https://github.com/{sync.REPO}/releases/download/0.7.0/installer.exe"}]}

    def test_draft_prerelease_missing_installer_and_unsafe_names(self):
        for update in [{"draft": True}, {"prerelease": True}, {"tag_name": "0.7.0-rc1"}, {"assets": []},
                       {"assets": [{"name": "../installer.exe", "size": 3}]}]:
            with self.subTest(update=update), self.assertRaises(ValueError):
                sync.validate_release({**self.release(), **update})

    def test_empty_and_oversize_assets(self):
        for size in [0, 5_000_000_000]:
            release = self.release()
            release["assets"][0]["size"] = size
            with self.assertRaises(ValueError):
                sync.validate_release(release)

    def test_download_verifies_size_and_digest(self):
        asset = self.release()["assets"][0]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "installer"
            with patch.object(sync, "request", return_value=io.BytesIO(b"exe")):
                self.assertEqual(sync.download(asset, path), hashlib.sha256(b"exe").hexdigest())
            with patch.object(sync, "request", return_value=io.BytesIO(b"ex")), self.assertRaises(ValueError):
                sync.download(asset, path)
            with patch.object(sync, "request", return_value=io.BytesIO(b"exe")), self.assertRaises(ValueError):
                sync.download({**asset, "digest": "sha256:incorrect"}, path)

    def test_backfill_does_not_promote_old_release(self):
        old = {"tag_name": "0.6.3"}
        self.assertIsNone(sync.merge_manifest({}, old, "0.7.0"))
        result = sync.merge_manifest({"releases": [{"tag_name": "0.7.0"}]}, old, "0.7.0")
        self.assertEqual(result["latestTag"], "0.7.0")
        self.assertEqual(len(result["releases"]), 2)

    def test_rerun_replaces_manifest_entry_without_duplicates(self):
        release = {"tag_name": "0.7.0", "body": "updated"}
        result = sync.merge_manifest({"releases": [{"tag_name": "0.7.0", "body": "old"}]}, release, "0.7.0")
        self.assertEqual(result["releases"], [release])

    def test_upload_failure_never_publishes_release_or_manifest(self):
        release = self.release()
        calls = []
        def api(url, token, method="GET", body=None, missing=False):
            calls.append((url, method))
            if "api.github.com" in url:
                return release
            if "/tags/" in url:
                return {"id": "test", "assets": [], "draft": True}
            raise RuntimeError("simulated upload failure")
        with patch.dict(sync.os.environ, {"CNB_TOKEN": "test", "RELEASE_TAG": ""}), \
             patch.object(sync, "api", side_effect=api), patch.object(sync, "git", return_value=""), \
             patch.object(sync, "download", return_value="a" * 64), self.assertRaises(RuntimeError):
            sync.main()
        self.assertFalse(any(method == "PATCH" for _, method in calls))


if __name__ == "__main__":
    unittest.main()
