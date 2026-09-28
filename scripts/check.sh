#!/usr/bin/env bash
# Run exactly the gates CI runs (.github/workflows/ci.yml, job `quality`), in the
# same order, against the toolchain `rust-toolchain.toml` pins.
#
# The pin is not advisory: `cargo fmt` and `cargo clippy` change their output
# between releases, so a *different* local toolchain silently disagrees with CI
# in both directions — green locally / red on CI, and red locally / green on CI.
# That only works when `cargo` is rustup's shim (rustup reads the pin and
# installs on demand); a distro/Homebrew `cargo` ignores the file entirely.
# So this script refuses to run rather than report a verdict CI won't share.
#
# Usage: scripts/check.sh [--skip-desktop]
set -euo pipefail

cd "$(dirname "$0")/.."

pinned=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)
active=$(rustc --version | awk '{print $2}')

if [ "$active" != "$pinned" ]; then
    echo "toolchain mismatch: rust-toolchain.toml pins $pinned, \`rustc\` is $active" >&2
    if ! command -v rustup >/dev/null 2>&1; then
        echo >&2
        echo "rustup is not installed, so the pin cannot take effect. Install it" >&2
        echo "(it shadows the current cargo/rustc with shims that honour the pin):" >&2
        echo >&2
        echo "    brew install rustup && rustup-init -y      # or: https://rustup.rs" >&2
        echo >&2
        echo "If Homebrew's \`rust\` formula is installed, remove it first —" >&2
        echo "otherwise whichever lands earlier in PATH wins:  brew uninstall rust" >&2
    else
        echo "run:  rustup toolchain install $pinned" >&2
    fi
    exit 1
fi

run() {
    echo "==> $*"
    "$@"
}

run cargo fmt --all -- --check
run cargo clippy --all-targets -- -D warnings
run cargo test
# Every script the page loads (vendor/ is a pre-built PixiJS drop, not ours).
while IFS= read -r js; do
    run node --check "$js"
done < <(find web -name '*.js' -not -path 'web/vendor/*' | sort)
# …and the same scripts compiled TOGETHER, in index.html's order, because that
# is how the browser loads them: classic scripts sharing one global scope. Two
# files declaring the same top-level `const` is a SyntaxError that kills the
# LATER file outright — lose 13-macros.js that way and the client has no input
# handlers at all. `node --check` above compiles each file alone and is blind
# to it, which is how one reached the working tree.
run node scripts/check-web-globals.mjs
# …and the same scripts RUN, not just compiled: web/test loads them into a fake
# DOM and drives the real renderer head-less. ~0.2s, no network, no shard, no UO
# data files. `node --check` and the globals check above both stop at "it parses";
# this is the first step that can tell you the client still works.
run node web/test/run.js
run node --check crates/anima-desktop/frontend-dist/setup.js
run python3 -m unittest discover -s scripts -p 'test_*.py'

if [ "${1-}" != "--skip-desktop" ]; then
    # CI runs this as a separate macOS/Windows job; it is the slow one (Tauri).
    run cargo check -p anima-desktop
    run cargo clippy -p anima-desktop --all-targets -- -D warnings
    run cargo test -p anima-desktop
fi

echo "all quality gates passed (rust $active)"
