# Anima — Ultima Online client for macOS and Windows

An **open-source Ultima Online (UO) client**, written from scratch in Rust.
Play on macOS or Windows, or build an AI player on the same headless game core.
The browser renderer, Tauri desktop app, and AI agents share one protocol and
world-state implementation.

**[Download the latest release](https://github.com/hulryung-uo/anima-client/releases/latest)**
· [Website](https://www.uotavern.com/client/)
· [Installation guide](docs/GETTING_STARTED.md)
· [한국어 소개](README.ko.md)
· [Contribute](CONTRIBUTING.md)

| Download v0.6.0 | Platform |
|---|---|
| [macOS disk image](https://github.com/hulryung-uo/anima-client/releases/download/v0.6.0/Anima_0.6.0_aarch64.dmg) | Apple Silicon (M-series); signed and notarized |
| [Windows installer](https://github.com/hulryung-uo/anima-client/releases/download/v0.6.0/Anima_0.6.0_x64-setup.exe) | Windows x64 |

Bring your own Ultima Online data files and a server account. Anima is a client,
not a shard or a game-data download. Live validation is against **ServUO**;
compatibility with every shard is not guaranteed. Intel Mac users need a source
build. See the [setup guide](docs/GETTING_STARTED.md) for requirements.

## Why try Anima?

- **Play UO on a Mac or Windows PC:** isometric terrain, animated characters,
  paperdolls, containers, spellbooks, vendors, audio, macros, and a world map.
- **Build AI players without parsing packets:** the headless Rust core exposes
  structured `Observation` / `Action` messages through a versioned JSON contract.
- **Explore a native + WebAssembly architecture:** one core powers the desktop
  app, the PixiJS browser renderer, and external agents, including Python brains.
- **Inspect and change the code:** MIT / Apache-2.0 licensed, with documented
  [compatibility work and verification limits](docs/CLASSICUO_GAPS.md).

![The Britain moongate: the blue portal inside its ring of standing stones, with
the world map and HUD alongside](docs/img/screenshot.png)

*The Britain moongate, live against a real ServUO shard. Genuine
`artLegacyMUL`/`anim` sprites in isometric projection, the minimap, and the HUD.
No pre-baked scene: every tile, sprite and animation frame is read from your own
UO installation and driven by real server packets.*

![The same street at night: the world is dark, the street lamp and a carried
torch light it](docs/img/night.png)

*The same street after `globallight 26`. Darkness, `light.mul`'s real
hand-drawn light shapes rather than circles, and a torch that lights from the
hand that carries it — with a wall able to block the glow behind it.*

> **Working on the code? Read [`docs/DESIGN.md`](docs/DESIGN.md)** — the full design & handoff
> doc (decision history, architecture, roadmap, protocol notes, references). This
> project is resumable from that doc alone.

## The Anima family

Four repositories, one idea: **AI characters that actually live in Britannia.**
This one is the body; the others are minds, and they are separate repos because
a brain should be replaceable without touching the thing that speaks the
protocol.

| Repo | What it is |
|---|---|
| **[`anima-client`](https://github.com/hulryung-uo/anima-client)** (here) | The **body**. Headless Rust core (`anima-core`) that logs in, keeps a live `World`, paths with A\*, and reads UO's own `.mul`/`.uop` files — plus the renderers on top: a browser client, a Tauri desktop app, and a human-playable `play` server. |
| **[`anima`](https://github.com/hulryung-uo/anima)** | The original **Anima / Foundry** work — an AI that *develops* AI players: it mutates their code, evaluates every variant against a live server, and keeps the best of each behavioural kind. Evolution, not just automation. |
| **[`anima2`](https://github.com/hulryung-uo/anima2)** | The next-generation Python **brain**: a fast reflex/planning/skill loop with optional slower LLM goals, conversation, and reflection. Reads observations and emits actions without parsing packets. [Project overview](https://www.uotavern.com/anima/). |
| **[`anima-agent`](https://github.com/hulryung-uo/anima-agent)** | A separate **LLM-first Python brain** experiment on the same contract. |

The split is the whole design. A brain receives an `Observation` and returns an
`Action` (`anima-contract-json`); it never sees a byte of the wire. That is what
lets a Python LLM agent, an evolved Foundry variant and a Rust in-process brain
all drive the same character through the same core.

> **Naming, because it trips people up:** the crate `crates/anima-agent` in THIS
> repo is not the [`anima-agent`](https://github.com/hulryung-uo/anima-agent)
> repo. The crate holds small in-process Rust brains (`WanderBrain`,
> `HunterBrain`, `LlmBrain`) used to exercise the contract from inside the
> workspace. The repo is the real LLM agent, in Python, on the other side of it.

## Thesis

This project is **core-first**: a headless game core (`anima-core`) is the primary
artifact, and the human-facing renderer is just *one* front-end among several.
The same core powers AI agents and the desktop app.

```
                  anima-core  (Rust — the headless heart)
                  net · world · assets · path     (NO rendering/UI/audio)
                                 │
                  anima-session  (Session: TCP driver, pathing, NDJSON bridge)
              ┌──────────────────┴──────────────────────┐
         anima-bridge                        anima-net play server + Tauri
              ▼                                           ▼
         AI agents                             desktop standalone
   (any language, headless)          (direct TCP, reads local UO data)
```

Cross-platform concern is isolated to the thin **renderer** layer; the core is
pure logic and platform-agnostic.

## Stack

- **Core:** Rust `anima-core` (sans-IO) → native agents and the desktop app
- **Renderer / UI:** plain JavaScript + PixiJS (2D isometric), WebGPU with WebGL2 fallback
- **Networking:** direct TCP from Rust (desktop app, bridge). The browser-only WASM
  client and its WebSocket relay were removed on 2026-09-29.
- **Packaging:** Tauri for standalone Win/Mac desktop

## Layout

```
anima-client/
├── Cargo.toml                 # Rust workspace
├── crates/
│   ├── anima-core/            # headless core: protocol, world, path, contract, gump layout
│   │                          #   (sans-IO, near-zero-dep: one exception, miniz_oxide,
│   │                          #   for the protocol-mandated 0xDD zlib)
│   │   └── src/{lib,types,agent,gump_layout}.rs · net/ · world/ · path/ · tests/golden.rs
│   ├── anima-assets/          # .mul/.uop readers: map/tiledata/anim/art/gump/hues/sound/…
│   ├── anima-contract-json/   # shared versioned Observation/Action JSON adapter
│   ├── anima-net/             # UI layer on anima-session + `anima-login`/`play`/`anima-agent`/`cmd` bins
│   ├── anima-agent/           # in-process autonomous brains (Brain trait, WanderBrain); bin `anima-brain`
│   └── anima-desktop/         # Tauri standalone shell (native TCP + embedded web renderer)
└── web/                       # plain JavaScript + PixiJS renderer (outside the Cargo workspace)
```

## Status

**Playable, and played.** A human can log in and play: real terrain, full
isometric sprites, resolved mobile and monster animation (legacy + UOP), gumps
(paperdoll, containers, vendors, spellbook, books, party), audio, secure
trading, macros, name plates, and a world map. An **autonomous brain** consumes
the same `Observation` and plays live.

Latest release: **[v0.6.0](https://github.com/hulryung-uo/anima-client/releases/latest)**
— signed and notarized on macOS, installable on Windows.

The work is measured against ClassicUO handler by handler and validated against
a live ServUO shard;
[`docs/CLASSICUO_GAPS.md`](docs/CLASSICUO_GAPS.md) is the honest ledger of it,
including — deliberately — what each change was **not** verified against.

Quality gates run in CI on every push: `cargo clippy --all-targets -D warnings`,
the workspace tests, and two that exist because of specific
bugs that shipped — one compiles every `web/js` file *together* in the page's
real load order (they share one scope, and a duplicate top-level `const` is a
SyntaxError that kills the client while `node --check` passes it), and one
*runs* them head-less in a fake DOM.

### Roadmap
1. ✅ **Phase 1 — headless core:** protocol, world, perception, movement, assets,
   A\* pathfinding, Observation/Action contract.
2. ✅ **Phase 2 — renderer:** live PixiJS renderer fed by the scene JSON. (It also
   shipped a browser WASM client, removed on 2026-09-29 as unused.)
3. ✅ **Phase 3 — AI + real art + human-playable polish:** brains play
   autonomously on the contract; the `play` server is a full human-playable
   client.
4. ⏳ **Ongoing — ClassicUO parity.** Tracked in
   [`docs/CLASSICUO_GAPS.md`](docs/CLASSICUO_GAPS.md), which is a record of what
   was done rather than a description of what is left; the way to find the next
   gap is to re-read ClassicUO against the shipped code.

## Build & run

```bash
cargo build && cargo test --workspace   # ignored tests require local real-data files
scripts/check.sh                        # every gate CI runs, in CI's order
# boot a local ServUO (port 2594), then pick one:
cargo run -p anima-net --bin play -- 127.0.0.1 2594 <user> <pass>  # human-playable (open :8090)
ANIMA_LOGIN=1 cargo run -p anima-net --bin play                    # same, but log in via the browser page
cargo run -p anima-agent -- 127.0.0.1 2594 <user> <pass> 40       # in-process Rust brain (bin: anima-brain)
cargo run -p anima-session --bin anima-bridge -- 127.0.0.1 2594 <u> <p>
                                          # headless NDJSON bridge for an external brain (anima2 /
                                          # anima3, over stdio): no UI linked, ~1.5 MB
cargo run -p anima-net --bin anima-agent -- 127.0.0.1 2594 <u> <p> # the same bridge, plus a read-only
                                          # web spectator when ANIMA_MONITOR_PORT is set
# watch an AI play in the web renderer: run the bridge with ANIMA_MONITOR_PORT=8011 and open :8011
```

The source build also has a **server and account library**: save several worlds,
keep separate account lists for each, remember passwords in the desktop OS vault,
and view cached server details beside the login form. See
[Server and account library](docs/LOGIN_PROFILES.md) for setup and runtime limits.
This is newer than the published v0.6.0 installers.

Browser login is a two-step flow: after account authentication, it shows the
character names and slots reported by the server. Choose one of those characters
to enter the world, or enable **Create a new character** and choose the name,
gender, profession, stats, and starting city. New characters use the account's
first empty slot without deleting an existing character; creation is disabled
when the server reports that every slot is occupied. Existing characters can be
deleted from the same list after an explicit irreversible-action confirmation;
the refreshed server list is displayed before any subsequent choice. **Back**
cancels the pending game-server connection and restores the account form.

ClassicUO compatibility work is tracked in
[`docs/CLASSICUO_GAPS.md`](docs/CLASSICUO_GAPS.md).

## License

Dual-licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE),
at your option — the Rust ecosystem's usual pairing, and what every crate here
has declared since the initial commit. The license *files* only arrived later,
which is why GitHub reported this repository as unlicensed for a while; the
declaration was never the missing part.

**This covers the code in this repository and nothing else.** Ultima Online's
data files (`.mul`/`.uop` — art, maps, animation, sound, clilocs) are
copyrighted by Broadsword/EA and are neither included nor redistributable: you
supply your own UO installation and point the tools at it (see the `play`
binary's `data_dir` argument). Nothing here grants any right to that content.

### Arena hotkeys

Press **O** for named, searchable hotkeys with editing, conflict checks, enable/
disable controls and mage/warrior duel presets. Existing bindings are preserved
when installing a preset. See [Arena hotkeys](docs/ARENA_HOTKEYS.md).
