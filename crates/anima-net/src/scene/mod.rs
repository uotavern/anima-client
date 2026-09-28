//! Builds the renderer scene JSON from a live [`Session`] + map/art data.
//! Shared by the `scene` (AI patrol) and `play` (human-controlled) bins.

use std::collections::HashSet;
use std::fmt::Write as _;
use std::time::Instant;

use anima_assets::{
    Anim, AnimData, Art, Cliloc, Image, MapData, Multis, RadarCol, MAP_HEIGHT, MAP_WIDTH,
};
use anima_core::gump_layout::{self, GumpElement, HtmlText};
use anima_core::World;
use serde_json::{json, Value};

use crate::Session;

// What this module is assembled from. `mod.rs` keeps `build_scene` itself —
// the one function that holds every borrow (session, map, art, anim) at once
// and walks the visible window; the pieces it calls live next door. Each
// submodule opens with `use super::*`, reaching this module's imports and its
// siblings alike.
//
// `pub use` for the four that carry the crate-facing API (`lib.rs` and
// `play_server` path into them); plain `use` for the three that are purely
// internal to the scene build.
// Walking and height rules are shared with the headless session (`anima-session`),
// so the per-tile walk flags drawn here match what a brain's pathing believes.
pub use anima_session::pathing::*;

mod tiles;
mod worldmap;
pub use tiles::*;
pub use worldmap::*;

mod terrain;
use terrain::*;

mod entities;
use entities::*;

mod look;
use look::Look;

mod dialogs;
mod feeds;
mod multis;
mod season;
use dialogs::*;
use feeds::*;
use multis::*;

// ----------------------------------------------------------------------------
// Step-Z resolution — a faithful port of ClassicUO `Pathfinder.CalculateNewZ`
// (+ `CalculateMinMaxZ`, `CreateItemList`). The server's ConfirmWalk carries no
// Z, so when the player steps onto a tile we resolve the standing Z exactly as
// the client does: build the tile's object list, bound the step by the tile we
// came from, and pick the surface/bridge closest to our current Z with headroom.
// This is what makes stairs (bridge tiles, avg Z = z + height/2) climb correctly.
// ----------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Replay feeds.
//
// Each of these is a *seq-stamped event log*, not state: the renderer keeps the
// highest `seq` it has acted on and plays only what is newer, so the same
// entries reappear across polls until they age out of `World`'s capped buffer.
// That is why they are `World`-only (no map/art/session), and why dropping one
// frame is harmless.
// ---------------------------------------------------------------------------

