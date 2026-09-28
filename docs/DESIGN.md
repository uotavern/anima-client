# anima-client — Design & Handoff

> **Purpose of this document:** make the project resumable from docs alone. A new
> Claude session (or human) should be able to read this and continue without the
> original chat. It captures *why* every major decision was made, the target
> architecture, the current state, the roadmap, and the concrete protocol/asset
> knowledge needed to implement Phase 1.

Last updated: 2026-08-22 · Status: **Phases 1–3 COMPLETE, including the Phase 3
"human-playable polish" tail** (iso sprite blitting, walk/attack/typed animations
incl. UOP + monster body remap, gumps, audio, secure trading, AI contract). 8 crates
(anima-core / anima-assets / anima-contract-json / anima-net / anima-wasm /
anima-agent / anima-desktop / anima-relay) + web/; workspace tests and quality gates are green (including 7 golden-packet
regression tests replaying real `uo_proxy` captures, §7); real-data-file tests are
`#[ignore]`d by default; wasm32 builds.
- **Phase 1:** headless agent connects to a live ServUO, logs in (create + select),
  builds a World, and navigates to a target tile by A* over real UO map data.
- **Phase 2:** `anima-core` → **wasm32** (sans-IO pays off); `anima-wasm` wraps it for
  the browser; a **web/PixiJS renderer** draws a live minimap + HUD from the same
  `Observation` the AI consumes (scene bridge). Screenshot-verified.
- **Phase 3:** (a) an **autonomous AI brain** (`anima-agent` `WanderBrain`) consumes
  `Observation` and emits `Action` — explores, greets speakers, flees reds, grabs
  items — verified playing live on the server (the AI-native loop, the project's
  thesis); `Session::advance_route` gives any headless driver a non-blocking
  `Action::WalkTo` (click-to-walk) state machine, no sockets. (b) the renderer draws
  **real UO terrain and full isometric sprites**, not just avg colors — see below.
