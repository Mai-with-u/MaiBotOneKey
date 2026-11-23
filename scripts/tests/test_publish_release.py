import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("publish_release", Path(__file__).parents[1] / "release/publish-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_notes_only_include_exact_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "package.json").write_text(json.dumps({"name": "maibot-onekey-desktop", "version": "0.9.4"}))
            (root / "CHANGELOG.md").write_text("# Changelog\n\n## 0.9.4 - 2026-11-23\n\n- Fix\n\n## 0.9.3\n\n- Old\n")
            version, notes = release.release_notes(root)
            self.assertEqual(version, "0.9.4")
            self.assertIn("- Fix", notes)
            self.assertNotIn("Old", notes)
            (root / "CHANGELOG.md").write_text("## 0.9.40\n\n- Wrong version\n")
            with self.assertRaises(ValueError):
                release.release_notes(root)

    def test_assets_require_both_platforms_and_matching_checksums(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            installer = "MaiBot-OK-0.9.4-win.exe"
            (root / installer).write_bytes(b"installer")
            (root / (installer + ".blockmap")).write_bytes(b"blockmap")
            for name in ("latest.yml", "latest-win.yml"):
                (root / name).write_text(f"version: 0.9.4\npath: {installer}\n")
            checksum = release.hashlib.sha256(b"installer").hexdigest()
            (root / "SHA256SUMS.txt").write_text(f"{checksum}  {installer}\n")
            with self.assertRaises(ValueError):
                release.validate_assets(root, "0.9.4")
            (root / "MaiBot OneKey-0.9.4-arm64.dmg").write_bytes(b"dmg")
            self.assertEqual(len(release.validate_assets(root, "0.9.4")), 6)
            (root / installer).write_bytes(b"corrupted")
            with self.assertRaises(ValueError):
                release.validate_assets(root, "0.9.4")


if __name__ == "__main__":
    unittest.main()