/// Serialize the current world + a map window (walkability/Z + real terrain
/// color) + entities + journal to the JSON the web renderer consumes.
#[allow(clippy::too_many_arguments)]
pub fn build_scene(
    s: &mut Session,
    map: Option<&mut MapData>,
    mut art: Option<&mut Art>,
    cliloc: Option<&Cliloc>,
    animdata: Option<&AnimData>,
    anim: Option<&Anim>,
    multis: Option<&Multis>,
    tileart: Option<&anima_assets::TileArt>,
    journal: &[Value],
) -> String {
    // Decode any newly-arrived custom-house designs before anything below reads
    // `s.world` — needs `multis` for the foundation's `multi.mul` bounds, so it's
    // a no-op (and every design stays `tiles_ready == false`, rendering as the
    // stock foundation) when the caller has no `Multis` loaded at all.
    let prof = std::env::var("ANIMA_PROFILE").is_ok();
    let mut t = Instant::now();
    let mark = |name: &str, t: &mut Instant| {
        if prof {
            eprintln!("[prof] {name}: {:.2}ms", t.elapsed().as_secs_f64() * 1000.0);
            *t = Instant::now();
        }
    };
    if let Some(m) = multis {
        ensure_house_tiles(&mut s.world, m);
    }
    mark("house_tiles", &mut t);
    let p = s.world.player_mobile().cloned().unwrap_or_default();
    let st = &s.world.player_stats;
    let mounted = s.world.player_mounted();
    let (px, py, pz) = (p.pos.x as i64, p.pos.y as i64, p.pos.z as i32);

    // Roof/ceiling cull bound (ClassicUO UpdateMaxDrawZ), computed up front so BOTH
    // the ground-items and statics emissions can hide anything at/above it. Without
    // this on items, a field/object sitting on the mountain surface above a cave
    // (or furniture on a hidden upper floor) renders floating over the black void.
    let mut map = map;
    let ceiling = match map {
        Some(ref mut m) => max_draw_z(&s.world, m, multis, px, py, pz),
        None => DrawCeiling::OPEN,
    };
    let max_z = ceiling.max_z;
    let max_ground_z = ceiling.max_ground_z;
    let no_draw_roofs = ceiling.no_draw_roofs;

    // Every asset lookup the emitters below need, as one value instead of
    // fifteen closures. It holds the SHARED `&MapData`; the tile loop further
    // down takes the `&mut` one, so `look` must be out of scope by then.
    mark("max_draw_z", &mut t);
    let look = Look {
        map: map.as_deref(),
        anim,
        animdata,
        tileart,
    };

    // Resolved here rather than beside the player JSON below: these need only
    // `anim`, but they ask `look` for it, and `look`'s shared map borrow has to
    // end before the tile loop takes the `&mut` one.
    let (p_body, p_hue) = look.remap(p.body, p.hue);
    let p_atype = look.atype(p_body);
    // Death cues (0xAF): the mobile fell over. The renderer keeps its body alive
    // locally for the length of the death animation and holds the corpse's own
    // sprite back until then — ClassicUO's `CorpseManager` in one field.
    // Resolved here, with the other `look`-dependent values, because the shared
    // map borrow has to end before the tile loop takes the `&mut` one. `dg`
    // comes from the server for the same reason a corpse's does: the death
    // group depends on mobtypes flags the browser cannot read.
    let deaths: Vec<Value> = s
        .world
        .recent_deaths
        .iter()
        .map(|&(seq, killed, corpse, running)| {
            let body = s.world.mobiles.get(&killed).map_or(0, |m| m.body);
            let (rbody, _) = look.remap(body, 0);
            json!({
                "seq": seq, "serial": killed, "corpse": corpse,
                "running": running as u8,
                "dg": look.anim.map_or(0, |a| a.death_group(rbody)),
            })
        })
        .collect();

    let mut mobiles = mobiles_json(&s.world, &look, &p);
    let items = items_json(&s.world, &look, px, py, max_z, no_draw_roofs);
    let mut lights = lights_json(&s.world, &look, px, py, pz);
    // `Equipconv.def` is keyed by the wearer's REMAPPED body.
    let (equip_body, _) = look.remap(p.body, p.hue);
    let equip = equip_json(&s.world, &look, &p, equip_body);
    let (player_mount_anim, player_mount_off) = player_mount_info(&s.world, &look, &p);
    let cont_items = container_items_json(&s.world, &look);
    // Per-open-container title/icon metadata — resolved here while `look` (and so
    // the tiledata name lookup) is alive, before the tile loop takes the mutable
    // map borrow. See `container_info_json`.
    let cont_info = serde_json::to_string(&container_info_json(&s.world, &look))
        .unwrap_or_else(|_| "{}".into());
    mark("entities", &mut t);
    // Vendor shop windows. `buy` (0x74) lists the vendor's for-sale prices in
    // packet order — the renderer matches them to that container's `contItems` by
    // index. `sell` (0x9E) lists the items in our pack the vendor will buy. Either
    // may be present; `shop` is null when no vendor window is open.
    let shop_buy = s.world.shop_buy.as_ref().map(|b| {
        let prices: Vec<Value> = b
            .entries
            .iter()
            .map(|e| {
                // ServUO sends cliloc-named stock as the bare numeric cliloc id; resolve
                // it to the real item name (e.g. 1060834 → "a hatchet"). The item fields
                // (serial/graphic/amount) are paired in by 0x3C arrival order in
                // anima-core's `open_buy_window`.
                json!({
                    "price": e.price, "name": resolve_shop_name(&e.name, cliloc),
                    "serial": e.serial, "graphic": e.graphic, "amount": e.amount,
                })
            })
            .collect();
        json!({ "vendor": b.vendor, "cont": b.container, "prices": prices })
    });
    let shop_sell = s.world.shop_sell.as_ref().map(|sl| {
        let items: Vec<Value> = sl
            .items
            .iter()
            .map(|it| {
                // Same cliloc-shaped-name resolution as the buy side above — ServUO's
                // `IShopSellInfo.GetNameFor` falls back to a bare numeric LabelNumber
                // string for stock with no explicit `Item.Name` (see
                // `resolve_shop_name`'s doc), which otherwise showed as a raw id.
                let mut v = json!({
                    "serial": it.serial, "g": it.graphic, "amount": it.amount,
                    "price": it.price, "name": resolve_shop_name(&it.name, cliloc)
                });
                // The sell list (0x9E) carries its own hue, so the row icon shows the
                // dyed item we're actually offering. (The buy side needs nothing here:
                // its rows pair to the vendor container's `contItems`, which are hued.)
                let hue = look.item_hue(it.graphic, it.hue);
                if hue != 0 {
                    v["hue"] = json!(hue);
                }
                v
            })
            .collect();
        json!({ "vendor": sl.vendor, "items": items })
    });
    let shop = if shop_buy.is_none() && shop_sell.is_none() {
        Value::Null
    } else {
        json!({ "buy": shop_buy, "sell": shop_sell })
    };
    let shop = serde_json::to_string(&shop).unwrap_or_else(|_| "null".into());

    // Targeting UI state: is the server waiting for a target, is it an
    // object (kind 0) or ground (kind 1) cursor, and is the pending action
    // neutral / harmful / beneficial (`flag`, the 0x6C cursor-type byte —
    // ClassicUO's `TargetType`: 0 neutral, 1 harmful, 2 beneficial; 3 = cancel
    // never reaches here because it clears `pending_target` instead). The
    // client colours the reticle from it and gates its criminal-action confirm
    // on it — out of war mode an offensive spell otherwise looks exactly like a
    // heal. Already decoded by the core (`World::TargetCursor::cursor_flag`);
    // this only stopped it being dropped on the way to the browser.
    let target = match s.world.pending_target {
        Some(tc) => json!({ "active": 1, "kind": tc.target_type, "flag": tc.cursor_flag }),
        None => json!({ "active": 0, "kind": 0, "flag": 0 }),
    };
    // Pending 0x99 house/multi placement footprint, if any — see
    // `placement_json`'s doc. Formatted below into an optional (possibly
    // empty) fragment so an idle scene keeps serializing byte-identical to
    // before this field existed.
    let placement = placement_json(&s.world, multis);
    // House-designer editor snapshot, if we're currently customizing a house —
    // see `house_design_json`'s doc. Same "omit, don't null" convention as
    // `placement` right above.
    let house_design = house_design_json(&s.world, multis);

    // NOTE: `Look` holds a shared borrow of the map and must not outlive this
    // point — the tile loop below needs the `&mut` one (HasSurfaceOverhead
    // writes the statics cache). No explicit `drop` is needed: `look`'s last use
    // is above, and NLL ends the borrow there.

    let TileEmission {
        mut tiles,
        mut statics,
        dbg,
    } = match map {
        Some(map) => {
            apply_surface_overhead(&s.world, map, multis, max_z, &mut mobiles);
            let emission = emit_tiles(
                &s.world,
                map,
                multis,
                animdata,
                &mut art,
                (px, py, pz),
                max_z,
                no_draw_roofs,
                &mut lights,
            );
            // After the tile loop, so the static/multi torches it appends are
            // occluded by the same rule the item ones are.
            apply_light_occlusion(&s.world, map, multis, max_z, &mut lights);
            emission
        }
        None => TileEmission::default(),
    };
    mark("emit_tiles", &mut t);
    // Drop the trailing commas left by the per-entry writes.
    if tiles.ends_with(',') {
        tiles.pop();
    }
    if statics.ends_with(',') {
        statics.pop();
    }

    mark("dialogs+feeds", &mut t);
    // Small parts go through serde (cheap + handles string escaping for names).
    let mut player = json!({
        "serial": p.serial,
        "x": p.pos.x, "y": p.pos.y, "z": p.pos.z, "dir": p.direction,
        "body": p_body, "dead": player_is_ghost(&s.world), "at": p_atype, "name": p.name,
        "noto": p.notoriety,  // self notoriety (innocent/criminal/murderer…) → name-overhead colour
        "hue": p_hue,
        "mounted": mounted, "mountAnim": player_mount_anim, "mountOff": player_mount_off,
        "hits": p.hits, "hitsMax": p.hits_max, "mana": p.mana, "manaMax": p.mana_max,
        "stam": p.stam, "stamMax": p.stam_max,
        "str": st.strength, "dex": st.dexterity, "int": st.intelligence, "gold": st.gold,
        // The rest of 0x11's status sheet. All of it was already parsed into
        // `PlayerStats` and simply never left the server, so the client could
        // only ever show HP/mana/stam/str/dex/int/gold.
        "armor": st.armor, "resistFire": st.fire_resistance, "resistCold": st.cold_resistance,
        "resistPoison": st.poison_resistance, "resistEnergy": st.energy_resistance,
        "weight": st.weight, "weightMax": st.weight_max, "statsCap": st.stats_cap,
        "followers": st.followers, "followersMax": st.followers_max,
        "luck": st.luck, "damageMin": st.damage_min, "damageMax": st.damage_max,
        "tithing": st.tithing_points,
        // 0x11's ML race byte (1 human / 2 elf / 3 gargoyle). 0 = the shard
        // never sent one — every pre-ML server, this one included — and the
        // renderer falls back to ClassicUO's other rule, the body graphic
        // (`Mobile.CheckGraphicChange`). The racial-abilities book is the only
        // thing that needs it.
        "race": st.race,
        // 0x11's `type >= 6` combat tail. All zero on a shard that never sends
        // it (this one), which is indistinguishable from a character with no
        // such bonuses — the same ambiguity ClassicUO lives with, since the
        // packet carries no "absent" marker.
        "maxResistPhysical": st.aos.max_physical_resistance,
        "maxResistFire": st.aos.max_fire_resistance,
        "maxResistCold": st.aos.max_cold_resistance,
        "maxResistPoison": st.aos.max_poison_resistance,
        "maxResistEnergy": st.aos.max_energy_resistance,
        "defenseChance": st.aos.defense_chance_increase,
        "defenseChanceMax": st.aos.max_defense_chance_increase,
        "hitChance": st.aos.hit_chance_increase,
        "swingSpeed": st.aos.swing_speed_increase,
        "damageChance": st.aos.damage_increase,
        "lowerRegCost": st.aos.lower_reagent_cost,
        "spellDamage": st.aos.spell_damage_increase,
        "fasterCastRecovery": st.aos.faster_cast_recovery,
        "fasterCasting": st.aos.faster_casting,
        "lowerManaCost": st.aos.lower_mana_cost,
        // Stat training locks (0 up / 1 down / 2 locked) — the `statlock`
        // command's other half, so the UI can show what it is toggling.
        "strLock": st.str_lock, "dexLock": st.dex_lock, "intLock": st.int_lock,
        "equip": equip,
    });
    merge_obj(&mut player, hidden_field(p.hidden));
    merge_obj(&mut player, flying_field(p.flying));
    merge_obj(&mut player, poisoned_field(p.poisoned));
    let sounds = json_array(&sounds_json(&s.world));
    let anims = json_array(&anims_json(&s.world));
    let tanims = json_array(&typed_anims_json(&s.world));
    let damage = json_array(&damage_json(&s.world));
    let effects = json_array(&effects_json(&s.world, animdata));
    let drag_anims = json_array(&drag_anims_json(&s.world));
    let music = match s.world.current_music {
        Some(id) => id.to_string(),
        None => "null".to_string(),
    };
    // Day/night + weather: the renderer darkens the scene by `light` and animates
    // rain/snow particles for the matching `weather` kind (`weatherN` = intensity).
    let light = s.world.effective_light();
    let weather = s.world.weather.kind;
    let weather_n = s.world.weather.intensity;
    // Current season (0xBC). It reaches the client for the weather/UI, but the
    // work it drives happens in `scene::season`: the season substitutes DRAW
    // graphics only (grass → snow, green tree → bare), while every pathing field
    // stays on the original graphic because ServUO's `MovementImpl` reads the raw
    // map/statics ids and never consults `Map.Season`. See that module for why we
    // deliberately diverge from ClassicUO here.
    let season = season::scene_season(s.world.season);
    let buffs = json_array(&buffs_json(&s.world, cliloc));
    let skills = json_array(&skills_json(&s.world));
    let lights = json_array(&lights);
    let mobiles = json_array(&mobiles);
    let items = json_array(&items);
    let cont_items = json_array(&cont_items);
    let target = serde_json::to_string(&target).unwrap_or_else(|_| "{}".into());
    let dbg = json_array(&dbg);
    let journal = json_array(journal);
    // Open server gumps/dialogs (0xB0/0xDD), each parsed into positioned elements.
    let gumps = gumps_json(&s.world, cliloc);
    // The open right-click context menu (0xBF/0x14), with cliloc labels resolved.
    let popup =
        serde_json::to_string(&popup_json(&s.world, cliloc)).unwrap_or_else(|_| "null".into());
    // Legacy item/question menus (0x7C), potentially several at once.
    let legacy_menus = json_array_value(&legacy_menus_json(&s.world));
    // Server dye hue pickers (0x95), potentially several callback serials.
    let hue_pickers = json_array_value(&hue_pickers_json(&s.world));
    let race_change =
        serde_json::to_string(&race_change_json(&s.world)).unwrap_or_else(|_| "null".into());
    // Concurrent 0xA6 Tip/Notice windows. Only kind "tip" has prev/next.
    let tips = json_array_value(&tips_json(&s.world));
    // Concurrent modal 0xAB text-entry dialogs, keyed in the browser by seq.
    let text_entry_dialogs = json_array_value(&text_entry_dialogs_json(&s.world));
    // Persistent 0xB8 character profile windows, keyed by exact response seq.
    let profiles = json_array_value(&character_profiles_json(&s.world));
    let logout_ack =
        serde_json::to_string(&logout_ack_json(&s.world)).unwrap_or_else(|_| "null".into());
    let boat_moves = json_array_value(&boat_movements_json(&s.world));
    // The open book (0x93/0xD4 + 0x66), or null.
    let book = serde_json::to_string(&book_json(&s.world)).unwrap_or_else(|_| "null".into());
    // Known spellbook contents (0xBF/0x1B), one entry per book we've been told
    // about this session (see `World::spellbooks`'s doc — populated only once a
    // book is actually opened). `content` is a 64-bit mask; split into two u32
    // halves (`lo` = bits 0..31, `hi` = bits 32..63) rather than sent whole,
    // because a JS `Number` only carries 53 bits of integer precision and a full
    // 64-spell Magery book can set bits past that — the renderer tests a bit
    // with plain 32-bit ops on whichever half it falls in, no BigInt needed.
    // Sorted by serial for a stable order (the source is a HashMap).
    let mut spellbooks: Vec<(&u32, &anima_core::world::SpellbookContent)> =
        s.world.spellbooks.iter().collect();
    spellbooks.sort_by_key(|&(serial, _)| *serial);
    let spellbooks: Vec<Value> = spellbooks
        .iter()
        .map(|&(serial, sb)| {
            json!({
                "serial": serial, "graphic": sb.graphic, "offset": sb.offset,
                "lo": (sb.content & 0xFFFF_FFFF) as u32, "hi": (sb.content >> 32) as u32
            })
        })
        .collect();
    let spellbooks = json_array(&spellbooks);
    // Object Property Lists / tooltips (0xD6), resolved to display lines, capped.
    let opl = serde_json::to_string(&opl_json(&s.world, cliloc)).unwrap_or_else(|_| "{}".into());
    // The on-screen quest arrow target tile (0xBA), or null.
    let quest_arrow = match s.world.quest_arrow {
        Some((x, y)) => format!("{{\"x\":{x},\"y\":{y}}}"),
        None => "null".to_string(),
    };
    // The player's party (0xBF/0x06): leader, members (name/hits from view), invite.
    let party = serde_json::to_string(&party_json(&s.world)).unwrap_or_else(|_| "{}".into());
    // Where out-of-view party/guild members are (0xF0) — the world map's only
    // source for anyone past our ~18-tile view.
    let tracked = serde_json::to_string(&tracked_json(&s.world)).unwrap_or_else(|_| "{}".into());
    // Combat state: war mode (0x72) and the current "last target" serial (0 = none)
    // so the client can show a war indicator and highlight the attacked mobile.
    let war = s.world.war;
    let last_attack = s.world.last_attack.unwrap_or(0);
    // The server's authoritative combat opponent (0xAA ChangeCombatant, 0 = none)
    // — distinct from `lastAttack` (the serial WE last sent an Attack request
    // for): the server can retarget on its own.
    let combatant = s.world.combatant.unwrap_or(0);
    // AOS expansion (SupportedFeatures 0xB9): gates AOS-only UI like the weapon
    // special-ability bar. T2A servers don't advertise it → the client hides it.
    // Container gump art, by container serial (0x24 DrawContainer). The window
    // is drawn from this instead of a bare grid, and it is retained state
    // rather than an event — see `World::container_gumps`.
    let container_gumps = serde_json::to_string(
        &s.world
            .container_gumps
            .iter()
            .map(|(serial, gump)| (serial.to_string(), *gump))
            .collect::<std::collections::BTreeMap<_, _>>(),
    )
    .unwrap_or_else(|_| "{}".into());
    // Bulletin boards (0x71): the open board with its summary lines, and the
    // most recently fetched full body. Decoded since the codec landed with no
    // consumer until the posting verbs existed.
    let bboard = serde_json::to_string(&match s.world.bulletin_board.as_ref() {
        Some(b) => json!({
            "serial": b.serial, "name": b.name,
            "summaries": b.summaries.iter().map(|m| json!({
                "serial": m.serial, "parent": m.parent, "poster": m.poster,
                "subject": m.subject, "datetime": m.datetime,
            })).collect::<Vec<_>>(),
            "message": match s.world.bulletin_message.as_ref() {
                Some(m) => json!({
                    "serial": m.serial, "poster": m.poster, "subject": m.subject,
                    "datetime": m.datetime, "body": m.body,
                }),
                None => Value::Null,
            },
        }),
        None => Value::Null,
    })
    .unwrap_or_else(|_| "null".into());
    // Server chat system (0xB2): status, the channel we are in, the channels it
    // has advertised, and the received lines. The lines are a seq-stamped ring
    // like `sounds`/`damage`, NOT a delta — the renderer keeps the highest seq
    // it has printed. Everything here was decoded from the day the codec landed
    // and had no consumer until the chat verbs existed.
    let chat = serde_json::to_string(&json!({
        "enabled": s.world.chat.enabled as u8,
        "channel": s.world.chat.current_channel,
        "channels": s.world.chat.channels.iter()
            .map(|c| json!({ "name": c.name, "hasPassword": c.has_password }))
            .collect::<Vec<_>>(),
        "lines": s.world.chat_messages.iter()
            .map(|m| json!({ "seq": m.seq, "sender": m.sender, "text": m.text }))
            .collect::<Vec<_>>(),
    }))
    .unwrap_or_else(|_| "null".into());
    let aos = s.world.aos;
    // What the link to the game server is doing (ClassicUO's NetStatistics).
    // Totals, not rates: the browser polls this on its own cadence and can
    // difference them itself, which beats a second timer here guessing at a
    // window it cannot see.
    let net = json!({
        // Microseconds, and null until a ping has actually come back: this
        // server is usually on the same machine as the shard, where a whole
        // millisecond is several round trips.
        "pingUs": s.stats.ping_us(),
        "in": s.stats.bytes_in, "out": s.stats.bytes_out,
        "pin": s.stats.packets_in, "pout": s.stats.packets_out,
    });
    // The weapon special move armed for the next swing (0 = none). The bar used
    // to track this purely client-side, which meant its highlight outlived every
    // use: the server takes the arm away with 0xBF/0x21 and says nothing else.
    let armed_ability = s.world.armed_ability;
    // Spell ids the server has toggled on (0xBF/0x25) — Bushido/Ninjitsu stances
    // and the like — so the spellbook can light up the ones actually running.
    let active_spells = json_array(
        &s.world
            .active_spell_icons
            .iter()
            .map(|s| json!(s))
            .collect::<Vec<_>>(),
    );
    // An outstanding 0x9A ASCII / 0xC2 Unicode server prompt, or `{"active":0}`.
    // See [`prompt_json`]'s doc.
    let prompt =
        serde_json::to_string(&prompt_json(&s.world)).unwrap_or_else(|_| "{\"active\":0}".into());
    // Recent lift-rejection events (0x27 LiftRej): the client clears the drag-ghost
    // (without sending a drop — the item never left its source) and shows `reason`
    // as a system journal line, for each `seq` newer than the last it handled.
    let lift_rejects: Vec<Value> = s
        .world
        .recent_lift_rejects
        .iter()
        .map(|&(seq, reason)| json!({ "seq": seq, "reason": reason }))
        .collect();
    let lift_rejects = json_array(&lift_rejects);
    // Item-drag completion acknowledgements (0x28 EndDraggingItem / 0x29
    // DropItemAccepted). The browser correlates these with pending placements
    // before clearing its cursor, protecting a newer lift from a delayed ack.
    let drag_completions = json_array_value(&drag_completions_json(&s.world));
    let death_screen =
        serde_json::to_string(&death_screen_json(&s.world)).unwrap_or_else(|_| "null".into());
    // Recent server-initiated container opens (0x24 DrawContainer): a window we
    // did NOT ourselves double-click for (banker "bank" speech, GM `[bank`, a
    // snoop, …). The client opens a window for each `seq` newer than the last it
    // handled (reusing the same `openContainer` it uses for its own double-clicks).
    // Filtered by `container_opens_json` to real container gumpIds — see its doc.
    let container_opens = json_array_value(&container_opens_json(&s.world));
    // Recent Swing events (0x2F): `attacker` just swung at `defender`. Purely
    // cosmetic — the client briefly faces the attacker toward the defender.
    let swings: Vec<Value> = s.world.recent_swings
        .iter()
        .map(|&(seq, attacker, defender)| json!({ "seq": seq, "attacker": attacker, "defender": defender }))
        .collect();
    let swings = json_array(&swings);
    let deaths = json_array(&deaths);
    // The latest server-initiated paperdoll open/refresh (0x88), or null. See
    // `paperdoll_json`'s doc for the `seq` "fresh request" semantics.
    let paperdoll =
        serde_json::to_string(&paperdoll_json(&s.world)).unwrap_or_else(|_| "null".into());
    // Validated 0xA5 external-page requests. The browser seq-gates these and
    // requires an explicit click before opening a new tab.
    let open_urls = json_array_value(&open_urls_json(&s.world));
    // Current facet/map index (0xBF/0x08 MapChange); see `World::map_index`'s doc
    // for what a real per-facet `MapData` reload would additionally require.
    let facet = s.world.map_index;
    // Every open secure-trade session (0x6F), or []. See `trades_json`'s doc.
    let trades = json_array_value(&trades_json(&s.world));
    // Open treasure/decoration map windows (0x90/0xF5 + 0x56), or []. See `maps_json`'s doc.
    let maps = json_array_value(&maps_json(&s.world));
    // Purely additive: omit the key entirely when nothing is pending (see
    // `placement_json`'s doc), rather than a `"placement":null`, so an idle
    // scene's JSON is unchanged from before this field existed.
    let placement_field = match placement {
        Some(v) => format!(
            ",\"placement\":{}",
            serde_json::to_string(&v).unwrap_or_else(|_| "null".into())
        ),
        None => String::new(),
    };
    // Purely additive, same convention as `placement_field` right above: omit
    // the key entirely when nobody is customizing a house.
    let house_design_field = match house_design {
        Some(v) => format!(
            ",\"houseDesign\":{}",
            serde_json::to_string(&v).unwrap_or_else(|_| "null".into())
        ),
        None => String::new(),
    };
    mark("small_parts", &mut t);
    let no_draw_roofs_u8 = u8::from(no_draw_roofs);
    let session_id = serde_json::to_string(s.id()).unwrap();
    let layout_identity = serde_json::to_string(s.layout_identity()).unwrap();
    format!(
        "{{\"sessionId\":{session_id},\"layoutIdentity\":{layout_identity},\"player\":{player},\
         \"map\":{{\"cx\":{px},\"cy\":{py},\"radius\":{LAND_RADIUS},\"viewRange\":{RADIUS},\"tiles\":[{tiles}],\"maxZ\":{max_z},\"maxGroundZ\":{max_ground_z},\"noDrawRoofs\":{no_draw_roofs_u8},\"dbg\":{dbg}}},\
         \"statics\":[{statics}],\"mobiles\":{mobiles},\"items\":{items},\"contItems\":{cont_items},\
         \"target\":{target},\"shop\":{shop},\"journal\":{journal},\"sounds\":{sounds},\"anims\":{anims},\"tanims\":{tanims},\"damage\":{damage},\"effects\":{effects},\"dragAnims\":{drag_anims},\"music\":{music},\
         \"light\":{light},\"weather\":{weather},\"weatherN\":{weather_n},\"season\":{season},\"lights\":{lights},\"buffs\":{buffs},\"skills\":{skills},\"gumps\":{gumps},\
         \"popup\":{popup},\"legacyMenus\":{legacy_menus},\"huePickers\":{hue_pickers},\"raceChange\":{race_change},\"tips\":{tips},\"textEntryDialogs\":{text_entry_dialogs},\"profiles\":{profiles},\"logoutAck\":{logout_ack},\"boatMoves\":{boat_moves},\"book\":{book},\"spellbooks\":{spellbooks},\"opl\":{opl},\"questArrow\":{quest_arrow},\"party\":{party},\"tracked\":{tracked},\
         \"war\":{war},\"lastAttack\":{last_attack},\"combatant\":{combatant},\"aos\":{aos},\
         \"armedAbility\":{armed_ability},\"activeSpells\":{active_spells},\"chat\":{chat},\"bboard\":{bboard},\"contGumps\":{container_gumps},\"contInfo\":{cont_info},\
         \"prompt\":{prompt},\"liftRejects\":{lift_rejects},\"dragCompletions\":{drag_completions},\"deathScreen\":{death_screen},\"containerOpens\":{container_opens},\"swings\":{swings},\
         \"paperdoll\":{paperdoll},\"openUrls\":{open_urls},\"facet\":{facet},\"trades\":{trades},\"maps\":{maps}{placement_field}{house_design_field},\
         \"deaths\":{deaths},\"net\":{net},\
         \"stats\":{{\"confirms\":{},\"denies\":{}}}}}",
        s.confirms, s.denies
    )
}

