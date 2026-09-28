# Server and account library

The login screen keeps a library of worlds on the left, the selected server and
account in the middle, and a server notebook on the right. This feature is in
the source build; it is not part of the previously published v0.6.0 installers.

## Connect and remember

1. Select a saved server, enter your **Account name** and **Password**, then
   choose **Connect**. A shard that supports automatic account creation receives
   that same ordinary login request; there is no separate registration step.
2. For a new or changed local profile, choose **Save & connect** or **Connect
   without saving**. **Back** or Escape returns to the form without connecting.
   Password storage is a separate optional checkbox, available only on desktop.
   Unchanged saved accounts connect without another prompt or profile rewrite.
3. **Use another** clears the account fields for another login on the same
   server. It does not create a server account. The saved-account picker scopes
   accounts to the selected world.
4. **Server settings** holds the address, optional name, notes and shard index
   (normally 0). It opens when adding a server and stays folded for saved worlds.
   **Manage saved account** holds the optional nickname and explicit save/remove
   controls. The nickname defaults to the account name and is never a login field.
5. After authentication, choose a character in the existing character picker.
   Returning with **Back** shows the account form again.

These are local profiles, not new accounts on the game server. **Remove** only
removes the saved profile from this device; it never deletes a game account or
character. The last selected server and account are restored for this window's
origin. Account/server data is shared across native windows and survives a port
change; window selection follows the existing per-origin preference storage.

## Connection progress and recovery

The login screen reports address lookup, TCP connection, authentication and
character-response progress. **Cancel connection** abandons that attempt and
returns to your saved profiles. Cancelled attempts cannot affect a newer login.
Progress and action buttons remain visible while the login form scrolls.

Native address lookup and dialing have an 8-second caller deadline, with a
separate bounded advertised game-server dial. Each server-response phase has a
20-second deadline, even if the server sends only part of a packet. Choosing a
character is not timed out while you decide; its response deadline starts again
when you submit. OS DNS resolution may finish in the background after cancellation;
that worker receives only the destination, never account credentials.

If the page loses contact with the native client, a **Client connection
interrupted** notice pauses input and macros. Scene requests retry automatically
with backoff; **Retry now** checks immediately. Recovery restores keyboard focus,
without replaying held keys or restarting a macro. Reopen Anima if its process
has stopped. A lost game-server session returns to sign-in; it does not silently
authenticate again.

Source after v0.8.3 also associates failed logins with the destination and
account actually submitted. Changing the selected server, shard or account hides
the previous target's error on the next scene update. New
failures on the current target remain visible, even with identical wording.
Global startup errors and older backend responses without target metadata
continue to display normally. Passwords are not included in error metadata.

In current source (newer than v0.7.0), native windows also detect a changed game
connection when polling misses the intervening sign-in screen. They clear input
and reload once before displaying the new world, even if the new server reuses
the same character number. Input already in flight cannot apply to the new
connection. Character selection, creation, deletion and Back are bound to the
particular list that was displayed; another account or a refreshed list resets
the selection and unfinished creation form. Late replies cannot change that new
form. This is covered by headless renderer and loopback protocol/HTTP fixtures;
current-build live-shard re-entry and interactive desktop checks remain.

## Optional passwords

In the macOS and Windows desktop app, check **Save password on this device**.
Passwords are stored through the OS vault (macOS Keychain / Windows Credential
Manager). The native process resolves the password when connecting; the page
receives a saved-password indicator, never a password getter.

A blank password field reuses a saved password. Typing a replacement and saving
updates it. Uncheck the option and save to remove the stored password. Removing
an account or server also removes its saved passwords. Changing a host, port or
shard clears saved passwords and cached character names so an old credential
cannot silently follow an edited destination. Vault failures are shown on screen.

Profile saves prepare and sync the replacement file before changing passwords.
If a password operation or the final file replacement fails, Anima attempts to
restore every affected password and leaves the original profile file in place.
If the vault also refuses recovery, the error asks you to unlock it and save
the affected passwords again. Temporary profile files contain no passwords and
are removed after a failed save. Saves also enforce the same 1 MB limit as reads,
so an oversized cache cannot make the next launch's profile file unreadable.

Server/account metadata lives in `launcher.json` in Tauri's app-config directory,
separate from the desktop configuration. Writes lock and reread the file before
atomic replacement so multiple windows cannot overwrite unrelated profiles.
Malformed or newer-version files are left untouched and reported. The file
contains usernames, notes and character names, so keep backups private. Passwords
are not included in a profile backup and must be saved again on another device.
This protects passwords at rest; it does not change UO's existing network protocol.

## Worlds backups and profile recovery (unreleased source)

These additions are newer than the tagged v0.7.0 installers. Build the current
source to test them. The login library's **Worlds & accounts backup** section
provides **Export worlds**, a file picker with a preview, and **Add from backup**.
The JSON contains server names, host/port/shard, notes and account labels/usernames.
It excludes passwords, vault identifiers and cached server/character information.
Keep the backup private: usernames and private shard addresses are still included.

