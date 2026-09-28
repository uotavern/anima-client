#!/usr/bin/env python3
"""Validate a release, collect verified installers, and prepare a draft only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
PLATFORMS = {"macos": ("aarch64-apple-darwin", "aarch64.dmg"),
             "windows": ("x86_64-pc-windows-msvc", "x64-setup.exe")}


def git(*args, root=ROOT):
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


def metadata(tag, root=ROOT):
    version = json.loads((root / "crates/anima-desktop/tauri.conf.json").read_text())["version"]
    if not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag):
        raise ValueError("Choose an existing stable version tag, such as v0.7.0.")
    if tag != "v" + version:
        raise ValueError("Release tag must match the version in tauri.conf.json.")
    notes = root / "docs/releases" / (tag + ".md")
    if not notes.is_file() or not notes.read_text(encoding="utf-8").startswith("# Anima " + tag):
        raise ValueError("Provide player-facing release notes under docs/releases/ for this tag.")
    return {"tag": tag, "version": version, "notes": str(notes.relative_to(root))}


def checked_metadata(tag, root=ROOT):
    data = metadata(tag, root)
    head = git("rev-parse", "HEAD", root=root)
    tagged = git("rev-parse", "refs/tags/" + tag + "^{commit}", root=root)
    if head != tagged:
        raise ValueError("The checked-out commit does not match the requested release tag.")
    data["sha"] = head
    return data


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def collect(data, platform, signing, directory, root=ROOT):
    target, suffix = PLATFORMS[platform]
    expected = f"Anima_{data['version']}_{suffix}"
    pattern = ("target/aarch64-apple-darwin/release/bundle/dmg/*.dmg"
               if platform == "macos" else "target/release/bundle/nsis/*-setup.exe")
    files = list(root.glob(pattern))
    if len(files) != 1 or files[0].name != expected or not files[0].stat().st_size:
        raise ValueError(f"Expected exactly one current {platform} installer: {expected}")
    if (platform == "macos" and signing not in ("adhoc", "developer-id", "notarized")) or (
            platform == "windows" and signing != "unsigned"):
        raise ValueError("Unexpected signing result for this platform.")
    directory.mkdir(parents=True, exist_ok=True)
    artifact = directory / expected
    shutil.copyfile(files[0], artifact)
    manifest = {"format": 1, "tag": data["tag"], "commit": data["sha"],
                "platform": platform, "target": target, "signing": signing,
                "file": expected, "bytes": artifact.stat().st_size, "sha256": digest(artifact)}
    (directory / (platform + "-build.json")).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def verify_installers(data, directory):
    manifests = []
    for platform, (target, suffix) in PLATFORMS.items():
        manifest = json.loads((directory / (platform + "-build.json")).read_text())
        expected = f"Anima_{data['version']}_{suffix}"
        if any(manifest.get(key) != value for key, value in {
                "format": 1, "tag": data["tag"], "commit": data["sha"],
                "platform": platform, "target": target, "file": expected}.items()):
            raise ValueError("Installer provenance does not match the release commit and platform.")
        if manifest.get("signing") not in (("adhoc", "developer-id", "notarized")
                if platform == "macos" else ("unsigned",)):
            raise ValueError("Invalid installer signing result.")
        path = directory / expected
        if path.stat().st_size != manifest["bytes"] or digest(path) != manifest["sha256"]:
            raise ValueError("Installer checksum or size does not match its build manifest.")
        manifests.append(manifest)
    return manifests


def release_state(repository, tag):
    # The tag endpoint only finds published releases. Include every page of
    # the release list so an existing draft is edited, never recreated.
    result = subprocess.run(["gh", "api", f"repos/{repository}/releases?per_page=100",
                             "--paginate", "--slurp"],
                            capture_output=True, text=True)
    if result.returncode:
        raise ValueError("Could not check the existing release; no release changes were made.")
    pages = json.loads(result.stdout)
    if not isinstance(pages, list) or any(not isinstance(page, list) for page in pages):
        raise ValueError("Unexpected release listing; no release changes were made.")
    releases = [item for page in pages for item in page]
    if any(not isinstance(item, dict) or not isinstance(item.get("tag_name"), str) for item in releases):
        raise ValueError("Unexpected release listing; no release changes were made.")
    matches = [item for item in releases if item["tag_name"] == tag]
    if not matches:
        return None
    if len(matches) != 1:
        raise ValueError("Multiple releases match this tag; no release changes were made.")
    release = matches[0]
    if release.get("draft") is not True:
        raise ValueError("This release is already public. Create a new version instead of replacing its files.")
    return release


def verify_build(repository, run_id, commit):
    if not re.fullmatch(r"[1-9][0-9]*", run_id):
        raise ValueError("Choose a numeric release workflow run ID.")
    endpoint = f"repos/{repository}/actions/runs/{run_id}"
    run = json.loads(subprocess.check_output(["gh", "api", endpoint], text=True))
    if run.get("head_sha") != commit or run.get("path") != ".github/workflows/release.yml" or run.get("status") != "completed":
        raise ValueError("The completed release workflow must match the tagged source commit.")
    jobs = json.loads(subprocess.check_output(["gh", "api", endpoint + "/jobs?per_page=100"], text=True))["jobs"]
    required = {"Validate release tag and notes", "Bundle (macos)", "Bundle (windows)",
                "Verify the release commit / Desktop compile (macos-latest)",
                "Verify the release commit / Desktop compile (windows-latest)"}
    # The quality-gate job lost "WASM" from its name when the browser build was
    # removed (2026-09-29); runs from earlier releases carry the old name.
    gates = {"Verify the release commit / Rust and web quality gates",
             "Verify the release commit / Rust, WASM, and web quality gates"}
    successful = {job["name"] for job in jobs if job["conclusion"] == "success"}
    if not required.issubset(successful) or not gates & successful:
        raise ValueError("Both builds and all quality gates must have passed before draft assembly can be retried.")


def prepare_draft(data, directory, repository, source=None):
    manifests = verify_installers(data, directory)
    release = release_state(repository, data["tag"])
    notes = ((source or ROOT) / data["notes"]).read_text(encoding="utf-8")
    title = notes.splitlines()[0].removeprefix("# ")
    notes += "\n## Build details\n\n"
    notes += f"Source commit: `{data['sha']}`. Both installers passed the shared quality gates.\n\n"
    for manifest in manifests:
        notes += f"- {manifest['platform']} / `{manifest['target']}`: {manifest['signing']}.\n"
    notes += "\nSee `SHA256SUMS.txt` and the platform build manifests for download verification.\n"
    body = directory / "release-notes.md"
    body.write_text(notes, encoding="utf-8")
    sums = directory / "SHA256SUMS.txt"
    sums.write_text("".join(f"{m['sha256']}  {m['file']}\n" for m in manifests), encoding="utf-8")
    if release is None:
        # The tag already exists and was checked against the source commit.
        # --target is unused for existing tags and may ask GitHub to authorize
        # historical workflow changes unnecessarily. Never create/move a tag.
        command = ["gh", "release", "create", data["tag"], "--verify-tag", "--draft"]
    else:
        command = ["gh", "release", "edit", data["tag"], "--draft"]
    subprocess.run(command + ["--repo", repository, "--title", title, "--notes-file", str(body)], check=True)
    # Re-check immediately before uploads, including retries of a previous draft.
    release_state(repository, data["tag"])
    files = [directory / m["file"] for m in manifests]
    files += [directory / (m["platform"] + "-build.json") for m in manifests] + [sums]
    subprocess.run(["gh", "release", "upload", data["tag"], "--repo", repository, "--clobber",
                    *map(str, files)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("metadata", "collect", "draft"))
    parser.add_argument("--tag", required=True)
    parser.add_argument("--platform", choices=tuple(PLATFORMS))
    parser.add_argument("--signing")
    parser.add_argument("--directory", type=Path, default=ROOT / "release-dist")
    parser.add_argument("--source", type=Path, default=ROOT, help="Checkout of the exact tagged source")
    parser.add_argument("--build-run", help="Completed release run to verify when retrying draft assembly")
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", "hulryung-uo/anima-client"))
    args = parser.parse_args()
    data = checked_metadata(args.tag, args.source)
    if args.build_run:
        verify_build(args.repo, args.build_run, data["sha"])
    if args.action == "metadata":
        release_state(args.repo, args.tag)
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
                for key, value in data.items():
                    output.write(f"{key}={value}\n")
        print(json.dumps(data))
    elif args.action == "collect":
        if not args.platform or not args.signing:
            parser.error("collect requires --platform and --signing")
        print(json.dumps(collect(data, args.platform, args.signing, args.directory, args.source)))
    else:
        prepare_draft(data, args.directory, args.repo, args.source)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
