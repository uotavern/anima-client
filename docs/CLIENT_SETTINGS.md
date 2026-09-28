# Client settings, backups and recovery

The source build validates renderer preferences before using them and exposes
**Settings & backups** at login. During play, use **Options → Settings data →
Backups & recovery**. Game-file setup and saved server/account profiles remain
separate; see [Game files](GAME_FILES.md) and [Login profiles](LOGIN_PROFILES.md).

## Persistence and recovery

Options, macros, map markers, quick buttons, counters, window geometry and HUD preferences are
stored in one versioned `anima.preferences.v1` browser-storage record. It belongs
to this browser/webview origin, including its port. Different native windows on
different ports therefore retain separate renderer preferences.

Older per-key preferences are read without changing them. The first successful
save migrates all recognized groups into the new record; the legacy values stay
untouched. Normal option changes preserve unknown fields and merge changed
options with the latest saved object. The account library and OS credential
vault are outside this record and outside settings exports.

The source now also validates and backs up `anima.winGeom`, which older builds
kept outside the envelope. A valid legacy position/size is adopted even if other
settings were migrated earlier. That adoption is recorded with the next save;
an explicit restore that omits geometry resets it to defaults without reviving
the untouched legacy value. Invalid geometry uses safe defaults and retains its
original for recovery. Each window type keeps its position and size; ordinary
saves reread the latest geometry so moving one window preserves other windows'
newer positions.

Window positions and resizable window dimensions now save per character in
`anima.characterWinGeom`, within the same preferences envelope. A character
without a saved layout starts from the common `anima.winGeom` defaults; its
first layout save copies those defaults and subsequent changes stay separate.
Panels initialized before login adopt the character's position and size before
the first world update. Dynamic windows restore when opened. The common layout
is preserved, and all character layouts participate in export, restore and
original-copy recovery. Restoring an older backup without character layouts
returns to the common defaults.

Native identity includes the configured host, port, shard index, account and
actual player serial. It survives reconnects and does not depend on a saved
launcher profile. (The browser WASM mode, removed on 2026-09-29, keyed layouts on
its relay URL instead.) Endpoint/account spelling changes can start a
new layout. The renderer stores a SHA-256 key, not the account name or endpoint;
passwords never participate. This hash is an identity key, not encryption.

The record supports up to 128 character layouts, subject to the existing settings
size limit. Invalid or oversized records remain recoverable instead of being
silently discarded. If Web Crypto is unavailable (for example, an insecure
non-local browser origin), the renderer uses the common layout. Layouts still
belong to their browser/webview origin; this does not synchronize native windows
on different ports. Macros, options, quick buttons, HUD/minimap positions and
other separately stored preferences remain common to that origin.

Seven new renderer regressions cover identity isolation, restart/backup,
initialized panels, failed writes, invalid records, relay binding and binding
before world updates. A native loopback login fixture verifies the transmitted
identity and excludes the fixture password. The complete local gate passed
(370 renderer tests / 1845 assertions); logs are
`/tmp/anima-character-layout-tests.log` and
`/tmp/anima-character-layout-final-gate.log`. This is source work newer than
v0.8.2; current installed-app and live-character switching remain unverified.

Invalid types, out-of-range options and malformed arrays use safe defaults or
retain valid entries. A macro with an invalid step is skipped as a whole, so
half of a damaged command sequence cannot run. Loading macros never executes
them. Restored quick buttons and panel positions are clamped into the viewport.

If storage is unavailable or full, the renderer continues and shows a warning.
Changes remain in memory; **Retry saving** retries them. Invalid saved data is
not overwritten by ordinary changes. At login, **Keep original & recover**
replaces invalid entries while retaining valid preferences and pending edits.
The replacement and the original values are written in a single storage update.
A failed write leaves the existing record unchanged.

## Transfer settings

**Export settings** prepares `anima-settings.json`. An explicit **Save** link
stays available while the dialog is open. The desktop downloader accepts only
settings JSON blobs from the active loopback renderer and saves them in Downloads;
other origins, filenames and destinations are rejected. Desktop download
completion or failure is shown in the dialog.

Select a settings backup (up to 4 MB) to review its filename, stored groups,
macros and markers. Invalid values, unknown storage groups and unsupported file
versions reject the whole import. **Apply backup & reload** is available at
login; log out before restoring. Applying replaces all renderer preferences,
so groups absent from the file return to defaults. A stale preview cannot
overwrite settings changed after it was opened.

The most recent recovery/restore retains one previous copy. **Review previous
settings** can restore a valid copy; **Download recovery copy** preserves original
values for inspection even when they are damaged. A corrupt whole record is
preserved as its exact original string. This is a single previous copy, not an
unlimited history. Keep exported backups for longer-term recovery.

## Verification status — 2026-09-13

Implemented, with the complete local quality gate passing, including lint,
native compilation, WASM compilation and 333 web tests. Tests cover storage denial, quota failure, validation,
legacy migration, original-data retention, previous-copy restore, stale review,
late file reads, live-session guards, explicit download links and native download
origin/path restrictions.

Window-geometry regressions reproduce the earlier `null`-geometry failure that
prevented dialogs from opening, and verify position/size export and restore,
late adoption into an existing settings record, omitted-group defaults,
concurrent-window merges, failed saves and offscreen position clamping. These
are headless renderer tests; actual native resizing/layout checks remain open.

Chrome showed a real renderer boot with deliberately invalid legacy options,
the warning/recovery dialog, and a successful recovery/reload to login. The
captured screen uses a disposable local fixture and no real account. The macOS
QA app bundle also built successfully.

**Native macOS file import/export and previous-copy restore are now verified.**
A fresh isolated source build used the native picker to restore a four-group
backup, reloaded to login, and exported an actual Downloads file retaining its
options, macro, marker and supplied geometry. Restoring the previous copy then
exported the earlier data to a separate filename without overwriting the first
backup. The downloaded four-group file also passed the native import preview
and its second application reloaded successfully to login. A full app restart
remains unverified. See [the native verification record](NATIVE_BACKUP_VERIFICATION.md).
Chrome file selection remains subject to the extension's file-access permission.
Windows interactive checks and actual game-window resizing remain open.

This source change is not included in the published v0.6.0 installers. The
geometry improvements are also newer than the tagged v0.7.0 draft installers. The
[readiness audit](CLIENT_READINESS.md) tracks the broader outstanding work.