Import adds missing entries without replacing existing ones. A server matches
when its name, host, port and shard match. Named groups sharing an address
therefore survive a round trip.
Accounts match by username within that server. Existing notes, labels, cached
details and saved passwords remain intact. Repeating an import adds no duplicates.
New accounts get fresh identifiers and require their passwords to be entered
again, even on a device where older vault entries still exist. A backup made by
the removed browser WASM mode can include a relay URL; import accepts it and
native TCP ignores it. Import never logs in or probes a
server. The maximum is 100 servers, 500 accounts and a 1 MB backup file.

A malformed, structurally invalid or unsupported-version `launcher.json` now
leaves the login/recovery screen available. Ordinary saves still reject it.
**Keep original & recover profiles** asks before resetting the library; it writes
and syncs an exact, private `launcher.recovered-*.json` copy beside the original
before replacing the active file. The screen reports the copy's location. If
staging or copying fails, the active file stays untouched. A file that another
window has already repaired is not reset. Files larger than 1 MB are left
untouched and need to be moved to a safe backup location before retrying.

Recovery preserves OS-vault entries because corrupt metadata cannot reliably
identify which credentials belong to which profile. Browser recovery keeps the
exact original in a separate `anima.launcher.browser.v1.recovered-*` storage key;
storage/quota errors stop recovery before the active record changes. A worlds
backup restores account metadata afterward; it is not an export of the original
damaged bytes or a transfer of passwords. **Settings & backups** remains usable
when account profiles cannot load, so renderer preferences can also be repaired.

The new fixture tests cover portable round trips, named aliases, repeated imports,
existing credentials, concurrent-window updates, invalid/failed imports and exact
recovery copies. Actual loopback HTTP checks verified startup with corrupt
profiles, recovery, an import/export larger than the old 16 KB request limit,
repeat imports, cross-origin/header rejection and body limits. No game server was
contacted. A subsequent isolated macOS source build verified native UI recovery
with an exact 0600 original copy, native file-picker import of two servers and
three accounts, a completed download matching those profiles, and reimport of
that downloaded file without duplicates. See
[the native verification record](NATIVE_BACKUP_VERIFICATION.md). Full app restart,
Windows interactive backup/recovery and installed-release checks remain open.

## Server notebook

**Check server** makes an account-free TCP connection and caches reachability and
connection latency. Compatible RunUO/ServUO public status replies can also supply
server name, reported client count and uptime. A reachable port is not a guarantee
that account login will succeed. The timestamps distinguish the latest connection
check from previously cached server details; failed or unsupported status queries
preserve older reported details. Checks are manual and briefly rate limited.

The selected account's last authenticated character list is cached separately.
It is a preview: authenticate again to get the current list before choosing a
character. A status check never sends an account or password.

## Other runtimes

- `ANIMA_LOGIN=1 cargo run -p anima-net --bin play` saves non-secret profiles in
  `$HOME/.config/anima-client/launcher.json`. Set `ANIMA_PROFILE_DIR` to use an
  isolated folder. This development server does not enable OS password storage.
- Native profile endpoints require a loopback peer, a literal loopback Host,
  same-origin requests and `X-Anima-Launcher: 1`. They are unavailable to LAN
  visitors even if the development server itself is exposed with `ANIMA_BIND`.

## Validation

The quality gate covers Rust formatting, strict Clippy, Rust tests,
JavaScript syntax/shared globals, the renderer suite and desktop compilation.
Regression tests cover persistence, concurrent windows, credential isolation,
endpoint changes, vault failures, character cache invalidation and public status
parsing with a loopback fixture. The macOS vault roundtrip was also run with one
isolated test credential, then removed. Chrome UI checks used disposable profiles
for two servers and three accounts: saving, switching, reload restoration, notes,
status caching, failed-login recovery, and narrow-window layout (580px / 390px).
The real ServUO instance was offline; no live character login was claimed.
The explicit profile lifecycle test also passed against Windows Credential
Manager on the Windows CI runner for the v0.7.0 source commit (`10aa945`). This
verifies OS-vault calls and profile persistence, not the interactive Windows UI.

Password persistence regressions additionally cover failed file staging, failed
final replacement, partially failed multi-account deletion, failed rollback, and
moving an account between two saved servers with the same endpoint. An isolated
macOS Keychain integration test verifies actual profile save, reuse after restart,
replacement, preservation after a file-write failure and deletion. All test
credentials and profile files are removed afterward. Run it explicitly with
`cargo test -p anima-desktop native_profile_password_lifecycle -- --ignored`;
macOS CI leaves it opt-in. Windows CI explicitly runs it with one disposable
runner credential, which is removed by the test. This exercises the OS API and
profile lifecycle, not the Windows login UI. The launcher fixture suite also
runs on both macOS and Windows CI.

The rollback handles reported operation failures while the client is running;
the filesystem and OS vault do not offer a shared transaction across a sudden
process termination. No plaintext password journal is written to disk.

Connection recovery was additionally checked with isolated loopback protocol
fixtures: cancellation during DNS/authentication, partial-packet timeout, both UO
login phases, and human character-choice time excluded from the deadline.
HTTP checks confirmed an old cancellation ID cannot stop a newer attempt.
Chrome checks covered cancellation/retry, a 580px-wide window, and stopping and
restarting only the disposable native client: the interruption notice appeared,
background keyboard access was disabled, and recovery restored the selected
profile and focused field. These are fixture/UI checks, not live-shard gameplay
or Windows runtime validation.
