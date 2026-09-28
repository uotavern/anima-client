# Install Anima and connect to an Ultima Online server

Anima is an open-source UO client for macOS and Windows. You need the app, your
own Ultima Online game data, and an account on the server you want to join.

## 1. Download the desktop app

Use [GitHub Releases](https://github.com/hulryung-uo/anima-client/releases/latest)
for the current release. The v0.6.0 assets are:

| System | File | Installation |
|---|---|---|
| macOS, Apple Silicon (M-series) | `Anima_0.6.0_aarch64.dmg` | Open the disk image and drag Anima into Applications. |
| Windows, x64 | `Anima_0.6.0_x64-setup.exe` | Run the installer, then launch Anima. |

The macOS v0.6.0 release is signed and notarized. An Intel Mac binary is not
provided in that release; developers can use `scripts/build-app.sh --universal`
on macOS. Rosetta does not make an Apple Silicon app run on an Intel Mac.

## 2. Select your UO game data

Anima does not include the copyrighted game assets. Prepare your own UO client
installation with its `.mul` / `.uop` files. On launch, Anima attempts to locate
the data; if it asks for a folder, choose the client data directory, not the
Anima application directory. The app remembers the selection.

## 3. Connect to your server

Enter the server's hostname or IP address, login port, username, and password.
Get these details from your shard operator. After authentication, choose one
of the characters returned by the server. A new character needs an empty slot.

Anima does not operate a public shard or supply an account. Live verification
has focused on ServUO. Shards with custom protocols or assets may need additional
compatibility work. Confirm that your shard permits this client; use automation
only where the shard permits it.

## If something goes wrong

| Symptom | Check |
|---|---|
| The Mac app will not run | Confirm that your Mac uses Apple Silicon and that you downloaded the DMG from this project's release. |
| Missing terrain, art, or animation | Confirm that you selected the UO data directory and that the files match your shard's requirements. |
| Cannot log in | Check the hostname, port, server availability, account details, and shard client policy. |
| Login works but a feature fails | Report the exact action, client version, OS, server software, and any custom assets. |

[Report a bug](https://github.com/hulryung-uo/anima-client/issues/new?template=bug_report.yml).
Do not include passwords, tokens, or private account information. Existing
verification is recorded in [CLASSICUO_GAPS.md](CLASSICUO_GAPS.md).

## Browser client and AI development

These modes require local setup. The browser does not connect directly to a
UO TCP server: use the native `play` server, which the page talks to over HTTP.
Follow the exact commands in the
[root README](../README.md#build--run).

For AI players, start with the [architecture](DESIGN.md) and the
[versioned JSON contract](../crates/anima-contract-json). The external
[Python LLM agent](https://github.com/hulryung-uo/anima-agent) is a separate
repository; it uses this client as its game interface.