/// Map window for the asset-only server (`GET /terrain.json`, the replay viewer's map).
///
/// Same `map` + `statics` (+ static `lights`) shape [`build_scene`] emits, built
/// from map files only — no live [`Session`]. A stub player at `center` drives
/// [`max_draw_z`] so cave/roof culling matches the play-server path.
pub fn build_terrain_window(
    map: &mut MapData,
    multis: Option<&Multis>,
    animdata: Option<&AnimData>,
    art: Option<&mut Art>,
    center: (i64, i64, i32),
    season: u8,
) -> String {
    let (px, py, pz) = center;
    let mut world = World::new();
    world.season = season;
    world.player = Some(anima_core::types::Serial(1));
    world.mobiles.insert(
        1,
        anima_core::world::Mobile {
            serial: 1,
            pos: anima_core::types::Position {
                x: px.clamp(0, u16::MAX as i64) as u16,
                y: py.clamp(0, u16::MAX as i64) as u16,
                z: pz.clamp(i8::MIN as i32, i8::MAX as i32) as i8,
            },
            ..Default::default()
        },
    );
    let ceiling = max_draw_z(&world, map, multis, px, py, pz);
    let mut lights = Vec::new();
    let mut art = art;
    let TileEmission {
        mut tiles,
        mut statics,
        dbg,
    } = emit_tiles(
        &world,
        map,
        multis,
        animdata,
        &mut art,
        center,
        ceiling.max_z,
        ceiling.no_draw_roofs,
        &mut lights,
    );
    if tiles.ends_with(',') {
        tiles.pop();
    }
    if statics.ends_with(',') {
        statics.pop();
    }
    let dbg = json_array(&dbg);
    let lights = json_array(&lights);
    let no_draw_roofs_u8 = u8::from(ceiling.no_draw_roofs);
    format!(
        "{{\"map\":{{\"cx\":{px},\"cy\":{py},\"radius\":{LAND_RADIUS},\"viewRange\":{RADIUS},\"tiles\":[{tiles}],\"maxZ\":{},\"maxGroundZ\":{},\"noDrawRoofs\":{no_draw_roofs_u8},\"dbg\":{dbg}}},\
         \"statics\":[{statics}],\"lights\":{lights}}}",
        ceiling.max_z, ceiling.max_ground_z
    )
}

#[cfg(test)]
mod tests;
