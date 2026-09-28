import json
import base64
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import release

spec = importlib.util.spec_from_file_location("apple_signing", Path(__file__).with_name("apple-signing.py"))
apple_signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apple_signing)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        config = self.root / "crates/anima-desktop/tauri.conf.json"
        config.parent.mkdir(parents=True)
        config.write_text('{"version":"0.7.0"}')
        notes = self.root / "docs/releases/v0.7.0.md"
        notes.parent.mkdir(parents=True)
        notes.write_text("# Anima v0.7.0 — Test release\n", encoding="utf-8")
        self.data = {"tag": "v0.7.0", "version": "0.7.0", "sha": "a" * 40}
        self.dist = self.root / "dist"

    def installers(self):
        for platform, folder in (("macos", "target/aarch64-apple-darwin/release/bundle/dmg"),
                                 ("windows", "target/release/bundle/nsis")):
            path = self.root / folder / ("Anima_0.7.0_" + release.PLATFORMS[platform][1])
            path.parent.mkdir(parents=True)
            path.write_bytes(b"fixture installer: " + platform.encode())
            release.collect(self.data, platform, "adhoc" if platform == "macos" else "unsigned", self.dist, self.root)

    def test_tag_must_match_version_and_have_notes(self):
        self.assertEqual(release.metadata("v0.7.0", self.root)["version"], "0.7.0")
        for tag in ("main", "v0.6.0", "v0.7.0/../../file", "v00.7.0"):
            with self.assertRaises(ValueError):
                release.metadata(tag, self.root)
        (self.root / "docs/releases/v0.7.0.md").unlink()
        with self.assertRaises(ValueError):
            release.metadata("v0.7.0", self.root)

    def test_branch_head_cannot_substitute_for_tagged_commit(self):
        with patch.object(release, "metadata", return_value=self.data), patch.object(release, "git", side_effect=["a" * 40, "b" * 40]):
            with self.assertRaises(ValueError):
                release.checked_metadata("v0.7.0")

    def test_both_platforms_and_exact_installer_bytes_are_required(self):
        self.installers()
        self.assertEqual(len(release.verify_installers(self.data, self.dist)), 2)
        (self.dist / "Anima_0.7.0_x64-setup.exe").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            release.verify_installers(self.data, self.dist)

    def test_wrong_commit_and_unsafe_filename_are_rejected(self):
        self.installers()
        path = self.dist / "macos-build.json"
        original = json.loads(path.read_text())
        for key, value in (("commit", "b" * 40), ("file", "../../private"), ("signing", "guaranteed-safe")):
            manifest = dict(original, **{key: value})
            path.write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                release.verify_installers(self.data, self.dist)

    def test_missing_platform_does_not_create_a_partial_release(self):
        self.installers()
        (self.dist / "windows-build.json").unlink()
        with patch.object(release, "release_state") as check:
            with self.assertRaises(FileNotFoundError):
                release.prepare_draft(self.data, self.dist, "example/repo")
            check.assert_not_called()

    def test_draft_creation_uses_reviewable_notes_and_only_verified_assets(self):
        self.installers()
        self.data["notes"] = "docs/releases/v0.7.0.md"
        with patch.object(release, "ROOT", self.root), patch.object(release, "release_state", side_effect=[None, {"draft": True}]), patch.object(release.subprocess, "run") as run:
            release.prepare_draft(self.data, self.dist, "example/repo")
        create, upload = [call.args[0] for call in run.call_args_list]
        self.assertIn("--draft", create)
        self.assertIn("--verify-tag", create)
        self.assertIn("--notes-file", create)
        self.assertNotIn("--target", create, "an existing verified tag must not request another target")
        self.assertEqual(len(upload[upload.index("--clobber") + 1:]), 5)
        self.assertIn("Source commit: `" + "a" * 40, (self.dist / "release-notes.md").read_text())
        self.assertEqual(len((self.dist / "SHA256SUMS.txt").read_text().splitlines()), 2)

    def test_stale_installer_is_rejected_instead_of_being_uploaded(self):
        self.installers()
        folder = self.root / "target/release/bundle/nsis"
        (folder / "Anima_0.6.0_x64-setup.exe").write_bytes(b"stale build")
        with self.assertRaises(ValueError):
            release.collect(self.data, "windows", "unsigned", self.dist, self.root)

    def test_draft_retry_requires_successful_builds_and_tests_for_the_same_commit(self):
        run = {"head_sha": "a" * 40, "path": ".github/workflows/release.yml", "status": "completed"}
        names = ["Validate release tag and notes", "Bundle (macos)", "Bundle (windows)",
                 "Verify the release commit / Rust and web quality gates",
                 "Verify the release commit / Desktop compile (macos-latest)",
                 "Verify the release commit / Desktop compile (windows-latest)"]
        jobs = {"jobs": [{"name": name, "conclusion": "success"} for name in names]}
        with patch.object(release.subprocess, "check_output", side_effect=[json.dumps(run), json.dumps(jobs)]):
            release.verify_build("example/repo", "123", "a" * 40)
        # A release built before the rename carries the old quality-gate job name.
        old = [dict(job) for job in jobs["jobs"]]
        old[3]["name"] = "Verify the release commit / Rust, WASM, and web quality gates"
        with patch.object(release.subprocess, "check_output", side_effect=[json.dumps(run), json.dumps({"jobs": old})]):
            release.verify_build("example/repo", "123", "a" * 40)
        missing = [job for job in jobs["jobs"] if "quality gates" not in job["name"]]
        with patch.object(release.subprocess, "check_output", side_effect=[json.dumps(run), json.dumps({"jobs": missing})]):
            with self.assertRaises(ValueError):
                release.verify_build("example/repo", "123", "a" * 40)
        jobs["jobs"][1]["conclusion"] = "failure"
        with patch.object(release.subprocess, "check_output", side_effect=[json.dumps(run), json.dumps(jobs)]):
            with self.assertRaises(ValueError):
                release.verify_build("example/repo", "123", "a" * 40)
        with patch.object(release.subprocess, "check_output", return_value=json.dumps(run)):
            with self.assertRaises(ValueError):
                release.verify_build("example/repo", "123", "b" * 40)
        with self.assertRaises(ValueError):
            release.verify_build("example/repo", "../123", "a" * 40)

    def test_existing_public_release_is_never_replaced(self):
        result = subprocess.CompletedProcess([], 0, '[[{"tag_name":"v0.7.0","draft":false}]]', "")
        with patch.object(release.subprocess, "run", return_value=result):
            with self.assertRaises(ValueError):
                release.release_state("example/repo", "v0.7.0")

    def test_existing_draft_is_found_on_a_later_page(self):
        draft = {"id": 123, "tag_name": "v0.7.0", "draft": True}
        pages = [[{"tag_name": "v0.8.0", "draft": False}], [draft]]
        result = subprocess.CompletedProcess([], 0, json.dumps(pages), "")
        with patch.object(release.subprocess, "run", return_value=result) as run:
            self.assertEqual(release.release_state("example/repo", "v0.7.0"), draft)
        command = run.call_args.args[0]
        self.assertIn("--paginate", command)
        self.assertIn("--slurp", command)
        self.assertIn("repos/example/repo/releases?per_page=100", command)

    def test_only_a_successful_complete_listing_can_establish_missing_release(self):
        result = subprocess.CompletedProcess([], 0, '[[{"tag_name":"v0.6.0","draft":false}],[]]', "")
        with patch.object(release.subprocess, "run", return_value=result):
            self.assertIsNone(release.release_state("example/repo", "v0.7.0"))
        for status in (401, 403, 404):
            result = subprocess.CompletedProcess([], 1, "", f"gh: Request failed (HTTP {status})")
            with patch.object(release.subprocess, "run", return_value=result):
                with self.assertRaises(ValueError):
                    release.release_state("example/repo", "v0.7.0")

    def test_malformed_or_ambiguous_listing_cannot_create_a_release(self):
        draft = {"tag_name": "v0.7.0", "draft": True}
        for listing in ({}, [None], [[None]], [[{}]], [[draft], [draft]]):
            result = subprocess.CompletedProcess([], 0, json.dumps(listing), "")
            with patch.object(release.subprocess, "run", return_value=result):
                with self.assertRaises(ValueError):
                    release.release_state("example/repo", "v0.7.0")

    def test_retry_edits_the_existing_draft(self):
        self.installers()
        self.data["notes"] = "docs/releases/v0.7.0.md"
        with patch.object(release, "ROOT", self.root), patch.object(release, "release_state", return_value={"draft": True}), patch.object(release.subprocess, "run") as run:
            release.prepare_draft(self.data, self.dist, "example/repo")
        edit, upload = [call.args[0] for call in run.call_args_list]
        self.assertEqual(edit[:4], ["gh", "release", "edit", "v0.7.0"])
        self.assertIn("--draft", edit)
        self.assertEqual(upload[:4], ["gh", "release", "upload", "v0.7.0"])

    def test_incomplete_signing_never_silently_downgrades(self):
        env, output = self.root / "env", self.root / "output"
        for source in ({"APPLE_CERTIFICATE": "fixture"}, {"APPLE_API_KEY": "fixture"}):
            with self.assertRaises(ValueError):
                apple_signing.configure(source, env, output, self.root)
            self.assertFalse(env.exists())
            self.assertFalse(output.exists())

    def test_adhoc_build_has_no_empty_certificate_environment(self):
        env, output = self.root / "env", self.root / "output"
        self.assertEqual(apple_signing.configure({}, env, output, self.root), "adhoc")
        self.assertNotIn("APPLE_CERTIFICATE", env.read_text())
        self.assertIn("APPLE_SIGNING_IDENTITY", env.read_text())
        self.assertEqual(output.read_text(), "signing=adhoc\n")

    def test_complete_signing_uses_the_configured_identity_and_private_key_file(self):
        env, output = self.root / "env", self.root / "output"
        source = {key: "test-only" for key in apple_signing.SIGNING + apple_signing.NOTARY}
        source["APPLE_SIGNING_IDENTITY"] = "Developer ID Application: Test Only (TESTTEAM)"
        key = b"-----BEGIN PRIVATE KEY-----\nfixture, not a key\n-----END PRIVATE KEY-----\n"
        source["APPLE_API_KEY_BASE64"] = base64.b64encode(key).decode()
        self.assertEqual(apple_signing.configure(source, env, output, self.root), "notarized")
        key_file = self.root / "anima-notary/AuthKey.p8"
        self.assertEqual(key_file.read_bytes(), key)
        self.assertEqual(key_file.stat().st_mode & 0o777, 0o600)
        self.assertIn(source["APPLE_SIGNING_IDENTITY"], env.read_text())
        self.assertNotIn(source["APPLE_API_KEY_BASE64"], env.read_text())


if __name__ == "__main__":
    unittest.main()