**Playable milestone:** a human can now actually play top-down UO end-to-end — move,
fight, loot, trade, shop, cast, read books/spellbooks, work gumps (multi-page,
stack-split, paperdoll), party, chat, hear sound/music. `anima-net`'s `play` bin
holds a live Session, serves `web/` + `/scene.json` over HTTP (tiny_http, plus an SSE
sound stream on its own thread so it can't starve the worker pool), and accepts
`POST /input` executed on the matching live session. Native scenes carry an
opaque `sessionId`; `/input` requires it in `X-Anima-Session` and checks it again
when draining queued commands. A changed ID reloads the native renderer before
the new world is assigned, even if polling missed the login screen. Sound SSE
events carry the same ID. Interactive `/character` JSON requires `choice_id`
from that specific character-list scene; each prompt gets a new ID and stale
queued decisions are discarded. Login cancellation's `attempt_id` is also an
opaque string, distinct across attempts and process restarts. These identifiers
correlate requests; existing origin/loopback checks still control access.
Run: `cargo run -p anima-net --bin play
-- 127.0.0.1 2594 <u> <p>` then open `http://127.0.0.1:8090/` (all args are optional
— omitted ones fall back to the baked-in defaults `127.0.0.1:2594`
`animaplay`/`animaplay` and auto-login proceeds immediately; set `ANIMA_LOGIN=1` to
instead serve a browser login page that collects server/account, authenticates,
then shows the server-provided character names before the user chooses an
existing character or creates a new one on the same connection).

**Isometric renderer:** the web client draws **real UO tile sprites in iso
projection** — `anima-assets::art` decodes land (44×44 diamond) + static (RLE) art
and PNG-encodes it (`Image::to_png`); the `play` server serves `/art/land/<g>.png`
and `/art/static/<g>.png` (cached); the scene includes per-tile land graphic + a
window static list; `web/main.js` streams those textures and draws the diamond
field + statics (grass, roads, water, buildings), falling back to avg-color diamonds
while textures load. Multi-floor visibility (roof/upper-floor culling by the
player's Z) is ported from ClassicUO — see `docs/RENDERING.md`. Screenshot-verified.
Texture retention now uses count/estimated RGBA budgets with live URL and actual
stage-source protection; asynchronous Pixi unloads gate same-URL reloads. Alpha
hit masks follow texture lifetime, and animation metadata has bounded retention
and retryable failures/deadlines. See `docs/GRAPHICS_CACHE.md` for the actual
Pixi/Chrome verification and the limits of these resource estimates.

**Mobile sprites & animation (COMPLETE — legacy + UOP, remapped):**
`anima-assets::anim` resolves a body's real animation through the full ClassicUO
pipeline, not just the raw legacy math: **`Body.def`** remap (exotic body → real
body + fallback hue), **`Bodyconv.def`** redirect (body → expansion file
anim2..anim5), **`mobtypes.txt`** group kind (monster/animal/people, authoritative
over the graphic-range heuristic), **`Corpse.def`** (a corpse item draws the dead
creature's real death-pose sprite, not generic corpse art), and **`Equipconv.def`**
(gender/body-specific worn-equipment animation + paperdoll gump). ~300 bodies are
flagged `UseUopAnimation`; **`AnimationFrame1-4.uop`/`AnimationSequence.uop`** are
read via a lazy, on-demand `LazyUopReader` (only the entry table + the one entry
requested — the four files total ~500MB and must never load whole), with the legacy
`anim.mul..anim5.mul` files as fallback. The `play` server serves
`/anim/<body>/<group>/<dir>/<frame>.png`; the renderer plays walk/run/idle/combat/
typed (0xE2 emotes/gestures) animation cycles timed to real step cadence, mounted
riders show `Onmount*` groups with the mount's own body drawn under them
(`anima_assets::mounts` table), and worn equipment/paperdoll pieces render
gender-correctly.

**Gumps (COMPLETE):** the gump layout grammar (`{ button … }{ text … }…`) is parsed
into typed elements in `anima-core::gump_layout` (protocol data, not rendering, so a
brain can consume it directly via `Observation`); `anima-net::scene` reuses the same
parser for the web JSON. Multi-page gumps track a per-window local page (page-jump
buttons never round-trip to the server, matching ClassicUO); buttons render their
real `up`-state gump art instead of a numbered box; paperdoll/backpack/container/
vendor buy-sell/spellbook/skills(sort + T2A/AOS grouping)/books/party/stack-split-
on-drag are all implemented over `gumpartLegacyMUL.uop`.

Everything above was previously listed as the Phase 3 "tail" — it is now done, as
are the Tauri standalone shell (`crates/anima-desktop`), `multi.mul` dynamic house/
boat placement (`anima-assets::multis` + the scene/walkability fold), sitting,
treasure maps, and **custom housing** (0xD8 viewing: plane parse/zlib → deferred
mode-0/1/2 decode against multi.mul bounds → design tiles replace the foundation's
components in both scene emission and the walkability fold; auto 0xBF/0x1E refresh
on 0xBF/0x1D revision notices; live-verified against ServUO placement → DesignInsert
→ delete). Richer brains (`HunterBrain` / `LlmBrain`) and the browser WASM isometric
page (`/?wasm=1` + `anima-relay` + `anima-net --bin assets` `/terrain.json`) are
done too — see §6.
delete-character (0x83) is done too: `build_delete_character` (30 zeroed bytes —
NOT the password, ClassicUO parity) + a `LoginConfig::delete_existing` flow that
deletes-once then re-runs select/create against the refreshed 0x86 list, with 0x85
DeleteResult reasons mapped (live-verified: ServUO accepted the 0x83 and answered
CharTooYoung per its Accounts.cfg RestrictDeletion/DeleteDelay policy).

### Verified end-to-end against ServUO (127.0.0.1:2594)
- Two-phase login: account → server select → reconnect → game login → **char create**
  (new account) and **select** (re-login) → LoginConfirm. Real serial/pos returned.
- Huffman decompression + framing of the live compressed game stream.
- Perception: 0x11 status (name/hp/stats matched the created character), items, journal.
- Movement: walk requests (0x02) with sequence + confirm(0x22)/deny(0x21) + resync.
- Asset readers: UOP map + tiledata + statics parsed against real data — the spawn
  tile's Z (14) matched the server's login Z exactly.
- **Capstone:** `navigate_to` walked the avatar (3503,2574)→(3493,2564) on the live
  server via A* (22 confirms, 2 denies → blacklisted + routed around). ARRIVED ✓.
- Gotcha learned: the server **denies movement until the client answers the 0xBD
  ClientVersion request** — handled in the session.

### How to run it
```
cd ~/dev/uo/servuo && MONO_GAC_PREFIX=/opt/homebrew nohup mono ServUO.exe -noconsole &
cd ~/dev/uo/anima-client
cargo run -p anima-net -- 127.0.0.1 2594 <user> <pass>   # auto-creates the account
```

---

## 1. What we're building (one paragraph)

A **new, from-scratch Ultima Online client**, designed **AI-native** and
**cross-platform (Windows + macOS)**. It is the companion "body" for the
[`anima`](../../anima) AI-player project. The central artifact is a **headless
game core** (`anima-core`, Rust) that speaks the UO protocol and maintains world
state with **no rendering/UI/audio**. A thin renderer (web: PixiJS — implemented as
plain JS, no TS build step) sits on top for humans. The same core serves three consumers: AI agents
(headless, many), a browser client (core compiled to WASM), and a desktop
standalone app (Tauri, native TCP).

---

## 2. Decision history (the *why* — do not re-litigate without reason)

These were settled deliberately over a long design discussion. Each row is a
decision + the reasoning so a future session understands the constraints.

| # | Decision | Why |
|---|----------|-----|
| D1 | **Structured observation/action, never pixels/vision** | AlphaStar & OpenAI Five both used structured game-state interfaces, not pixels, for performance + scale. UO exposes full game state in packets, so vision adds nothing but cost/brittleness. |
| D2 | **Separate two layers: Interface (body) ⊥ Brain (decision)** | Lets us swap brains (scripted/RL/LLM) and backends independently. The boundary is an explicit Observation/Action contract. |
| D3 | **Core ⊥ Renderer split; core-first** | ClassicUO is 152k LOC, ~40% of which (Game/UI gumps alone = 50k, ~33%) is throwaway for an AI. The AI-relevant core is ~40k LOC. Making the headless core the primary artifact is the whole reason to build new vs fork. |
| D4 | **Build new instead of forking ClassicUO** | User wants a *serious* AI-native client where the headless core is first-class and reused across agents/browser/desktop. ClassicUO can't give that cleanly (human-first, GPU-coupled init). |
| D5 | **Language = Rust for the core** | One codebase compiles to **native** (agents, desktop) *and* **WASM** (browser). No-GC perf + strong concurrency for many parallel agents. Graph-y world model handled via HashMap-by-serial now, `slotmap`/ECS later. |
| D6 | **Frontend = Web (TypeScript + PixiJS), WebGPU + WebGL2 fallback** *(implemented as plain JS, no TS build step)* | User chose web. Cross-platform by definition; PixiJS is a battle-tested 2D isometric renderer that cuts rendering plumbing. WebGPU is Metal-backed on Mac (no Apple GPTK needed). |
| D7 | **Standalone via Tauri (desktop) + optional browser (PWA)** | User wants standalone. See the TCP constraint (§4): only a native shell can open raw TCP, so desktop standalone is self-contained; pure browser needs a relay. Same web frontend ships both ways. |
| D8 | **Apple Game Porting Toolkit is NOT used** | GPTK ports *existing Windows/DirectX* games to Mac (DXIL→Metal shader conversion, Wine-style eval env). For a new cross-platform build you target Metal natively via wgpu/WebGPU — there's no DirectX to translate. |
| D9 | **`anima-core` is the name** (was tentatively `uocore`) | User's choice. It's the headless heart, not a separate product. |
| D10 | **Sans-IO protocol core** — `anima-core` never touches a socket | Maintainability + the WASM requirement (D5). Protocol logic is pure (feed bytes → get packets/events; produce bytes to send). The actual TCP/WebSocket loop is a thin shim *outside* the core, injected per platform. Makes the whole protocol unit-testable from byte vectors and identical on native/WASM. The login handshake is a `LoginMachine` that emits `LoginDirective`s the driver executes. |
| D11 | **Every server-driven dialog is declared, not hand-refreshed** (`web/dialogs.js`) | `scene.json` is POLLED, so a snapshot BUILT BEFORE our reply reached the server still lists a dialog the player just answered. Every dialog family therefore needs the same four steps (record on close → skip while dismissed → drop the record once the item leaves the snapshot → don't mistake a genuinely NEW dialog for the dismissed one), and 13 hand-written copies of that had drifted: generic gumps and trade windows were missing them, so closing those visibly popped the window back for one poll (measured: 290ms). Families now `registerDialog({source, key, sig, open, dismiss, build, update, close})` and `syncDialogs(scene)` drives all of them once per poll. The per-family quirks are named policies, not escape hatches — `open: "list" \| "seq" \| "local"` and `dismiss: "content" \| "session" \| "none"` — so a new dialog can't silently omit the guard. |
| D12 | **Seasonal graphic remap substitutes DRAW fields only; we deliberately diverge from ClassicUO on pathing** (`anima-net/src/scene/season.rs`) | UO ships one map plus `seasons.txt`, a client-side table that swaps a tile's graphic for a seasonal twin (grass→snow, green tree→bare). ClassicUO stores that substitution *in* the object's `Graphic` and then indexes tiledata with the remapped id everywhere — including `Pathfinder.CreateItemList` — so it pathfinds on substituted flags, and 29 of 312 winter land rows flip IMPASSABLE. ServUO's `MovementImpl` reads the RAW ids and never consults `Map.Season`, so following ClassicUO here would make the client disagree with the server about walkability. We therefore keep the remap out of `World` (the single source of truth for pathing and the agent contract, D3) and apply it only when writing a scene DRAW field, emitted as a sibling `dg`/`tx` never rebound into the tile struct that also carries `flags`/`z`. A `#[ignore]`d regression asserts no pathing byte moves across a season change; the naive rebind fails it. The winter table is the only one that touches land and is unreachable by GM command, so an `ANIMA_SEASON` client-side override exists to exercise (and fault-inject against) it. |
| D13 | **Saved profiles belong to the native shell/driver, secrets to the OS vault** (`anima-net::launcher`, `anima-desktop::credentials`) | Multi-server/account login needs persistent metadata without coupling the sans-IO core to files or credential APIs. Typed `serde` profiles are locked, reread and atomically replaced; the desktop injects `keyring` (macOS/Windows native backends). The page sends an account ID and native login resolves the bound endpoint and secret. Endpoint changes clear saved passwords. Manual public status probes and authenticated character lists are cached with timestamps. Browser WASM stores only non-secret profiles. See `docs/LOGIN_PROFILES.md`. |
| D14 | **Connection lifetime belongs to transport adapters, not the protocol core** (`anima-net::connection`, `web/js/04-connection.js`, `14-wasm.js`) | One attempt has one cancellation identity. Native DNS/dial workers receive only the endpoint; cancellation shuts down the active socket, deadlines bound server waits, and human character choice gets no deadline. Native scene polling is serialized and late responses cannot replace newer state. WebSocket callbacks carry attempt identity, and ended WASM clients are freed. The page pauses input on transport failure and shows recovery controls. Full product readiness still requires the separate live/runtime audit in `docs/CLIENT_READINESS.md`. |
| D15 | **Validate game files before saving; preserve unreadable app settings** (`anima-net::uo_dir::check`, `anima-desktop::config` / `setup`) | The native setup window checks the readers and formats that play actually supports, requires an explicit first selection, and keeps folder changes pending until restart. Its Tauri commands are restricted to that local window; the loopback game page cannot invoke them. Configuration updates lock and reread before atomic replacement; recovery first backs up the original bytes. Server/account profiles and OS passwords stay separate. See `docs/GAME_FILES.md`; a startup check is not a complete asset-integrity scan. |
| D16 | **Renderer preferences have one atomic storage record and typed readers** (`web/storage.js`, `preferences-ui.js`) | Direct storage access and unchecked JSON could abort boot or pass invalid values to audio/input. A guarded adapter validates known groups, keeps pending changes during storage failures and preserves originals on explicit recovery. Legacy keys remain untouched; a restore replaces one record with its previous-copy snapshot in the same write. Export/import exclude the account library and credential vault. Native downloads are scoped to settings blobs from the active renderer and its Downloads directory. Actual file-transfer runtime evidence is still required; see `docs/CLIENT_SETTINGS.md`. |

Release integrity (D17): a version tag must match the app manifest and release
notes. Resolve it to one commit and reuse the shared CI workflow for that commit
before building either installer. Assemble a draft only after both final
installers match their platform, source commit, size and SHA-256 manifests.
Check signatures/notarization before hashing; reject partial signing setup and
updates to an already public release. Runtime verification is a separate
requirement, recorded in `docs/CLIENT_READINESS.md`.

Profile persistence follow-up (D13): stage and sync non-secret metadata before
applying OS-vault changes, retain previous credentials only in memory, and undo
them when an operation or the final file replacement fails. An unavailable vault
during rollback is reported explicitly. This handles ordinary errors, not a
cross-store atomic transaction through process termination. Fixture tests cover
both failure phases and partial deletion; the explicit native integration test
exercises macOS Keychain with a disposable profile.

### Rejected / deferred

- **Forking ClassicUO headless** (strategy A/B from the discussion): viable and faster to a working agent, but rejected in favor of a clean new core (D4). Still a useful *reference* (§7).
- **Go for the core**: simpler concurrency but weaker WASM story and no shared-language renderer. Rust won (D5).
- **Full client port** (rendering included): bad ROI (~40% wasted). Never do this.

---

## 3. Target architecture

```
                  anima-core  (Rust — the headless heart)
                  net · world · assets · path     (NO rendering/UI/audio)
        ┌──────────────────┼──────────────────────┐
   native lib            WASM                  Tauri backend (native)
        ▼                  ▼                        ▼
   AI agents          browser client          desktop standalone
   (many, headless)   (anima-core = WASM       (Tauri: direct TCP,
                       + WebSocket relay)       reads local UO data)
```

- **anima-core** — protocol, world state, asset (`.mul`/`.uop`) IO, pathfinding. Pure logic, platform-agnostic.
- **Renderer** (web/PixiJS — implemented as plain JS) — the *only* place cross-platform graphics concerns live. Reads world state, draws; sends user intents back.
- **Brain** — decision-making (AI or human input) lives *above* the core, never inside it.

### The Observation/Action contract (the Interface↔Brain boundary, D2)
Codified in `anima-core::agent`; its versioned JSON representation lives in
`anima-contract-json` and is shared by the native NDJSON bridge and WASM. Shape:
- **Observation** (core → brain): player state (pos/hp/mana/stam/skills), nearby mobiles & items, journal deltas, war/hidden flags, targeting/gump prompts pending.
- **Action** (brain → core): move(dir, run), use/double-click(serial), attack(serial), cast(spell), say(text), target(serial|xyz), pickup/drop/equip, gump-response.
Keep it a stable schema so scripted/RL/LLM brains and the native/WASM backends all plug into the same thing.

### AI training layers (context for later, not Phase 1)
From the design discussion — when the AI side is built, structure it as:
- **Play plane** = the Observation/Action contract above (normal player surface).
- **Control plane** = scenario control for repeatable curriculum/RL: reset, teleport, grant items, set skills, measure. *This needs a GM account or server save/restore — a UO client is "just a player" and can't do it alone.* The existing `anima` Foundry kernel already implements a GM control plane; reuse/formalize it. Keep it OUT of both the core and the brain — it's a separate component.
- **Director/Curriculum** = automatic curriculum (Voyager-style task proposal) + skill library. Sandbox UO has no reward gradient, so a curriculum + LLM priors (the `anima` companion wiki = the "textbook") is the fastest accelerant — faster than gradient RL. In-game New Haven tutorial = free curriculum stage 0 (reachable via the play plane, no GM).

---

## 4. The defining constraint: browsers can't open raw TCP

UO is raw TCP. Browsers forbid arbitrary TCP sockets. This drives the
standalone/relay split:

- **Desktop (Tauri):** the Rust backend opens TCP directly → fully self-contained standalone. **Recommended primary target.**
- **Browser:** needs a thin **WebSocket↔TCP relay** (dumb byte pump; protocol parsing still runs in-browser via `anima-core` WASM). Not fully standalone (relay required) but zero-install.

**Assets reinforce this:** UO `.mul/.uop` files are large and copyrighted (Broadsword/EA) — cannot be redistributed. Users must supply their own UO install. Desktop reads local files natively (easy); pure browser needs the Chromium-only File System Access API (Safari/Firefox gaps) or manual upload. → another reason desktop standalone is the cleaner primary.

**Tauri vs Electron caveat:** Tauri uses the OS webview (WKWebView on Mac = Safari engine), so WebGPU/API maturity can lag Chrome. Mitigate with a WebGL2 fallback, or use Electron (bundles Chromium → consistent rendering, larger binary). Decide when the renderer starts.

---

## 5. Repo layout & current status

```
anima-client/
├── Cargo.toml                 # Rust workspace (8 members, see below)
├── README.md · CLAUDE.md · .gitignore
├── docs/DESIGN.md · RENDERING.md · MOVEMENT.md
└── crates/
    ├── anima-core/            # headless protocol + world + path + contract (near-zero-dep —
    │                          #   one exception: miniz_oxide, for the protocol-mandated 0xDD zlib — sans-IO)
    │   ├── src/
    │       ├── lib.rs · types.rs        # Serial, Position, Direction
    │       ├── agent.rs                 # Observation/Action contract + World::observe + Brain trait
    │       ├── gump_layout.rs           # gump layout grammar → typed GumpElements (brain-consumable)
    │       ├── net/
    │       │   ├── packet.rs            # big-endian reader/writer
    │       │   ├── lengths.rs           # packet-length framing table
    │       │   ├── framing.rs           # frame decoder + game-mode (Huffman) + StreamDecoder
    │       │   ├── huffman.rs           # server→client decompression
    │       │   ├── login.rs             # builders/parsers + LoginMachine (+ char create)
    │       │   ├── game/                # game packet codec → World mutation (90 incoming ids, §8)
    │       │   │   ├── mod.rs           #   apply_packet + the id-ordered `dispatch` index
    │       │   │   ├── text.rs          #   shared decoding primitives (no World)
    │       │   │   ├── mobiles.rs · items.rs · combat.rs · effects.rs
    │       │   │   ├── ui.rs · chat.rs · session.rs · general_info.rs   # handlers by topic
    │       │   │   └── tests.rs         #   the module's own `mod tests`, split out for size
    │       │   ├── movement.rs          # walk requests + Walker (seq/confirm/deny) + 0x21/0x22
    │       │   └── outgoing.rs          # client version + action builders
    │       ├── world/mod.rs             # World/Mobile/Item/PlayerStats/journal/gumps/trades/…
    │       └── path/mod.rs              # A* + Terrain trait
    │   └── tests/golden.rs              # golden-packet regression tests (real `uo_proxy` captures, §7)
    ├── anima-assets/          # .mul/.uop readers (deps: flate2, png); impls path::Terrain
    │   └── src/
    │       ├── lib.rs · map.rs · tiledata.rs · uop.rs   # UOP container (+ lazy on-demand reader), map, tiledata
    │       ├── anim.rs        # legacy + UOP mobile animation; Body/Bodyconv/Corpse/Equipconv.def, mobtypes.txt
    │       ├── art.rs         # artLegacyMUL.uop: land/static tile art → RGBA/PNG
    │       ├── animdata.rs    # animdata.mul: animated-static frame sequences
    │       ├── cliloc.rs      # Cliloc.enu: cliloc id → localized text
    │       ├── gump.rs        # gumpartLegacyMUL.uop: gump art
    │       ├── hues.rs        # hues.mul: sprite recoloring
    │       ├── mounts.rs      # mount item graphic → ridden-animal body table
    │       ├── radarcol.rs    # radarcol.mul: world-map colors
    │       ├── sound.rs       # soundLegacyMUL.uop: sound effects → WAV
    │       └── texmap.rs      # texidx/texmaps.mul: sloped-land seamless textures
    ├── anima-contract-json/   # shared versioned Observation/Action JSON adapter
    ├── anima-session/         # HEADLESS native TCP driver: Session (login, pump, walk, navigate,
    │   │                      #   actions) — no UI linked; what a brain needs and nothing a screen does
    │   └── src/
    │       ├── lib.rs         # Session + Route/advance_route (non-blocking WalkTo state machine)
    │       ├── connection.rs  # dialing, login phases, cancellation
    │       ├── json.rs        # compatibility re-export of anima-contract-json
    │       ├── pathing/       # walking rules shared with the render scene
    │       │   ├── walk.rs    #   can the player stand there — and if not, is it a door?
    │       │   └── height.rs  #   ClassicUO CalculateNewZ port: which surface you stand on
    │       ├── bridge.rs      # the NDJSON brain↔body bridge loop (+ `Spectator` hook)
    │       └── bin/bridge.rs  # `anima-bridge`: the bridge with no UI at all (brains, arena agents)
    ├── anima-net/             # the UI layer on anima-session (re-exports it: `anima_net::Session` works)
    │   └── src/
    │       ├── lib.rs         # `pub use anima_session::*` + the UI modules below
    │       ├── scene/         # build_scene: World + assets → the web renderer's JSON
    │       │   ├── mod.rs     #   build_scene: order the pieces, assemble the JSON
    │       │   ├── look.rs    #   asset lookups (was 15 closures inside build_scene)
    │       │   ├── entities.rs#   mobiles, ground items, worn equipment, container contents
    │       │   ├── terrain.rs #   the visible tile field — the only `&mut MapData` user
    │       │   ├── tiles.rs   #   render tile flags + per-tile art/anim/path suffixes
    │       │   ├── dialogs.rs #   gumps/menus/prompts/trades/maps → renderer JSON
    │       │   ├── feeds.rs   #   seq-stamped replay feeds (sound/anim/damage/effects)
    │       │   ├── multis.rs  #   placed houses/boats + 0xD8 custom-house designs
    │       │   └── worldmap.rs#   radar colours → world-map PNG
    │       ├── play_server/   # the human-playable HTTP server (library form of the `play` bin)
    │       │   ├── mod.rs     #   bind + the PlayServer game loop + shared types
    │       │   ├── http.rs    #   router, request limits, same-origin check, SSE fan-out
    │       │   ├── assets.rs  #   .mul/.uop → PNG/WAV on demand, behind byte-budgeted caches
    │       │   ├── commands.rs#   `POST /input` → Action (the same contract a brain uses)
    │       │   ├── login.rs   #   browser login/character-creation payload parsing
    │       │   └── autowalk.rs#   click-to-walk pre-flight + tuning constants
    │       ├── main.rs        # `anima-login` bin (login-only smoke test)
    │       └── bin/
    │           ├── play.rs    # `play`: human-playable HTTP server (web/ + /scene.json + /input + SSE sound)
    │           ├── scene.rs   # `scene`: AI-patrol bridge → web/scene.json (Phase 2 demo)
    │           ├── agent.rs   # `anima-agent`: anima-session's bridge + optional read-only web spectator
    │           │              #   (`ANIMA_MONITOR_PORT`); `anima-bridge` is the same without the UI
    │           ├── cmd.rs     # `cmd`: drive a running `play` server from the shell
    │           └── find_water.rs
    ├── anima-relay/           # WebSocket↔TCP byte pump so a browser can reach a shard
    │   └── src/main.rs · ws.rs  # allowlisted targets; RFC 6455 subset, no dependencies
    ├── anima-wasm/            # wasm-bindgen wrapper: WasmClient (feed bytes → Observation JSON)
    │   └── src/lib.rs         # build: `wasm-pack build crates/anima-wasm --target web`
    └── anima-agent/           # in-process autonomous brains on the contract
        └── src/lib.rs (Brain, WanderBrain) · main.rs (`anima-brain` runner bin; it was also
            called `anima-agent` until 2026-09-29 and collided with anima-net's bridge bin, so a
            whole-workspace build overwrote one with the other). Depends on anima-session only,
            so the brains link no UI.
web/                          # Phase 2+ renderer (outside the Cargo workspace)
├── index.html                # the page + all CSS; the <script> order below is load-bearing
├── js/                       # PixiJS iso renderer: terrain, sprites, gumps, sound, chat, HUD
│   ├── 00-state · 01-audio · 02-textures · 03-world   # globals, caches, pools
│   ├── 04-boot · 05-poll · 06-movement                # main(), scene poll, prediction
│   ├── 07-hud · 08-overlays · 09-gumps · 10-housing   # HUD, name plates, windows
│   └── 11-dragdrop · 12-input · 13-macros             # interaction
└── vendor/pixi.min.js        # vendored PixiJS v8 (standalone, no CDN)
```

**`web/main.js` was split into `web/js/*` (2026-08-02).** Older citations in
these docs — `web/main.js:5028`, and similar — point into the single 9.7k-line
file that preceded it; find the code by name rather than by line. The split is
by *load order*, not by module system: these are classic `<script>` tags
sharing one global scope, exactly as the single file did, so no binding moved
and no import/export exists. Two consequences worth knowing before editing:
the `<script>` order in `index.html` is the original file's top-to-bottom
order and is load-bearing (top-level statements still run in it), and a new
file needs a new tag or it is silently never loaded.


### Running the human-playable client (current primary way to use this repo)
```
cd ~/dev/uo/servuo && MONO_GAC_PREFIX=/opt/homebrew nohup mono ServUO.exe -noconsole &
cd ~/dev/uo/anima-client
cargo run -p anima-net --bin play -- 127.0.0.1 2594 <user> <pass>
# open http://127.0.0.1:8090/ — or omit all args to auto-login with the defaults
# above, or set ANIMA_LOGIN=1 for an in-browser login page instead. After
# authentication, that page displays the server-provided character names and
# can enter an existing slot or create a customized character in the first
# empty slot.
```

### Running the Phase 2 AI-patrol scene bridge (older demo path, still works)
```
cargo run -p anima-net --bin scene -- 127.0.0.1 2594 <user> <pass> web/scene.json &
( cd web && python3 -m http.server 8011 )      # open http://127.0.0.1:8011/
```
The scene bridge logs in, patrols, and rewrites `web/scene.json` ~2×/s; the page
polls it. (Future: swap the JSON bridge for `anima-wasm` in-browser + a
WebSocket↔TCP relay so the browser runs the core directly — §4.)

**Done:** all workspace crates build; formatting, clippy, tests, and the wasm32
build are enforced by CI. Real-data-file tests remain `#[ignore]`d by default.
Validated end-to-end against a live ServUO (see the status block at the top).

### Sans-IO contract (how a driver uses the login flow)
```
let (mut m, initial) = LoginMachine::start(cfg);   // cfg = user/pass/server/slot
// open TCP to login server; write `initial` (Seed + AccountLogin)
loop {
    framer.feed(bytes_from_socket);
    while let Some(frame) = framer.pop()? {
        for directive in m.on_packet(&frame)? {
            match directive {
                Send(b)                        => socket.write(b),
                ReconnectToGameServer { then } => { reconnect_to_game_server();
                                                    framer = game_mode_framer(); // +Huffman
                                                    socket.write(then); }
                Done(result)                   => return result, // we're in the world
            }
        }
    }
}
```
The driver is the only code that knows about sockets — write it once for native
(TCP) and once for WASM (WebSocket). The core stays pure.

---

## 6. Roadmap

### Phase 1 — `anima-core` (rendering = 0). ✅ COMPLETE — all validated vs live ServUO.
1. ✅ Connection state machine + two-phase login (sans-IO `LoginMachine`).
2. ✅ Huffman decompressor + game-mode framer (`net/huffman.rs`, `framing.rs`).
3. ✅ Native TCP driver (`anima-net::Session`) — connects to ServUO end-to-end.
4. ✅ Character create + select + delete (`build_create_character`,
   `build_delete_character`, `CharacterAppearance`), including the browser's
   server-provided list and confirmation-gated deletion flow.
5. ✅ Game packet codec → World mutation (`net/game/`): originally 0x20/0x77/0x78/
   0x1A/0x1D/0x11/0xA1-3/0x1C/0xAE/0xBF; now **90 incoming ids** dispatched (count
   the match arms in `dispatch()`) covering combat/damage/effects, full vitals,
   containers,
   gumps (incl. packed/compressed 0xDD), targeting, vendors, skills, books,
   party, buffs, quest arrows, weather/season/light, corpses (0xAF/0x89),
   ASCII/Unicode prompts (0x9A/0xC2), consent-gated external URLs (0xA5),
   Tip/Notice windows (0xA6/0xA7), modal text-entry dialogs (0xAB/0xAC),
   character profile display/request/update (0xB8), capability-negotiated logout (0xD1),
   atomic High Seas boat/passenger movement (0xF6),
   combatant (0xAA), secure trading (0x6F), facet change
   (0xBF/0x08) — see §8.
6. ✅ Movement (`net/movement.rs`): walk 0x02 + seq + confirm/deny + resync +
   fastwalk; `Session::advance_route` adds a non-blocking `Action::WalkTo`
   (click-to-walk) driver for headless brains.
7. ✅ Asset readers (`anima-assets`): UOP map, tiledata.mul (HS), statics — real data
   verified; plus animation (legacy + UOP, Body/Bodyconv/Corpse/Equipconv.def,
   mobtypes.txt), art, gump art, hues, sound, cliloc, texmap, radar colors, mounts.
8. ✅ Pathfinding (`path/`): A* + `Terrain` trait, Z-aware, diagonal-safe.
9. ✅ Observation/Action contract (`agent.rs`) + `Session::apply_action` / `navigate_to`.
   `agent.rs`'s `Action` enum now has 89 variants; `anima-contract-json` mirrors the
   full `Observation`/`Action` surface as versioned JSON (schema **v30**) for the
   out-of-process Python brain (`anima2`), table-tested for every variant.
   **Combat state a brain can act on** (v19): `armed_ability` — the weapon
   special move armed for the next swing — is the one piece of state the arming
   side of the contract had no readback for, because UO acknowledges an arm only
   by *revoking* it (0xBF/0x21). A brain that sent `UseAbility` therefore could
   not tell "armed and waiting" from "already spent", which is the difference
   between opening with a special and wasting the mana. It is written
   optimistically by the driver on send and cleared by the packet; the same
   version added `active_spell_icons` (0xBF/0x25 stances) and the
   `DisarmRequest`/`StunRequest`/`BandageTarget` actions. Schema v29 added the
   bandage siblings `TargetedSpell`/`TargetedSkill`/`TargetByResource`
   (0xBF/0x2D, 0x2E, 0x30). Schema v30 added ClassicUO `GameActions` verbs that
   had no Action: `OpenDoor` (0x12/0x58), `EquipLastWeapon` (0xD7/0x1E),
   `InvokeVirtue`, `EmoteAction`, `CastSpellFromBook`, `AllNames`. Schema v31
   added the heritage / race-change dialog (`race_change` + `ChangeRace` /
   `ChangeRaceCancel`, 0xBF/0x2A) and `OpenUOStore` (0xFA). Pre-OPL equipment
   info (0xBF/0x10) rides the existing journal. Schema v32 gave `mobiles[]` the
   condition any client draws on another mobile (`poisoned`/`poison_level`,
   `paralyzed`, `war_mode`, `hidden`, `yellow_health`, `running`, `direction`),
   so a brain can judge an opponent by more than its hits. Schema v33 passed on
   the rest of what the core tracked (the player's own condition and 0x11 tail,
   item hue/name/flags, resolved buff and property text, out-of-view party and
   guild members, and the effect/animation/sound/lift-reject rings), and the
   bridge gained character choice, `logout`/`login`, and `act`'s `sent` flag —
   see "Bridge coverage audit" in `CLASSICUO_GAPS.md`.
   **`Observation.terrain`** (schema v17) is the one field that does not come from
   a packet: local walkability (walkable / standing Z / the serial of a closed door
   in the way), so a brain can tell a wall from open ground rather than delegating
   every route to the driver's pathfinder. The core still reads no map files —
   `World::observe` leaves it `None`, and a driver holding `MapData` fills it via
   `agent::survey_terrain` over the existing `path::Terrain` trait
   (`Session::observation_with_terrain`). That keeps D3 intact: perception the core
   *can* derive from packets stays in the core; perception that needs assets is
   injected by whoever owns the assets.

**Remaining compatibility work:** tracked against ClassicUO's handler registry in
[`CLASSICUO_GAPS.md`](CLASSICUO_GAPS.md). Fastwalk is consumed but most shards
send 0 keys. `0x24` DrawContainer is implemented end-to-end, including
server-initiated bank/container windows and filtering vendor/spellbook overloads.

### Phase 2 — renderer (web) + WASM. ✅ COMPLETE.
- ✅ `anima-core` compiles to `wasm32-unknown-unknown`; `anima-wasm` (wasm-bindgen)
  exposes `WasmClient` (feed bytes → outbox + `Observation` JSON). `wasm-pack build`
  produces the browser module.
- ✅ PixiJS renderer (`web/`) draws a live minimap (walkability/Z) + mobiles/items +
  HUD from `Observation`, fed by `anima-net`'s `scene` bridge. Screenshot-verified.

**Remaining tail:** none of the planned work. The relay exists (`crates/anima-relay`,
verified carrying a real login handshake to ServUO), the Tauri shell is done, and
the browser page is `/?wasm=1` ( `/wasm.html` redirects there): `WasmClient` owns
the protocol (character list, walk/say/use/attack, `apply_action_json`),
`anima-relay` is the WebSocket↔TCP pump, and `cargo run -p anima-net --bin assets`
serves `/art`, `/gump`, `/font`, and `GET /terrain.json` (the same land/statics
window `build_scene` emits) from the local UO install without a game session.
`web/js/14-wasm.js` merges `observation_json()` with that terrain into the existing
Pixi `poll()`/`syncWorld` path. Build the module with
`wasm-pack build crates/anima-wasm --target web --out-dir web/pkg`. Keyboard walk
reaches the shard; `Action::WalkTo` is still a no-op in WASM (no in-process `MapData`).

### Phase 3 — AI brains + real art + human-playable polish. ✅ COMPLETE (incl. the tail).
- ✅ `anima-agent`: `Brain` trait (`decide(&Observation)->Vec<Action>`) +
  `WanderBrain` / `HunterBrain` / `LlmBrain` — `--brain wander|hunter|llm`.
  The full perception→decision→action loop on the real server.
- ✅ `anima-assets::art`: decodes `artLegacyMUL.uop` (land diamond + static RLE,
  ARGB1555→RGBA); the `play`/`scene` servers PNG-encode and cache it per graphic.
  (Note: art UOP paths use a `.tga` extension, unlike the map's `.dat`.)
- ✅ **Full isometric sprite blitting**: real land diamonds (flat + sloped/texmap
  `PIXI.Mesh`) and static art in a persistent tile pool (absolute world-iso
  coordinates; only edge tiles added/removed as the camera slides) — see
  `docs/RENDERING.md` §5 for the roof/upper-floor Z-culling this depends on.
- ✅ **Mobile/monster animation, fully resolved** (not just people): legacy
  `anim.mul..anim5.mul` + UOP `AnimationFrame1-4.uop`/`AnimationSequence.uop`
  (`anima_assets::uop::LazyUopReader`, on-demand — the four UOP files total
  ~500MB and are never loaded whole), `Body.def`/`Bodyconv.def`/`mobtypes.txt`
  remap+group-kind resolution, `Corpse.def` death-pose corpses, `Equipconv.def`
  gendered equipment/paperdoll, mount body-under-rider, walk/run/idle/combat/
  typed (0xE2) animation cycling timed to real step cadence.
- ✅ **Gumps**: layout grammar parsed into typed elements shared by the brain
  (`anima-core::gump_layout`) and the web renderer (`anima-net::scene`);
  multi-page + real button art; paperdoll/backpack/containers (incl. stack-split
  drag)/vendor buy-sell/spellbook/skills/books/party, all over
  `gumpartLegacyMUL.uop`.
- ✅ **Audio**: `anima-assets::sound` decodes `soundLegacyMUL.uop` → WAV; the
  `play` server pushes each sound over an SSE stream (`GET /sounds`, on its own
  thread so it can't starve the HTTP worker pool) the instant it fires, plus
  music (0x6D) and positional (x,y) panning in the browser.
  Sound entries are read lazily with bounded WAV/decoded caches and bounded
  loading work; see [AUDIO_PERFORMANCE.md](AUDIO_PERFORMANCE.md) for limits,
  overload behavior and the measured sound-reader memory reduction.
- ✅ **AI contract completeness**: `Observation` audited field-by-field (buffs,
  shop, popup, book, party, quest arrow, weather/season/light, war, combat
  attribution, corpse links, OPL, map_index, …); `anima-net::json` mirrors the
  full `Observation`/`Action` surface as versioned JSON for the out-of-process
  Python brain; `Session::advance_route` gives any driver a non-blocking
  `Action::WalkTo`.

**Remaining tail:** none of the planned work. Richer brains (`HunterBrain`,
`LlmBrain` over `ANIMA_LLM_URL`), the browser WASM isometric page (`/?wasm=1` +
`anima-relay` + `anima-net --bin assets` `/terrain.json`), and ClassicUO Tier 5
asset rows
(`verdata`, `mapdif`/0xBF/0x18, `fonts.mul`, `tileart.uop`, BWT cliloc, Prof.txt,
Multimap.rle) are implemented — see CLASSICUO_GAPS.md. (Previously listed here
and since completed: delete-character, `multi.mul`, sitting, treasure maps, Tauri,
custom housing, the relay, `speech.mul` keywords, skills.mul / *.def aliases /
MUL fallback.)

---

## 7. Reference sources (use these, don't reinvent)

All present on the same machine under `~/dev/uo/`:

- **`~/dev/uo/anima`** — the Python AI-player. Its `anima/client/` (packet codec, `packets.py`, `parser.py`), `anima/perception/` (WorldState), `anima/pathfinding.py`, `anima/map.py`, `anima/uop.py` are a **partial port of exactly this core in Python**. Use as the **spec/oracle** for porting. Its `CLAUDE.md` has concise protocol notes (mirrored in §8).
- **`~/dev/uo/anima/uo_proxy`** — a packet-logging proxy (MITM between ClassicUO and
  the server; see its `README.md` for the JSONL schema). Its captures under
  `~/dev/uo/anima/data/trajectories/*.jsonl` (schema `uo_proxy.packet.v1`) ARE now
  used as **golden tests**: `crates/anima-core/tests/golden.rs` replays real captured
  frames (from `demo-20260419-114417.jsonl`, session `1776566669-e86360f4`) through
  `apply_packet` and asserts the resulting `World` (0x11/0x78/0x20/0xF3/0x3C/0x1D —
  provenance cited per test). To record more: `cd ~/dev/uo/anima && uv run python -m
  uo_proxy --upstream <host:port> --listen 127.0.0.1:2593 --out
  data/trajectories/demo-<name>.jsonl`, point ClassicUO (or `/etc/hosts`) at the
  listen address, play, then grep the JSONL for the `pid`(s) you want and copy the
  `hex` field into a new `#[test]` in `golden.rs` (S→C game-phase lines are already
  Huffman-decompressed by the proxy for logging — exactly what `apply_packet` wants).
- **`~/dev/uo/classicuo`** — the C# reference client (your fork, `.NET 10`). Authoritative for packet handlers (`Network/PacketHandlers.cs` ~119 handlers, `Network/OutgoingPackets.cs` ~80), world model (`Game/World.cs`, `Game/GameObjects/`), file formats (`ClassicUO.Assets`, `ClassicUO.IO`), pathfinding (`Game/Pathfinder.cs`), and the login flow (`Game/Scenes/LoginScene.cs`). **Read these when implementing the equivalent Rust.**
- **ServUO** (`~/dev/uo/servuo`) and **ModernUO** — server-side view of the protocol for cross-checking. ModernUO is a clean modern .NET rewrite, good for world-model reference.
- **`~/dev/uo/uowiki`** — companion knowledge base (game facts). Also exposed as an MCP server (`wiki_search`, `wiki_read_page`) in sessions here.
- **Two independent Rust UO projects**, surfaced by their authors on issue #1
  (2026-08-07) and both permissively licensed, so their code is usable and not
  merely readable: **[`ungine7`](https://github.com/broker0/ungine7)** (MIT, a
  protocol/tooling workspace — its live typed packet inspector and session
  record/replay are better versions of what `uo_proxy` captures give us) and
  **[`OpenShard`](https://github.com/enomado/OpenShard)** (MIT OR Apache-2.0, a
  *server* engine, so it holds the opposite end of every packet we send).
  Note `ungine7`'s README carries an "Educational Use Only" paragraph: it is a
  non-binding statement of intent ("the maintainers do not endorse…"), not a
  licence condition, and its `LICENSE` is plain MIT.

  **Why they earn a place beside ClassicUO/ServUO/Razor:** this codebase has
  twice settled a question by finding ClassicUO wrong, and both times the tie
  was broken by having *two* independent implementations of the other side.
  Four sources is materially better than three. OpenShard's
  [`docs/findings.md`](https://github.com/enomado/OpenShard/blob/main/docs/findings.md)
  is the highest-value single artifact — the same genre as §8 here, written
  from the server's side. Auditing our tree against it found two real defects
  (land-art alpha, and the walk repair leg); see CLASSICUO_GAPS.md.

---

## 8. Protocol knowledge (concrete, for Phase 1)

Distilled from `anima/CLAUDE.md` — verify against ClassicUO/captures while implementing.

- **Endianness:** all network values are **big-endian**. (`anima-core`'s `PacketReader/Writer` are BE.)
- **No encryption:** send plaintext TCP. (Treat accounts as disposable — login sends user/pass in plaintext.)
- **Compression:** **Huffman** decompression required for **game-phase server→client** packets only (not login phase, not client→server). Implement in `net/`.
- **Packet framing:** fixed = `[id][payload]` (length from a static table); variable = `[id][len: u16 BE][payload]`. Need the packet-length table (see ClassicUO `Network/PacketsTable.cs`).
- **Two-connection login flow:**
  1. Connect to login server → `Send_FirstLogin(account, password)`.
  2. Receive server list → `Send_SelectServer(index)`.
  3. Receive relay (game server ip/port + auth key) → **reconnect** to game server.
  4. Receive character list → `Send_SelectCharacter(index, name, ...)`.
  5. `EnterWorld (0x1B)` → create player, load map → `LoginComplete (0x55)`.
- **Movement protocol:**
  - Walk packet `0x02`: `[dir|run_flag] [seq: u8] [fastwalk_key: u32]` — 7 bytes.
  - `seq`: 1–255, wraps to 1 (never 0). Max **5** pending steps.
  - Server replies `ConfirmWalk (0x22)` or `DenyWalk (0x21)` (deny → resync to server position).
  - Throttle: ~400ms walk, ~200ms run, ~100ms mounted run.
  - Direction low 3 bits = facing; `0x80` = running flag (see `types::Direction`).
- **Key packet ids** (login phase): `0x1B` EnterWorld, `0x55` LoginComplete.
  (Full incoming-packet handler list: ClassicUO `PacketHandlers.cs`.)
- **Game-phase incoming coverage (current, verified by counting `net::game::dispatch`'s
  match arms):** **90** packet ids handled in `net/game/` — `0x20` MobileUpdate,
  `0x77`/`0x78` mobile moving/incoming, `0x2E` EquipItem, `0x1A`/`0xF3` world item
  (legacy/HS), `0x1D` Delete, `0x11` CharacterStatus, `0xA1-3` vitals, `0x1C`/`0xAE`
  Talk/UnicodeTalk, `0xBF` general-info subcommands (facet change, party, …), `0x6C`
  Target, `0x3A` UpdateSkills, `0x3C`/`0x25` container content/add, `0xC1`/`0xCC`
  cliloc message/affix, `0x0B` damage, `0x70`/`0xC0`/`0xC7` graphic effects, `0x54`
  sound, `0x6E`/`0xE2` character/typed animation, `0x6D` music, `0x72` war mode,
  `0x4F`/`0x4E` light, `0x65`/`0xBC` weather/season, `0x74`/`0x9E` vendor buy/sell,
  `0x7C` legacy item/question menus, `0x95` server dye hue pickers,
  `0xDF` buff, `0xB0`/`0xDD` gumps (incl. zlib-packed), `0xBA` quest arrow, `0xD6`/
  `0xDC` OPL, `0x93`/`0xD4`/`0x66` books, `0xAF` corpse-of-death, `0xAA` combatant,
  `0x27` lift-reject, `0x28`/`0x29` item-drag completion, `0x2C` death status,
  `0x2D` full mobile attributes, `0x38` server pathfinding, `0x89` corpse equip,
  `0x9A`/`0xC2` ASCII/Unicode prompts, `0xA5` consent-gated external URLs,
  `0xA6` Tip/Notice windows, `0xAB` modal text-entry dialogs, `0xB8` character profiles,
  `0xD1` capability-negotiated logout acknowledgements,
  `0xF6` High Seas boat/passenger movement,
  `0x6F` secure trade, `0x3B` vendor close, `0x24` container display,
  `0x88` paperdoll, `0x2F` swing, `0x90`/`0xF5` maps, `0x56` map commands, `0x99`
  multi target, `0xD8` custom houses, and `0xE5`/`0xE6` waypoints — plus
  `0x21`/`0x22` (confirm/deny walk), owned separately by `net::movement::Walker`,
  for **92** total. (The named list above is illustrative, not exhaustive — the
  count is authoritative and comes from `dispatch()`; it had drifted to 76,
  fourteen ids stale, before the 2026-08-06 recount.) Notable `0xBF` subcommands
  handled: `0x08` facet change, `0x06` party, `0x14` popup, `0x19` extended
  stats, `0x1B` spellbook content, `0x1D`/`0x20` custom-house notice/designer,
  `0x21` clear armed weapon ability, `0x22` new damage, `0x25` toggle special
  ability, `0x26` speed mode. Outgoing login-phase `0x83` delete-character is handled
  separately. Remaining ClassicUO gaps are maintained in
  [`CLASSICUO_GAPS.md`](CLASSICUO_GAPS.md).

---

## 9. Toolchain & commands

- **Rust:** 1.96 + cargo present. **Node:** 26 / npm 11 present.
- WASM target (add when needed): `rustup target add wasm32-unknown-unknown`.

```bash
cd ~/dev/uo/anima-client
cargo build             # build workspace
cargo test --workspace  # ignored tests require local real-data files
cargo clippy --workspace --all-targets -- -D warnings
cargo doc --open        # browse the core API docs
scripts/check.sh        # every gate CI runs, in CI's order (add --skip-desktop to skip Tauri)
```

**The toolchain pin is load-bearing.** `rustfmt`'s and `clippy`'s output both
change between releases, and only rustup's `cargo`/`rustc` shims read
`rust-toolchain.toml` at all — a Homebrew/distro `cargo` ignores it and
silently uses whatever it shipped with. `scripts/check.sh` compares
`rustc --version` against the pin and refuses to run on a mismatch rather than
report a verdict CI won't share.

*How this was learned, since the wrong lesson is the tempting one:* on a
machine with no rustup, Homebrew rust 1.97.1 reported 35 `cargo fmt --check`
diffs and a failing `clippy -D warnings`, which looked like version drift
against a tree CI was presumed to be happy with. It wasn't drift. CI runs the
pinned 1.96.1 (verified in the run log) and reported **the same 35 diffs**;
the fmt gate had been red for five consecutive commits. Formatting deviations
are not toolchain disagreements until you have checked the CI log — and a
long-red gate is invisible precisely because nobody reads a job that is always
failing. One of those 35 was rustfmt (in *both* versions) re-indenting a
standalone comment that follows a trailing-comment line onto column 80; the
fix is to not write that construct, not to fight the formatter.

- **macOS / Apple Silicon note:** the core is pure logic, no native graphics deps, so no arm64 friction (unlike ClassicUO's SDL/FNA). Friction only appears at the renderer/Tauri stage — prefer arm64-native deps, WebGL2 fallback for WKWebView WebGPU gaps.
- **Standalone desktop app:** `cargo run -p anima-desktop` (Tauri v2, no npm) — runs the `play` server in-process on a loopback port kept stable across launches (first free of `8190..=8199`, remembered in the desktop config: `localStorage` is keyed by origin, so an ephemeral port silently reset every renderer preference each run) and opens a native window at it; `crates/anima-desktop/README.md` covers `.app`/`.dmg` bundling.
- **Testing playbook:** [`docs/TESTING.md`](TESTING.md) — GM-assisted testing (teleport/spawn/give via a GM `play` session), the CDP screenshot driver (`scripts/drive.py`), and the `scripts/gm.sh` command wrapper. Set `ANIMA_DEBUG=1` on the `play`/`scene` bins for movement/pathfind/Z-transition traces; the web Options panel has a **Movement debug** HUD (server Z vs eased Z + recent walk notes).

---

## 10. Open decisions (resolve when you reach them)

- **Tauri vs Electron** for the desktop shell (renderer consistency vs binary size) — §4.
- **WASM binding strategy** — `wasm-bindgen` + a JS API surface vs a message/snapshot protocol mirroring the Observation/Action contract.
- **World model data structure at scale** — HashMap-by-serial now; move to `slotmap`/ECS (or Bevy ECS if Bevy becomes the renderer) if entity churn/perf demands.
- ~~**Relay implementation**~~ — **resolved: a standalone, zero-dependency Rust
  crate** (`crates/anima-relay`). Standalone because the relay is the one piece
  that must be reachable by a browser that may have nothing else of ours, and
  because bundling it into `play_server` would have coupled the browser path to
  the very server it is supposed to make unnecessary. Zero-dependency because
  the only non-trivial thing in it is RFC 6455's handshake and framing (~200
  lines of well-specified protocol, plus SHA-1 and base64 used solely to echo
  the upgrade nonce) — a WebSocket stack and its async runtime would have been
  most of a dependency tree for that. It never parses a UO packet: the protocol
  runs in the browser, in `anima-core` via `anima-wasm`.
- **How the AI brain attaches** — ~~in-process vs out-of-process~~ **resolved: both,
  not either/or.** In-process: `anima-agent` links `anima-core`/`anima-session` directly
  (`Brain` trait, `WanderBrain`, Rust). Out-of-process: `anima_session::bridge` speaks
  versioned JSON over NDJSON stdin/stdout so the existing Python `anima2`/`anima3` brains
  can drive a session without any Rust brain code — built headless as `anima-bridge`
  (`anima-session`) or with a read-only web spectator as `anima-agent` (`anima-net`).
