# Renderer input: one scene contract

**Status:** agreed direction, 2026-09-29. Replay is the first feed to migrate.

The PixiJS renderer in `web/js` should draw exactly one kind of input: a **scene
object**, the shape `anima_net::scene::build_scene` emits. Anything that wants
to show a world on screen (the live game, the spectator, a match replay)
produces scene objects; the renderer turns them into sprites, and nothing else
reaches inside it.

## Why

Until 2026-09-29 three feeds each built renderer entities their own way:

| Feed | How it built the picture | Drift |
| --- | --- | --- |
| Native `play` / spectator | Rust `build_scene` → `/scene.json` | the reference |
| Browser WASM (removed) | JS `wasmMergeScene` re-derived a scene from Observation JSON | hard-coded `noto: 0`, `hue: 0`, `mountAnim: 0`; its own command parser |
| Replay (in progress) | JS `15-replay.js` builds `scene` and writes renderer animation state | see below |

Every renderer improvement (a new mobile field, status, an effect) had to be
repeated per feed, and whatever was missed looked different on screen. With the
WASM client gone, two feeds remain. Settling the contract now keeps replay from
becoming the next copy.

## The rule

1. A feed's only output is a scene object with the fields below, with the same
   names, types and meaning as `build_scene`.
2. **Renderer state stays in the renderer.** Animation phase, frame timers,
   interpolation, typed-animation fallbacks and sprite caches are derived by
   `web/js` from the scene. A feed never writes them.
3. **Events travel as feeds, not as state.** Swings, action animations, effects,
   damage numbers and sounds are the seq-stamped logs `build_scene` already
   emits (`anims`, `swings`, `effects`, `damage`, `sounds`; see
   `crates/anima-net/src/scene/feeds.rs`). The renderer plays each entry
   whose `seq` is newer than the last one it acted on, so a replay can emit
   the same entries at the recorded times and get the same animations.
4. Mode-specific code (a replay clock, seek bar, winner screen, likes) is UI
   around the renderer. It must not construct mobiles or items.

## The contract (source of truth: `build_scene`)

When this list and the Rust code disagree, the Rust code wins. Update this list
in the same commit.

**Top level:** `sessionId` `player` `map` `cx` `cy` `radius` `viewRange` `tiles`
`maxZ` `maxGroundZ` `noDrawRoofs` `statics` `mobiles` `items` `contItems`
`lights` `journal` `facet` `season` `light` `weather` `war` `combatant`
`lastAttack` `target` `buffs` `stats` plus the event feeds `anims` `swings`
`effects` `damage` `sounds`. Live-game dialogs (`gumps`, `shop`, `trades`,
`paperdoll`, …) are optional: a feed that has none omits them.

**Mobile** (`mobiles[]`, from `scene/entities.rs`):
`serial`, `x` `y` `z`, `dir`, `body`, `at` (animation type of the body), `noto`,
`name`, `hits` `hitsMax`, `hue`, `equip[]` (`serial` `layer` `g` `anim` `hue`),
`mounted` (0/1), `mountAnim`, `mountOff`, and `so: 1` only when hidden.

**Ground item** (`items[]`): `serial`, `x` `y` `z`, `g` (graphic, stack-aware),
`pz` (draw Z), `hue`, `amount` (and `st: 1` when stackable).

**Terrain** (`map`, `tiles`, `statics`, `lights`): exactly what
`GET /terrain.json` returns for a window with no session
(`scene::build_terrain_window`), so a feed without a live session can splice it
in unchanged.

## Replay today (`feat/arena-hotkeys`, `web/js/15-replay.js`)

Replay already produces a `scene` object and reuses `/terrain.json`, which is
most of the way there. What still breaks the rule:

- `replayMobile` sets state the renderer otherwise keeps for itself: `frameMs`,
  `startMs`, `fwd`, `mobRec`, `rx`/`ry`/`rz`, `tx`/`ty`, `typed` and `fallback`
  are read and updated by `05-poll`, `06-movement` and `08-overlays` for native
  mobiles, and replay writes them directly. It also adds fields only replay knows
  (`animPhase`, `animMoving`, `alive`).
- Animation is expressed as per-mobile `action`/`group`/`mode` state, where the
  native scene sends `anim` on equipment and the seq-stamped `anims`/`swings`
  feeds for actions.
- `REPLAY_MODE` branches inside shared renderer files (`00-state`, `01-audio`,
  `02-textures`, `04-boot`, `06-movement`, `08-overlays`, `13-macros`) exist to
  accept those fields.

## Migration for replay

1. **Converter first.** Keep the recording format. Add one pure function,
   `replaySceneAt(recording, t) → scene`, that emits only contract fields for
   mobiles and items, and turns the recorded actions, casts, potions, damage and
   sounds into `anims`/`swings`/`effects`/`damage`/`sounds` entries with `seq`
   values in time order. Assign its result to `scene` and let the normal
   `syncWorld` path draw it.
2. **Delete the entity branches.** Once the converter feeds the normal path, the
   `REPLAY_MODE` code in shared renderer files shrinks to the clock (`visualNow`)
   and the replay UI.
3. **Conformance test.** A `web/test` case builds scenes from a recorded match
   with `replaySceneAt` and asserts every mobile and item uses only contract keys
   and types, then renders them through the same code path as a native scene.
4. **Later, optional.** Build replay scenes in Rust from the server recording,
   with the same entity serializer `build_scene` uses, and serve them from the
   asset-only server. That leaves a single scene producer.

Owner: the replay work (Codex). This document is the agreement; the code
changes land on the replay branch.
