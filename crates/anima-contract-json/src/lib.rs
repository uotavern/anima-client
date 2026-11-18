// `observation_to_json`'s literal has one key per Observation field, and
// `json!` expands recursively once per key — so the object outgrew rustc's
// default 128-frame limit purely by growing, not by nesting. serde_json
// documents raising it as the fix.
#![recursion_limit = "512"]

//! Versioned JSON wire format for the brain↔body contract.
//!
//! `anima-core` stays serde-free, so the JSON shapes for its
//! [`Observation`]/[`Action`] live in this small adapter crate. Native,
//! out-of-process, and WASM consumers share it instead of mirroring schemas.
//! The shapes are also mirrored by `anima2/anima2/contract.py` — keep that
//! consumer in lockstep.
//!
//! ## Schema (v16 — snake_case, versioned)
//!
//! [`observation_to_json`] emits one object with these top-level keys, one per
//! [`Observation`] field: `player`, `mobiles`, `items`, `new_journal`,
//! `pending_target`, `skills`, `gumps`, `prompt`, `trades`, `buffs`,
//! `shop_buy`, `shop_sell`, `popup`, `legacy_menus`, `hue_pickers`, `race_change`, `open_urls`, `tips`,
//! `text_entry_dialogs`, `character_profiles`, `logout_ack`, `book`, `party`, `quest_arrow`, `waypoints`,
//! `weather`, `season`, `light`, `war`, `last_attack`, `combatant`, `corpse_of`,
//! `corpse_equip`, `map_index`, `aos`, `opl`, `recent_damage`, `spellbooks`,
//! `map_gumps`. A
//! gump's `elements` are the structured [`anima_core::gump_layout::GumpElement`]s
//! (see [`gump_element_json`]) — a cliloc-driven `html` element carries the
//! raw `{"id":..,"args":..}` reference *unresolved* (no Cliloc table is
//! threaded through this bridge; see that function's doc). `opl`'s property
//! lines are unresolved the same way — `{"cliloc": id, "args": ".."}` per
//! line, name first. `spellbooks` entries carry `content` split into `lo`/`hi`
//! u32 halves (see [`spellbook_json`]) rather than one 64-bit number, for the
//! same reason the scene bridge splits it: a JS-side (or any float-backed
//! JSON) consumer only keeps 53 bits of integer precision, which a full
//! 64-spell Magery book's mask can exceed. `map_gumps` entries (see
//! [`map_view_json`]) carry a treasure/decoration map's pixel-space pins
//! straight through — no Cliloc/rescale involved (ServUO already converts
//! bounds↔pixel server-side; see [`anima_core::world::MapView`]'s doc).
//!
//! Deliberately **excluded** (no decision-relevant signal): `current_music`,
//! `recent_container_opens` (0x24 — a window-opening UI signal; the contents
//! arrive in `items` anyway), `recent_swings` (0x2F — ServUO sends it only to
//! the attacker, so it never says who is attacking *us*), `paperdoll`
//! (0x88 — a UI-open signal + display title, not something a brain decides
//! from; equipment state is already in `items`/worn `layer`). `PlayerStats::
//! is_female` is also excluded — purely cosmetic (paperdoll gump selection),
//! never gameplay-relevant. `recent_damage` is *not* excluded — combat brains
//! need per-hit attribution (another mobile's HP otherwise only arrives as a
//! coarse scaled percentage); dedupe on `seq` across polls like the
//! renderer's scene bridge does.
//!
//! Bump the schema marker above and [`SCHEMA_VERSION`] (and note the change here)
//! whenever a key is renamed or removed — the Python side keys off these names verbatim. (v3:
//! added `opl`, `recent_damage`. v4: added `spellbooks`. v5: added `items[].
//! is_multi` — a placed boat/house leaks into `items` as an ordinary-looking
//! entry, but its `graphic` is a *multi id* (an index into
//! `multi.idx`/`multi.mul`), not an ART graphic, and small multi ids collide
//! with real ART ids (e.g. multi id `0x0002`). A brain must check `is_multi`
//! before treating `graphic` as an ART id — see [`ItemView`]'s doc. v6: added
//! `map_gumps` — treasure/decoration map windows (0x90/0xF5 DisplayMap(New) +
//! 0x56 MapCommand), so a brain can locate a decoded treasure map's pins
//! without a human reading the parchment. v7: added `player.body`,
//! `player.poisoned`, and `player.dead` so survival brains receive status that
//! the core world already tracks. v8: added `waypoints`, the server's 0xE5
//! corpse/resurrection/quest markers with 0xE6 removal semantics. v9: added
//! `legacy_menus`, the server's concurrent 0x7C item/question menus. v10:
//! added `hue_pickers`, the server's concurrent 0x95 dye color pickers. v11:
//! added `prompt.kind` (`"ascii"` or `"unicode"`) so consumers can preserve
//! the identity of legacy 0x9A prompts separately from 0xC2 prompts. v12:
//! added `open_urls`, validated 0xA5 HTTP(S) navigation requests carrying a
//! monotonic `seq`; consumers must still ask the user before opening one. v13:
//! added `tips`, concurrent 0xA6 Tip/Notice windows, plus `TipNavigate` and
//! `TipClose` actions. v14: added concurrent 0xAB `text_entry_dialogs` plus
//! `TextEntryResponse` and `TextEntryClose` actions. v15: added 0xB8
//! `character_profiles` plus `ProfileRequest`, `ProfileUpdate`, and
//! `ProfileClose` actions. v16: added 0xD1 `logout_ack` plus the `Logout`
//! action. v17: added `terrain` — local walkability, the first field that
//! comes from the map files rather than a packet, so a brain can finally tell
//! a wall from open ground instead of delegating every route to the driver;
//! `null` unless the driver surveyed it. Same version added `Say`'s optional
//! `mode` (whisper/yell/emote/guild/alliance — absent still means plain
//! speech) and the `StatLock` action. v18: journal lines gained `display` —
//! the cliloc resolved to real words — plus 0xCC's `affix`/`affix_prepend`.
//! A brain could previously be told "you have been added to the party" and
//! receive `#1005445`; `text` still carries the raw args. v19: added
//! `armed_ability` and `active_spell_icons` — the combat state the arming
//! side of the contract had no readback for. A brain that sent `UseAbility`
//! previously had no way to learn the move had been spent (the server
//! acknowledges an arm only by revoking it, 0xBF/0x21), so it could not tell
//! "armed and waiting" from "already used". Same version added the
//! `DisarmRequest`/`StunRequest` (pre-AOS specials) and `BandageTarget`
//! (one-packet heal, no target cursor) actions. v20: added the actions that
//! finish the party surface — `PartyKick`, `PartyPrivateMessage`,
//! `PartySetCanLoot` — plus `StatusRequest`, which resyncs a party member's
//! vitals: ServUO pushes their mana/stam changes only while they are in
//! update range and visible, so a member you lost sight of stays frozen at
//! whatever you last saw until something asks. Note that every party-facing
//! vitals packet is run through ServUO's `AttributeNormalizer` (max fixed at
//! 25, current scaled) — a brain reads another member's mana as a fraction,
//! never as spendable points. No new observation fields; `party` already
//! carries the roster. v21: added `Rename` (0x75, in practice pet naming),
//! `QuestArrowClick`, `HelpRequest` (the GM-page entry point) and the
//! `GuildMenu`/`QuestMenu` requests. All five answer with an ordinary server
//! gump or a journal line, so nothing new is needed to *read* the result —
//! these were purely missing outgoing verbs. v22: exposed the server chat
//! system, whose receive half (0xB2) had been fully decoded since the codec
//! landed with nothing above it — `chat` (enabled/current channel/channels)
//! and `chat_messages` (a seq-stamped ring, dedupe like `recent_damage`),
//! plus the `ChatOpen`/`ChatJoin`/`ChatCreate`/`ChatLeave`/`ChatSay` actions.
//! `ChatOpen` must come first: ServUO drops every other chat action from a
//! sender it has not registered as a chat user, silently. v23: map pins became
//! writable — `MapToggleEditable`, `MapAddPin`, `MapInsertPin`,
//! `MapChangePin`, `MapRemovePin`, `MapClearPins` (0x56). `MapToggleEditable`
//! must come first for the same kind of reason `ChatOpen` does: ServUO gates
//! every mutator on the map being in edit mode and drops the rest silently.
//! No new observation fields — `map_gumps` already carried the pins. v24:
//! books became writable — `BookHeaderChange` (0xD4) and `BookPageWrite`
//! (0x66). Both are silently all-or-nothing server-side: an over-long title,
//! a ninth line or an 80-character line makes ServUO discard the whole packet,
//! so the builders clamp and a caller confirms by re-reading `book`. v25:
//! `BoatMove`/`BoatStop` (0xBF/0x33) steer a piloted ship. The player must be
//! piloting first — double-click the tiller man — and nothing reports the
//! omission; `player.mounted` turning true is the signal it took. v26: bulletin
//! boards gained `bulletin_board`/`bulletin_message` plus
//! `BulletinRequestMessage`/`BulletinRequestSummary`/`BulletinPost`/
//! `BulletinRemove` (0x71). The decode and all four builders already existed
//! with no caller; only this layer was missing. v27: `player.race` (0x11's ML
//! race byte, 0 when the shard never sends one) and `ToggleFlying`
//! (0xBF/0x32), the racial-abilities book's only non-passive entry. v28: the
//! whole `type >= 6` tail of 0x11 — the five resistance caps and the ten
//! combat/casting modifiers — flat on `player`. All zero unless the shard is
//! ML+ and the client asked for the extended status; nothing on the wire
//! distinguishes "absent" from "no bonuses". v29: added `TargetedSpell`
//! (0xBF/0x2D), `TargetedSkill` (0xBF/0x2E) and `TargetByResource` (0xBF/0x30)
//! — the bandage-target siblings. Spell ids are 1-based like `CastSpell`;
//! skill ids are 0-based like `UseSkill`; `target` 0 is self. v30: ClassicUO
//! `GameActions` verbs that had no Action — `OpenDoor` (0x12/0x58, facing-tile
//! door, not a double-click), `EquipLastWeapon` (0xD7/0x1E), `InvokeVirtue`
//! (0x12/0xF4, 1-based), `EmoteAction` (0x12/0xC7), `CastSpellFromBook`
//! (0x12/0x27) and `AllNames` (a burst of single-clicks). v31: 0xBF/0x2A
//! heritage / race-change (`race_change` plus `ChangeRace`/`ChangeRaceCancel`)
//! and `OpenUOStore` (0xFA). Pre-OPL equipment info (0xBF/0x10) rides the
//! existing journal — no new observation key. v32: `mobiles[]` gained the
//! condition any client draws on another mobile — `poisoned`/`poison_level`,
//! `paralyzed`, `war_mode`, `hidden`, `yellow_health`, `running` and
//! `direction`. The core had tracked every one of them for the renderer; a
//! brain judging an opponent ("is it paralyzed — cast the heavy spell now?")
//! could see only its hits. v33: everything else the core already tracked and
//! a brain could not see. `player` gained `hidden`, `paralyzed`,
//! `poison_level`, `notoriety`, `hue`, `mounted` (the key the v25 note above
//! promised and never shipped), `luck`, `damage_min`/`damage_max`,
//! `tithing_points`, `stats_cap`, `str_lock`/`dex_lock`/`int_lock` and
//! `speed_mode`; `mobiles[]` gained `hue`, `flying`, `bonded_dead` and
//! `mana`/`mana_max`/`stam`/`stam_max` (party values normalized to a max of
//! 25); `items[]` gained `hue`, `name`, `movable`, `hidden` (null inside a
//! container, whose content packets carry no flags), and a contained
//! item's `distance` is now that of the ground container or mobile holding it
//! (it was measured from a spot inside the container window). `buffs[]` gained
//! the resolved `display`/`display_desc` and their clilocs; `opl[]` gained
//! `text`, the property lines in words. New keys: `party_positions` and
//! `guild_positions` (out-of-view members, 0xF0), and four `seq`-stamped rings
//! the renderer alone had consumed — `recent_effects` (kind 0 moving from
//! `src` to `tgt`, 1 lightning, 2 fixed at a spot, 3 fixed on `src`: a spell in
//! flight or being cast), `recent_anims`/`recent_typed_anims` (who swings or
//! casts), `recent_sounds` — plus `recent_lift_rejects` (why a lift failed;
//! ServUO writes no journal line for it), `recent_drag_completions` and
//! `pending_multi_placement` (0x99). Dedupe every ring on `seq`.)
//!
//! [`Observation`]: anima_core::agent::Observation
//! [`Action`]: anima_core::agent::Action

/// Current Observation/Action JSON schema version documented above.
pub const SCHEMA_VERSION: u32 = 33;

use anima_core::agent::{
    Action, GumpView, HouseDesignAction, ItemView, MobileView, Observation, PlayerView, SkillView,
    SpeechMode, TerrainView, WaypointView,
};
use anima_core::gump_layout::{GumpElement, HtmlText};
use anima_core::types::Position;
use anima_core::world::{
    Book, Buff, CharacterProfile, Effect, HuePicker, JournalEntry, LegacyMenu, LegacyMenuEntry,
    LegacyMenuKind, LogoutAck, MapView, OpenUrlRequest, Party, PopupEntry, PopupMenu, PromptState,
    RaceChangePrompt, ShopBuy, ShopSell, ShopSellItem, SpellbookContent, TargetCursor,
    TextEntryDialog, TipNotice, TrackedMember, TradeState, Weather,
};
use serde_json::{json, Value};

fn pos_json(p: &Position) -> Value {
    json!({ "x": p.x, "y": p.y, "z": p.z })
}

fn player_json(p: &PlayerView) -> Value {
    json!({
        "serial": p.serial, "name": p.name, "pos": pos_json(&p.pos),
        "direction": p.direction, "hits": p.hits, "hits_max": p.hits_max,
        "mana": p.mana, "mana_max": p.mana_max, "stam": p.stam, "stam_max": p.stam_max,
        "strength": p.strength, "dexterity": p.dexterity, "intelligence": p.intelligence,
        "gold": p.gold, "weight": p.weight, "weight_max": p.weight_max, "armor": p.armor,
        "followers": p.followers, "followers_max": p.followers_max,
        "fire_resistance": p.fire_resistance, "cold_resistance": p.cold_resistance,
        "poison_resistance": p.poison_resistance, "energy_resistance": p.energy_resistance,
        "body": p.body, "poisoned": p.poisoned, "dead": p.dead, "race": p.race,
        "hidden": p.hidden, "paralyzed": p.paralyzed, "poison_level": p.poison_level,
        "notoriety": p.notoriety, "hue": p.hue, "mounted": p.mounted, "luck": p.luck,
        "damage_min": p.damage_min, "damage_max": p.damage_max,
        "tithing_points": p.tithing_points, "stats_cap": p.stats_cap,
        "str_lock": p.str_lock, "dex_lock": p.dex_lock, "int_lock": p.int_lock,
        "speed_mode": p.speed_mode,
        "maxResistPhysical": p.aos_status.max_physical_resistance,
        "maxResistFire": p.aos_status.max_fire_resistance,
        "maxResistCold": p.aos_status.max_cold_resistance,
        "maxResistPoison": p.aos_status.max_poison_resistance,
        "maxResistEnergy": p.aos_status.max_energy_resistance,
        "defenseChance": p.aos_status.defense_chance_increase,
        "defenseChanceMax": p.aos_status.max_defense_chance_increase,
        "hitChance": p.aos_status.hit_chance_increase,
        "swingSpeed": p.aos_status.swing_speed_increase,
        "damageChance": p.aos_status.damage_increase,
        "lowerRegCost": p.aos_status.lower_reagent_cost,
        "spellDamage": p.aos_status.spell_damage_increase,
        "fasterCastRecovery": p.aos_status.faster_cast_recovery,
        "fasterCasting": p.aos_status.faster_casting,
        "lowerManaCost": p.aos_status.lower_mana_cost,
    })
}

fn mobile_json(m: &MobileView) -> Value {
    json!({
        "serial": m.serial, "name": m.name, "pos": pos_json(&m.pos), "body": m.body,
        "notoriety": m.notoriety, "hits": m.hits, "hits_max": m.hits_max, "distance": m.distance,
        "poisoned": m.status.poisoned, "poison_level": m.status.poison_level,
        "paralyzed": m.status.paralyzed, "war_mode": m.status.war_mode, "hidden": m.status.hidden,
        "yellow_health": m.status.yellow_health, "running": m.status.running,
        "direction": m.status.direction,
        "hue": m.status.hue, "flying": m.status.flying, "bonded_dead": m.status.bonded_dead,
        "mana": m.status.mana, "mana_max": m.status.mana_max,
        "stam": m.status.stam, "stam_max": m.status.stam_max,
    })
}

fn item_json(i: &ItemView) -> Value {
    json!({
        "serial": i.serial, "graphic": i.graphic, "amount": i.amount,
        "pos": pos_json(&i.pos), "container": i.container, "layer": i.layer,
        "distance": i.distance, "is_multi": i.is_multi,
        "hue": i.detail.hue, "name": i.detail.name, "movable": i.detail.movable,
        "hidden": i.detail.hidden,
    })
}

fn skill_json(s: &SkillView) -> Value {
    json!({ "id": s.id, "value": s.value, "base": s.base, "cap": s.cap, "lock": s.lock })
}

/// Serialize a parsed gump element. Positions/ids/pages mirror
/// [`GumpElement`]'s fields directly; an `html` element's `text` is
/// `{"literal": "..."}` when already resolved, or `{"cliloc": {"id":..,
/// "args":..}}` (unresolved — `args` is `null` for a plain `Cliloc::get`
/// lookup, a string for a `Cliloc::format` substitution) when it references a
/// cliloc the core can't look up itself.
fn gump_element_json(e: &GumpElement) -> Value {
    match e {
        GumpElement::Background { x, y, w, h, page } => {
            json!({"type": "background", "x": x, "y": y, "w": w, "h": h, "page": page})
        }
        GumpElement::Image {
            x,
            y,
            graphic,
            page,
        } => {
            json!({"type": "image", "x": x, "y": y, "graphic": graphic, "page": page})
        }
        GumpElement::Button {
            x,
            y,
            graphic,
            reply_id,
            pageflag,
            param,
            page,
        } => json!({
            "type": "button", "x": x, "y": y, "graphic": graphic, "reply_id": reply_id,
            "pageflag": pageflag, "param": param, "page": page,
        }),
        GumpElement::Text { x, y, w, s, page } => {
            json!({"type": "text", "x": x, "y": y, "w": w, "s": s, "page": page})
        }
        GumpElement::Html {
            x,
            y,
            w,
            h,
            text,
            page,
        } => {
            let text = match text {
                HtmlText::Literal(s) => json!({ "literal": s }),
                HtmlText::Cliloc { id, args } => json!({ "cliloc": { "id": id, "args": args } }),
            };
            json!({"type": "html", "x": x, "y": y, "w": w, "h": h, "text": text, "page": page})
        }
        GumpElement::Check { x, y, id, on, page } => {
            json!({"type": "check", "x": x, "y": y, "id": id, "on": on, "page": page})
        }
        // `group` matters: radios are mutually exclusive only within one, so a
        // consumer that ignores it can answer one question twice.
        GumpElement::Radio {
            x,
            y,
            id,
            on,
            group,
            page,
        } => {
            json!({"type": "radio", "x": x, "y": y, "id": id, "on": on,
                   "group": group, "page": page})
        }
        GumpElement::Entry {
            x,
            y,
            w,
            id,
            s,
            limit,
            page,
        } => {
            json!({"type": "entry", "x": x, "y": y, "w": w, "id": id, "s": s,
                   "limit": limit, "page": page})
        }
        GumpElement::TilePic {
            x,
            y,
            graphic,
            hue,
            page,
        } => {
            json!({"type": "tilepic", "x": x, "y": y, "graphic": graphic,
                   "hue": hue, "page": page})
        }
        GumpElement::TiledImage {
            x,
            y,
            w,
            h,
            graphic,
            page,
        } => {
            json!({"type": "tiled", "x": x, "y": y, "w": w, "h": h,
                   "graphic": graphic, "page": page})
        }
        GumpElement::Translucent { x, y, w, h, page } => {
            json!({"type": "translucent", "x": x, "y": y, "w": w, "h": h, "page": page})
        }
        GumpElement::PicInPic {
            x,
            y,
            graphic,
            sx,
            sy,
            w,
            h,
            page,
        } => {
            json!({"type": "picinpic", "x": x, "y": y, "graphic": graphic,
                   "sx": sx, "sy": sy, "w": w, "h": h, "page": page})
        }
        GumpElement::ButtonTileArt {
            x,
            y,
            graphic,
            reply_id,
            pageflag,
            param,
            art,
            hue,
            tile_x,
            tile_y,
            page,
        } => {
            json!({"type": "buttontileart", "x": x, "y": y, "graphic": graphic,
                   "reply_id": reply_id, "pageflag": pageflag, "param": param,
                   "art": art, "hue": hue, "tileX": tile_x, "tileY": tile_y,
                   "page": page})
        }
        // Both decorate the element *before* them (UO attaches a tooltip to
        // whatever was added last), so they carry no position of their own.
        GumpElement::Tooltip { cliloc, args, page } => {
            json!({"type": "tooltip", "cliloc": cliloc, "args": args, "page": page})
        }
        GumpElement::ItemProperty { serial, page } => {
            json!({"type": "itemproperty", "serial": serial, "page": page})
        }
    }
}

fn gump_json(g: &GumpView) -> Value {
    json!({
        "serial": g.serial, "gump_id": g.gump_id, "layout": g.layout,
        "elements": g.elements.iter().map(gump_element_json).collect::<Vec<_>>(),
    })
}

/// A journal line. `text` stays the raw payload — plain speech, or a cliloc's
/// tab-separated arguments — and `display` is the localized line a brain should
/// actually read (see [`anima_core::world::JournalEntry::display`]); it is
/// empty when the driver had no Cliloc table to resolve with.
fn journal_json(j: &JournalEntry) -> Value {
    json!({
        "serial": j.serial, "name": j.name, "text": j.text,
        "msg_type": j.msg_type, "hue": j.hue, "cliloc": j.cliloc,
        "display": j.display, "affix": j.affix, "affix_prepend": j.affix_prepend,
    })
}

fn target_json(t: &TargetCursor) -> Value {
    json!({ "target_type": t.target_type, "cursor_id": t.cursor_id, "cursor_flag": t.cursor_flag })
}

fn prompt_json(p: &PromptState) -> Value {
    json!({
        "sender_serial": p.sender_serial,
        "prompt_id": p.prompt_id,
        "kind": p.kind.as_str(),
    })
}

fn trade_json(t: &TradeState) -> Value {
    json!({
        "opponent_serial": t.opponent_serial, "opponent_name": t.opponent_name,
        "my_container": t.my_container, "their_container": t.their_container,
        "my_accept": t.my_accept, "their_accept": t.their_accept,
        "my_offer_gold": t.my_offer_gold, "my_offer_platinum": t.my_offer_platinum,
        "their_offer_gold": t.their_offer_gold, "their_offer_platinum": t.their_offer_platinum,
        "balance_gold": t.balance_gold, "balance_platinum": t.balance_platinum,
    })
}

fn buff_json(b: &Buff) -> Value {
    json!({
        "icon": b.icon, "name": b.name, "dur": b.dur,
        "title_cliloc": b.title_cliloc, "title_args": b.title_args,
        "desc_cliloc": b.desc_cliloc, "desc_args": b.desc_args,
        "display": b.display, "display_desc": b.display_desc,
    })
}

fn shop_buy_json(s: &ShopBuy) -> Value {
    let entries: Vec<Value> = s
        .entries
        .iter()
        .map(|e| {
            json!({
                "price": e.price, "name": e.name,
                "serial": e.serial, "graphic": e.graphic,
                "amount": e.amount, "hue": e.hue,
            })
        })
        .collect();
    json!({ "vendor": s.vendor, "container": s.container, "entries": entries })
}

fn shop_sell_item_json(i: &ShopSellItem) -> Value {
    json!({
        "serial": i.serial, "graphic": i.graphic, "hue": i.hue,
        "amount": i.amount, "price": i.price, "name": i.name,
    })
}

fn shop_sell_json(s: &ShopSell) -> Value {
    json!({
        "vendor": s.vendor,
        "items": s.items.iter().map(shop_sell_item_json).collect::<Vec<_>>(),
    })
}

/// Serialize one spellbook's known-contents mask (0xBF/0x1B), keyed by its own
/// serial. `content` is split into two u32 halves (`lo` = bits 0..31, `hi` =
/// bits 32..63) rather than sent whole — see this module's top doc for why.
fn spellbook_json((serial, sb): &(u32, SpellbookContent)) -> Value {
    json!({
        "serial": serial, "graphic": sb.graphic, "offset": sb.offset,
        "lo": (sb.content & 0xFFFF_FFFF) as u32, "hi": (sb.content >> 32) as u32,
    })
}

/// Serialize one open map window (0x90/0xF5 + 0x56), keyed by its own serial.
/// `pins` are `[x, y]` pairs in `width`×`height` pixel space (see [`MapView`]'s
/// doc — already server-converted, no rescale needed).
fn map_view_json((serial, mv): &(u32, MapView)) -> Value {
    json!({
        "serial": serial, "open_seq": mv.open_seq, "gump_art": mv.gump_art, "facet": mv.facet,
        "bounds": { "min_x": mv.min_x, "min_y": mv.min_y, "max_x": mv.max_x, "max_y": mv.max_y },
        "width": mv.width, "height": mv.height,
        "pins": mv.pins.iter().map(|&(x, y)| json!([x, y])).collect::<Vec<_>>(),
        "editable": mv.editable,
    })
}

fn popup_entry_json(e: &PopupEntry) -> Value {
    json!({ "index": e.index, "cliloc": e.cliloc, "flags": e.flags })
}

fn popup_json(p: &PopupMenu) -> Value {
    json!({
        "serial": p.serial,
        "entries": p.entries.iter().map(popup_entry_json).collect::<Vec<_>>(),
    })
}

fn legacy_menu_entry_json(index: usize, entry: &LegacyMenuEntry) -> Value {
    json!({
        "index": index + 1,
        "graphic": entry.graphic,
        "hue": entry.hue,
        "text": entry.text,
    })
}

fn legacy_menu_json(menu: &LegacyMenu) -> Value {
    let kind = match menu.kind {
        LegacyMenuKind::Items => "items",
        LegacyMenuKind::Question => "question",
    };
    json!({
        "serial": menu.serial,
        "menu_id": menu.menu_id,
        "question": menu.question,
        "kind": kind,
        "entries": menu.entries.iter().enumerate()
            .map(|(index, entry)| legacy_menu_entry_json(index, entry))
            .collect::<Vec<_>>(),
    })
}

fn hue_picker_json(picker: &HuePicker) -> Value {
    json!({ "serial": picker.serial, "graphic": picker.graphic })
}

fn race_change_json(prompt: &RaceChangePrompt) -> Value {
    json!({ "female": prompt.female, "race": prompt.race })
}

fn open_url_json(request: &OpenUrlRequest) -> Value {
    json!({ "seq": request.seq, "url": request.url })
}

fn tip_json(tip: &TipNotice) -> Value {
    json!({
        "seq": tip.seq,
        "tip": tip.tip,
        "kind": tip.kind.as_str(),
        "text": tip.text,
    })
}

fn text_entry_dialog_json(dialog: &TextEntryDialog) -> Value {
    json!({
        "seq": dialog.seq,
        "serial": dialog.serial,
        "parent_id": dialog.parent_id,
        "button_id": dialog.button_id,
        "text": dialog.text,
        "can_close": dialog.can_close,
        "variant": dialog.variant,
        "max_length": dialog.max_length,
        "description": dialog.description,
    })
}

fn character_profile_json(profile: &CharacterProfile) -> Value {
    json!({
        "seq": profile.seq,
        "serial": profile.serial,
        "header": profile.header,
        "footer": profile.footer,
        "body": profile.body,
        "can_edit": profile.can_edit,
    })
}

fn logout_ack_json(ack: &LogoutAck) -> Value {
    json!({ "seq": ack.seq, "allowed": ack.allowed })
}

fn book_json(b: &Book) -> Value {
    json!({
        "serial": b.serial, "title": b.title, "author": b.author,
        "writable": b.writable, "page_count": b.page_count, "pages": b.pages,
    })
}

fn party_json(p: &Party) -> Value {
    json!({ "members": p.members, "leader": p.leader, "pending_invite": p.pending_invite })
}

fn weather_json(w: &Weather) -> Value {
    json!({ "kind": w.kind, "intensity": w.intensity })
}

fn waypoint_json(w: &WaypointView) -> Value {
    json!({
        "serial": w.serial,
        "pos": pos_json(&w.pos),
        "map": w.map,
        "kind": w.kind,
        "ignore_object": w.ignore_object,
        "cliloc": w.cliloc,
        "name": w.name,
        "distance": w.distance,
    })
}

/// A raw OPL property line: `{"cliloc": id, "args": "tab\tseparated"}` — left
/// unresolved (no Cliloc table in this bridge; see the module doc).
fn opl_line_json((cliloc, args): &(u32, String)) -> Value {
    json!({ "cliloc": cliloc, "args": args })
}

/// The account's character list, as the bridge's `characters` event: the slots
/// (empty ones have an empty name), the starting cities a new character may
/// pick (`city_index` must be one of these `index` values — shards order them
/// differently), and, after a refused delete, the server's reason.
pub fn character_prompt_to_json(p: &anima_core::net::login::CharacterPrompt) -> Value {
    json!({
        "slots": p.list.slots.iter().map(|s| json!({ "index": s.index, "name": s.name })).collect::<Vec<_>>(),
        "slot_count": p.list.slot_count,
        "cities": p.list.cities.iter().map(|c| json!({ "index": c.index, "name": c.name, "building": c.building })).collect::<Vec<_>>(),
        "flags": p.list.flags,
        "delete_rejected": p.delete_rejected.map(|d| json!({ "reason": d.reason, "text": d.text })),
    })
}

/// A new character from JSON; every field is optional and falls back to the
/// default human ServUO accepts. `skills` is up to four `[id, value]` pairs;
/// stats must sum to what the shard requires (90 for modern ServUO), which
/// [`anima_core::net::login::CharacterAppearance::validate`] checks.
pub fn appearance_from_json(
    v: &Value,
) -> Result<anima_core::net::login::CharacterAppearance, String> {
    let mut a = anima_core::net::login::CharacterAppearance::default();
    let num = |k: &str| v.get(k).and_then(Value::as_u64);
    if let Some(n) = v.get("name").and_then(Value::as_str) {
        a.name = n.to_string();
    }
    if let Some(f) = v.get("female").and_then(Value::as_bool) {
        a.female = f;
    }
    macro_rules! set {
        ($field:ident, $t:ty) => {
            if let Some(n) = num(stringify!($field)) {
                a.$field = n as $t;
            }
        };
    }
    set!(skin_hue, u16);
    set!(hair_style, u16);
    set!(hair_hue, u16);
    set!(facial_hair_style, u16);
    set!(facial_hair_hue, u16);
    set!(shirt_hue, u16);
    set!(pants_hue, u16);
    set!(strength, u8);
    set!(dexterity, u8);
    set!(intelligence, u8);
    set!(city_index, u16);
    set!(profession, u8);
    if let Some(list) = v.get("skills").and_then(Value::as_array) {
        let mut skills = [(0u8, 0u8); 4];
        for (slot, pair) in skills.iter_mut().zip(list.iter().take(4)) {
            let id = pair
                .get(0)
                .and_then(Value::as_u64)
                .ok_or("skills are [id, value] pairs")?;
            let val = pair
                .get(1)
                .and_then(Value::as_u64)
                .ok_or("skills are [id, value] pairs")?;
            *slot = (id as u8, val as u8);
        }
        a.skills = skills;
    }
    a.validate().map_err(str::to_string)?;
    Ok(a)
}

/// The brain's answer to a `characters` event: `{"play": slot}`,
/// `{"create": {appearance}}` or `{"delete": slot}` (a delete re-prompts with
/// the refreshed list, or with `delete_rejected` set when the server refused).
pub fn character_choice_from_json(
    v: &Value,
) -> Result<anima_core::net::login::CharacterChoice, String> {
    use anima_core::net::login::CharacterChoice;
    if let Some(slot) = v.get("play").and_then(Value::as_u64) {
        return Ok(CharacterChoice::Play(slot as u8));
    }
    if let Some(slot) = v.get("delete").and_then(Value::as_u64) {
        return Ok(CharacterChoice::Delete(slot as u8));
    }
    if let Some(app) = v.get("create") {
        return Ok(CharacterChoice::Create(appearance_from_json(app)?));
    }
    Err("expected one of play / create / delete".to_string())
}

/// Serialize an [`Observation`] to the brain-facing JSON shape — see this
/// module's top doc comment for the full key list + versioning note.
pub fn observation_to_json(obs: &Observation) -> Value {
    let corpse_of: Vec<Value> = obs
        .corpse_of
        .iter()
        .map(|(corpse, killed)| json!({ "corpse": corpse, "killed": killed }))
        .collect();
    let corpse_equip: Vec<Value> = obs
        .corpse_equip
        .iter()
        .map(|(corpse, entries)| {
            let entries: Vec<Value> = entries
                .iter()
                .map(|(layer, serial)| json!({ "layer": layer, "serial": serial }))
                .collect();
            json!({ "corpse": corpse, "entries": entries })
        })
        .collect();
    let opl: Vec<Value> = obs
        .opl
        .iter()
        .map(|(serial, lines)| {
            let text = obs
                .opl_text
                .iter()
                .find(|(s, _)| s == serial)
                .map(|(_, t)| t.clone())
                .unwrap_or_default();
            json!({ "serial": serial, "lines": lines.iter().map(opl_line_json).collect::<Vec<_>>(),
                    "text": text })
        })
        .collect();
    let recent_damage: Vec<Value> = obs
        .recent_damage
        .iter()
        .map(|&(seq, serial, amount)| json!({ "seq": seq, "serial": serial, "amount": amount }))
        .collect();
    let bulletin_board = obs.bulletin_board.as_ref().map_or(Value::Null, |b| {
        let summaries: Vec<Value> = b
            .summaries
            .iter()
            .map(|m| {
                json!({ "serial": m.serial, "parent": m.parent, "poster": m.poster,
                        "subject": m.subject, "datetime": m.datetime })
            })
            .collect();
        json!({ "serial": b.serial, "name": b.name, "summaries": summaries })
    });
    let bulletin_message = obs.bulletin_message.as_ref().map_or(Value::Null, |m| {
        json!({ "board": m.board, "serial": m.serial, "poster": m.poster,
                "subject": m.subject, "datetime": m.datetime, "body": m.body })
    });
    let chat_channels: Vec<Value> = obs
        .chat
        .channels
        .iter()
        .map(|c| json!({ "name": c.name, "hasPassword": c.has_password }))
        .collect();
    let chat = json!({
        "enabled": obs.chat.enabled as u8,
        "channel": obs.chat.current_channel,
        "channels": chat_channels,
    });
    let chat_messages: Vec<Value> = obs
        .chat_messages
        .iter()
        .map(|m| json!({ "seq": m.seq, "sender": m.sender, "text": m.text }))
        .collect();
    json!({
        "player": player_json(&obs.player),
        "mobiles": obs.mobiles.iter().map(mobile_json).collect::<Vec<_>>(),
        "items": obs.items.iter().map(item_json).collect::<Vec<_>>(),
        "new_journal": obs.new_journal.iter().map(journal_json).collect::<Vec<_>>(),
        "pending_target": obs.pending_target.as_ref().map(target_json),
        "skills": obs.skills.iter().map(skill_json).collect::<Vec<_>>(),
        "gumps": obs.gumps.iter().map(gump_json).collect::<Vec<_>>(),
        "prompt": obs.prompt.as_ref().map(prompt_json),
        "trades": obs.trades.iter().map(trade_json).collect::<Vec<_>>(),
        "buffs": obs.buffs.iter().map(buff_json).collect::<Vec<_>>(),
        "shop_buy": obs.shop_buy.as_ref().map(shop_buy_json),
        "shop_sell": obs.shop_sell.as_ref().map(shop_sell_json),
        "popup": obs.popup.as_ref().map(popup_json),
        "legacy_menus": obs.legacy_menus.iter().map(legacy_menu_json).collect::<Vec<_>>(),
        "hue_pickers": obs.hue_pickers.iter().map(hue_picker_json).collect::<Vec<_>>(),
        "race_change": obs.race_change.as_ref().map(race_change_json),
        "open_urls": obs.open_urls.iter().map(open_url_json).collect::<Vec<_>>(),
        "tips": obs.tips.iter().map(tip_json).collect::<Vec<_>>(),
        "text_entry_dialogs": obs.text_entry_dialogs.iter().map(text_entry_dialog_json).collect::<Vec<_>>(),
        "character_profiles": obs.character_profiles.iter().map(character_profile_json).collect::<Vec<_>>(),
        "logout_ack": obs.logout_ack.as_ref().map(logout_ack_json),
        "book": obs.book.as_ref().map(book_json),
        "party": party_json(&obs.party),
        "quest_arrow": obs.quest_arrow.map(|(x, y)| json!({ "x": x, "y": y })),
        "waypoints": obs.waypoints.iter().map(waypoint_json).collect::<Vec<_>>(),
        "weather": weather_json(&obs.weather),
        "season": obs.season,
        "light": obs.light,
        "war": obs.war,
        "last_attack": obs.last_attack,
        "combatant": obs.combatant,
        "corpse_of": corpse_of,
        "corpse_equip": corpse_equip,
        "map_index": obs.map_index,
        "bulletin_board": bulletin_board,
        "bulletin_message": bulletin_message,
        "chat": chat,
        "chat_messages": chat_messages,
        "aos": obs.aos,
        "armed_ability": obs.armed_ability,
        "active_spell_icons": obs.active_spell_icons,
        "opl": opl,
        "recent_damage": recent_damage,
        "spellbooks": obs.spellbooks.iter().map(spellbook_json).collect::<Vec<_>>(),
        "map_gumps": obs.map_gumps.iter().map(map_view_json).collect::<Vec<_>>(),
        "terrain": obs.terrain.as_ref().map(terrain_json),
        "party_positions": obs.party_positions.iter().map(tracked_json).collect::<Vec<_>>(),
        "guild_positions": obs.guild_positions.iter().map(tracked_json).collect::<Vec<_>>(),
        "recent_effects": obs.recent_effects.iter().map(effect_json).collect::<Vec<_>>(),
        "recent_anims": obs.recent_anims.iter().map(|&(seq, serial, action, frames, forward, delay)| {
            json!({ "seq": seq, "serial": serial, "action": action, "frames": frames,
                    "forward": forward, "delay": delay })
        }).collect::<Vec<_>>(),
        "recent_typed_anims": obs.recent_typed_anims.iter().map(|&(seq, serial, kind, action, mode)| {
            json!({ "seq": seq, "serial": serial, "kind": kind, "action": action, "mode": mode })
        }).collect::<Vec<_>>(),
        "recent_sounds": obs.recent_sounds.iter().map(|&(seq, sound, x, y)| {
            json!({ "seq": seq, "sound": sound, "x": x, "y": y })
        }).collect::<Vec<_>>(),
        "recent_lift_rejects": obs.recent_lift_rejects.iter().map(|&(seq, reason)| {
            json!({ "seq": seq, "reason": reason })
        }).collect::<Vec<_>>(),
        "recent_drag_completions": obs.recent_drag_completions.iter().map(|d| {
            json!({ "seq": d.seq, "packet": d.packet, "token": d.token })
        }).collect::<Vec<_>>(),
        "customizing_house": obs.customizing_house,
        "house_designs": obs.house_designs.iter().map(|(serial, design)| json!({
            "serial": serial, "revision": design.revision,
            "planes": design.planes.iter().map(|p| json!({
                "mode": p.mode, "plane_z": p.plane_z, "data": p.data,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "pending_multi_placement": obs.pending_multi_placement.map(|m| {
            json!({ "multi_id": m.multi_id, "x_off": m.x_off, "y_off": m.y_off,
                    "z_off": m.z_off, "hue": m.hue })
        }),
    })
}

fn tracked_json(t: &TrackedMember) -> Value {
    json!({ "serial": t.serial, "x": t.x, "y": t.y, "map": t.map, "hits_pct": t.hits_pct })
}

fn effect_json(e: &Effect) -> Value {
    json!({
        "seq": e.seq, "kind": e.kind, "src": e.src_serial, "tgt": e.tgt_serial,
        "graphic": e.graphic, "from": { "x": e.sx, "y": e.sy, "z": e.sz },
        "to": { "x": e.tx, "y": e.ty, "z": e.tz }, "speed": e.speed,
        "duration": e.duration, "hue": e.hue, "explodes": e.explodes,
    })
}

/// A [`TerrainView`] as `{origin, radius, side, walk, z, doors}`.
///
/// The per-tile data goes out as **parallel flat arrays**, not an array of
/// objects: this is by far the largest field in an observation — a radius-12
/// window is 625 tiles — and it is re-sent on every poll. `walk` is a string of
/// `'.'`/`'#'` (one char per tile, row-major) and `z` a flat integer array, so
/// the common case costs roughly one byte per tile instead of a ~30-byte JSON
/// object. `doors` is sparse (`[index, serial]` pairs), since almost every tile
/// has none.
fn terrain_json(view: &TerrainView) -> Value {
    let mut walk = String::with_capacity(view.tiles.len());
    let mut z = Vec::with_capacity(view.tiles.len());
    let mut doors = Vec::new();
    for (i, tile) in view.tiles.iter().enumerate() {
        walk.push(if tile.walkable { '.' } else { '#' });
        z.push(tile.z);
        if let Some(serial) = tile.door {
            doors.push(json!([i, serial]));
        }
    }
    json!({
        "origin": [view.origin.0, view.origin.1],
        "radius": view.radius,
        "side": view.side(),
        "walk": walk,
        "z": z,
        "doors": doors,
    })
}

/// Parse a vendor transaction's `items` array into `(serial, amount)` pairs.
/// Accepts either `[{"serial": .., "amount": ..}, ..]` or `[[serial, amount], ..]`.
fn shop_items_from_json(v: &Value) -> Vec<(u32, u16)> {
    let Some(arr) = v.get("items").and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|e| {
            if let Some(o) = e.as_object() {
                let serial = o.get("serial").and_then(Value::as_u64)? as u32;
                let amount = o.get("amount").and_then(Value::as_u64).unwrap_or(1) as u16;
                Some((serial, amount))
            } else if let Some(pair) = e.as_array() {
                let serial = pair.first().and_then(Value::as_u64)? as u32;
                let amount = pair.get(1).and_then(Value::as_u64).unwrap_or(1) as u16;
                Some((serial, amount))
            } else {
                None
            }
        })
        .collect()
}

/// Parse a gump response's `entries` array into `(entryId, text)` pairs. Accepts
/// either `[{"id": .., "text": ".."}, ..]` or `[[id, "text"], ..]`.
fn gump_entries_from_json(v: &Value) -> Vec<(u16, String)> {
    let Some(arr) = v.get("entries").and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|e| {
            if let Some(o) = e.as_object() {
                let id = o.get("id").and_then(Value::as_u64)? as u16;
                let text = o
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                Some((id, text))
            } else if let Some(pair) = e.as_array() {
                let id = pair.first().and_then(Value::as_u64)? as u16;
                let text = pair
                    .get(1)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                Some((id, text))
            } else {
                None
            }
        })
        .collect()
}

/// Parse an [`Action`] from its JSON form (externally tagged by `"type"`).
/// Every [`Action`] variant round-trips through this (see the table-driven
/// test below) — keep this match exhaustive as the enum grows.
pub fn action_from_json(v: &Value) -> Result<Action, String> {
    let t = v
        .get("type")
        .and_then(Value::as_str)
        .ok_or("action missing 'type'")?;
    let u32f = |k: &str| v.get(k).and_then(Value::as_u64).map(|n| n as u32);
    let req_u32 = |k: &str| u32f(k).ok_or_else(|| format!("action {t} missing u32 '{k}'"));
    let req_u64 = |k: &str| {
        v.get(k)
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("action {t} missing u64 '{k}'"))
    };
    // A missing/mistyped (wrong key case, float) coordinate must error rather
    // than silently default to 0 — that would walk the player to the map
    // origin on a malformed request instead of surfacing the bad input.
    let req_u16 = |k: &str| {
        v.get(k)
            .and_then(Value::as_u64)
            .map(|n| n as u16)
            .ok_or_else(|| format!("action {t} missing u16 '{k}'"))
    };
    let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match t {
        "Walk" => Ok(Action::Walk {
            dir: v.get("dir").and_then(Value::as_u64).unwrap_or(0) as u8,
            run: v.get("run").and_then(Value::as_bool).unwrap_or(false),
        }),
        "WalkTo" => Ok(Action::WalkTo {
            x: req_u16("x")?,
            y: req_u16("y")?,
        }),
        // `mode` is optional and defaults to plain speech, so every brain
        // written against the pre-mode contract keeps working unchanged. An
        // unrecognized name is an error rather than a silent downgrade —
        // saying a guild line out loud is exactly the mistake worth catching.
        "Say" => Ok(Action::Say {
            text: text("text"),
            mode: match v.get("mode").and_then(Value::as_str) {
                None => SpeechMode::default(),
                Some(name) => SpeechMode::from_name(name)
                    .ok_or_else(|| format!("action Say has unknown mode '{name}'"))?,
            },
        }),
        "PartySay" => Ok(Action::PartySay { text: text("text") }),
        "Attack" => Ok(Action::Attack {
            serial: req_u32("serial")?,
        }),
        "AutoAttack" => Ok(Action::AutoAttack),
        "AttackLast" => Ok(Action::AttackLast),
        "Use" => Ok(Action::Use {
            serial: req_u32("serial")?,
        }),
        "Click" => Ok(Action::Click {
            serial: req_u32("serial")?,
        }),
        "PickUp" => Ok(Action::PickUp {
            serial: req_u32("serial")?,
            amount: v.get("amount").and_then(Value::as_u64).unwrap_or(1) as u16,
        }),
        "Drop" => Ok(Action::Drop {
            serial: req_u32("serial")?,
            x: v.get("x").and_then(Value::as_u64).unwrap_or(0) as u16,
            y: v.get("y").and_then(Value::as_u64).unwrap_or(0) as u16,
            z: v.get("z").and_then(Value::as_i64).unwrap_or(0) as i16,
            container: u32f("container").unwrap_or(0xFFFF_FFFF),
        }),
        "Equip" => Ok(Action::Equip {
            serial: req_u32("serial")?,
            layer: v.get("layer").and_then(Value::as_u64).unwrap_or(0) as u8,
        }),
        "WarMode" => Ok(Action::WarMode {
            on: v.get("on").and_then(Value::as_bool).unwrap_or(false),
        }),
        "CastSpell" => Ok(Action::CastSpell {
            spell: v.get("spell").and_then(Value::as_u64).unwrap_or(0) as u16,
        }),
        "TargetObject" => Ok(Action::TargetObject {
            serial: req_u32("serial")?,
        }),
        "TargetGround" => Ok(Action::TargetGround {
            x: v.get("x").and_then(Value::as_u64).unwrap_or(0) as u16,
            y: v.get("y").and_then(Value::as_u64).unwrap_or(0) as u16,
            z: v.get("z").and_then(Value::as_i64).unwrap_or(0) as i16,
            graphic: v.get("graphic").and_then(Value::as_u64).unwrap_or(0) as u16,
        }),
        "TargetCancel" => Ok(Action::TargetCancel),
        "BuyItems" => Ok(Action::BuyItems {
            vendor: req_u32("vendor")?,
            items: shop_items_from_json(v),
        }),
        "SellItems" => Ok(Action::SellItems {
            vendor: req_u32("vendor")?,
            items: shop_items_from_json(v),
        }),
        "BookRequest" => Ok(Action::BookRequest {
            serial: req_u32("serial")?,
            pages: v.get("pages").and_then(Value::as_u64).unwrap_or(0) as u16,
        }),
        "UseAbility" => Ok(Action::UseAbility {
            ability: v.get("ability").and_then(Value::as_u64).unwrap_or(0) as u8,
        }),
        "DisarmRequest" => Ok(Action::DisarmRequest),
        "StunRequest" => Ok(Action::StunRequest),
        "ToggleFlying" => Ok(Action::ToggleFlying),
        "BandageTarget" => Ok(Action::BandageTarget {
            bandage: req_u32("bandage")?,
            target: req_u32("target")?,
        }),
        "TargetedSpell" => Ok(Action::TargetedSpell {
            spell: req_u32("spell")? as u16,
            target: req_u32("target")?,
        }),
        "TargetedSkill" => Ok(Action::TargetedSkill {
            skill: req_u32("skill")? as u16,
            target: req_u32("target")?,
        }),
        "TargetByResource" => Ok(Action::TargetByResource {
            tool: req_u32("tool")?,
            resource: req_u32("resource")? as u16,
        }),
        "StatLock" => Ok(Action::StatLock {
            stat: v.get("stat").and_then(Value::as_u64).unwrap_or(0) as u8,
            lock: v.get("lock").and_then(Value::as_u64).unwrap_or(0) as u8,
        }),
        "SkillLock" => Ok(Action::SkillLock {
            skill: v.get("skill").and_then(Value::as_u64).unwrap_or(0) as u16,
            lock: v.get("lock").and_then(Value::as_u64).unwrap_or(0) as u8,
        }),
        "UseSkill" => Ok(Action::UseSkill {
            skill: v.get("skill").and_then(Value::as_u64).unwrap_or(0) as u16,
        }),
        "OpenDoor" => Ok(Action::OpenDoor),
        "EquipLastWeapon" => Ok(Action::EquipLastWeapon),
        "InvokeVirtue" => Ok(Action::InvokeVirtue {
            id: v.get("id").and_then(Value::as_u64).unwrap_or(0) as u8,
        }),
        "EmoteAction" => Ok(Action::EmoteAction {
            action: text("action"),
        }),
        "CastSpellFromBook" => Ok(Action::CastSpellFromBook {
            spell: v.get("spell").and_then(Value::as_u64).unwrap_or(0) as u16,
            book: req_u32("book")?,
        }),
        "AllNames" => Ok(Action::AllNames),
        "ChangeRace" => Ok(Action::ChangeRace {
            skin_hue: req_u16("skin_hue")?,
            hair_style: req_u16("hair_style")?,
            hair_hue: req_u16("hair_hue")?,
            beard_style: req_u16("beard_style")?,
            beard_hue: req_u16("beard_hue")?,
        }),
        "ChangeRaceCancel" => Ok(Action::ChangeRaceCancel),
        "OpenUOStore" => Ok(Action::OpenUOStore),
        "OplRequest" => Ok(Action::OplRequest {
            serial: req_u32("serial")?,
        }),
        "BulletinRequestMessage" => Ok(Action::BulletinRequestMessage {
            board: req_u32("board")?,
            message: req_u32("message")?,
        }),
        "BulletinRequestSummary" => Ok(Action::BulletinRequestSummary {
            board: req_u32("board")?,
            message: req_u32("message")?,
        }),
        "BulletinPost" => Ok(Action::BulletinPost {
            board: req_u32("board")?,
            reply_to: v.get("reply_to").and_then(Value::as_u64).unwrap_or(0) as u32,
            subject: text("subject"),
            lines: v
                .get("lines")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|l| l.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
        }),
        "BulletinRemove" => Ok(Action::BulletinRemove {
            board: req_u32("board")?,
            message: req_u32("message")?,
        }),
        "BoatMove" => Ok(Action::BoatMove {
            dir: req_u32("dir")? as u8,
            run: v.get("run").and_then(Value::as_bool).unwrap_or_default(),
        }),
        "BoatStop" => Ok(Action::BoatStop),
        "BookHeaderChange" => Ok(Action::BookHeaderChange {
            serial: req_u32("serial")?,
            title: text("title"),
            author: text("author"),
        }),
        "BookPageWrite" => Ok(Action::BookPageWrite {
            serial: req_u32("serial")?,
            page: req_u32("page")? as u16,
            lines: v
                .get("lines")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|l| l.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
        }),
        "MapToggleEditable" => Ok(Action::MapToggleEditable {
            serial: req_u32("serial")?,
        }),
        "MapAddPin" => Ok(Action::MapAddPin {
            serial: req_u32("serial")?,
            x: req_u32("x")? as u16,
            y: req_u32("y")? as u16,
        }),
        "MapInsertPin" => Ok(Action::MapInsertPin {
            serial: req_u32("serial")?,
            index: req_u32("index")? as u8,
            x: req_u32("x")? as u16,
            y: req_u32("y")? as u16,
        }),
        "MapChangePin" => Ok(Action::MapChangePin {
            serial: req_u32("serial")?,
            index: req_u32("index")? as u8,
            x: req_u32("x")? as u16,
            y: req_u32("y")? as u16,
        }),
        "MapRemovePin" => Ok(Action::MapRemovePin {
            serial: req_u32("serial")?,
            index: req_u32("index")? as u8,
        }),
        "MapClearPins" => Ok(Action::MapClearPins {
            serial: req_u32("serial")?,
        }),
        "ChatOpen" => Ok(Action::ChatOpen),
        "ChatJoin" => Ok(Action::ChatJoin {
            channel: text("channel"),
            password: text("password"),
        }),
        "ChatCreate" => Ok(Action::ChatCreate {
            channel: text("channel"),
            password: text("password"),
        }),
        "ChatLeave" => Ok(Action::ChatLeave),
        "ChatSay" => Ok(Action::ChatSay { text: text("text") }),
        "Rename" => Ok(Action::Rename {
            serial: req_u32("serial")?,
            name: text("name"),
        }),
        "QuestArrowClick" => Ok(Action::QuestArrowClick {
            right_click: v
                .get("right_click")
                .and_then(Value::as_bool)
                .unwrap_or_default(),
        }),
        "HelpRequest" => Ok(Action::HelpRequest),
        "GuildMenu" => Ok(Action::GuildMenu),
        "QuestMenu" => Ok(Action::QuestMenu),
        "PartyInvite" => Ok(Action::PartyInvite),
        "PartyLeave" => Ok(Action::PartyLeave),
        "PartyKick" => Ok(Action::PartyKick {
            member: req_u32("member")?,
        }),
        "PartyPrivateMessage" => Ok(Action::PartyPrivateMessage {
            member: req_u32("member")?,
            text: text("text"),
        }),
        "PartySetCanLoot" => Ok(Action::PartySetCanLoot {
            can_loot: v
                .get("can_loot")
                .and_then(Value::as_bool)
                .unwrap_or_default(),
        }),
        "StatusRequest" => Ok(Action::StatusRequest {
            serial: req_u32("serial")?,
        }),
        "SkillsRequest" => Ok(Action::SkillsRequest),
        "NameRequest" => Ok(Action::NameRequest {
            serial: req_u32("serial")?,
        }),
        "ViewRange" => Ok(Action::ViewRange {
            range: v.get("range").and_then(Value::as_u64).unwrap_or(18).min(24) as u8,
        }),
        "ObjectHelp" => Ok(Action::ObjectHelp {
            serial: req_u32("serial")?,
        }),
        "Language" => Ok(Action::Language { code: text("code") }),
        "Animate" => Ok(Action::Animate {
            action: v.get("action").and_then(Value::as_u64).unwrap_or(0) as u32,
        }),
        "PublicHouseContent" => Ok(Action::PublicHouseContent {
            show: v.get("show").and_then(Value::as_bool).unwrap_or(false),
        }),
        "OpenSpellbook" => Ok(Action::OpenSpellbook {
            book_type: v.get("book_type").and_then(Value::as_u64).unwrap_or(1) as u16,
        }),
        "PartyAccept" => Ok(Action::PartyAccept {
            leader: req_u32("leader")?,
        }),
        "PartyDecline" => Ok(Action::PartyDecline {
            leader: req_u32("leader")?,
        }),
        "PopupRequest" => Ok(Action::PopupRequest {
            serial: req_u32("serial")?,
        }),
        "PopupSelect" => Ok(Action::PopupSelect {
            serial: req_u32("serial")?,
            index: v.get("index").and_then(Value::as_u64).unwrap_or(0) as u16,
        }),
        "LegacyMenuSelect" => Ok(Action::LegacyMenuSelect {
            serial: req_u32("serial")?,
            index: req_u16("index")?,
        }),
        "HuePickerSelect" => Ok(Action::HuePickerSelect {
            serial: req_u32("serial")?,
            hue: req_u16("hue")?,
        }),
        "GumpResponse" => Ok(Action::GumpResponse {
            serial: req_u32("serial")?,
            gump_id: req_u32("gump_id")?,
            button: u32f("button").unwrap_or(0),
            switches: v
                .get("switches")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_u64().map(|n| n as u32))
                        .collect()
                })
                .unwrap_or_default(),
            entries: gump_entries_from_json(v),
        }),
        "PromptResponse" => Ok(Action::PromptResponse { text: text("text") }),
        "PromptCancel" => Ok(Action::PromptCancel),
        "TipNavigate" => Ok(Action::TipNavigate {
            seq: req_u64("seq")?,
            next: v.get("next").and_then(Value::as_bool).unwrap_or(false),
        }),
        "TipClose" => Ok(Action::TipClose {
            seq: req_u64("seq")?,
        }),
        "TextEntryResponse" => Ok(Action::TextEntryResponse {
            seq: req_u64("seq")?,
            text: text("text"),
            accepted: v.get("accepted").and_then(Value::as_bool).unwrap_or(true),
        }),
        "TextEntryClose" => Ok(Action::TextEntryClose {
            seq: req_u64("seq")?,
        }),
        "ProfileRequest" => Ok(Action::ProfileRequest {
            serial: req_u32("serial")?,
        }),
        "ProfileUpdate" => Ok(Action::ProfileUpdate {
            seq: req_u64("seq")?,
            text: text("text"),
        }),
        "ProfileClose" => Ok(Action::ProfileClose {
            seq: req_u64("seq")?,
        }),
        "Logout" => Ok(Action::Logout),
        "TradeAccept" => Ok(Action::TradeAccept {
            container: req_u32("container")?,
            accept: v.get("accept").and_then(Value::as_bool).unwrap_or(true),
        }),
        "TradeCancel" => Ok(Action::TradeCancel {
            container: req_u32("container")?,
        }),
        "TradeGold" => Ok(Action::TradeGold {
            container: req_u32("container")?,
            gold: u32f("gold").unwrap_or(0),
            platinum: u32f("platinum").unwrap_or(0),
        }),
        // A custom-house designer edit (0xD7). `cmd` names the
        // [`HouseDesignAction`] variant; `graphic`/`x`/`y`/`z`/`floor` sit
        // alongside it flat, like `TargetGround`'s coordinate fields, rather
        // than nested in their own sub-object.
        "HouseDesign" => {
            let cmd = v
                .get("cmd")
                .and_then(Value::as_str)
                .ok_or("HouseDesign missing 'cmd'")?;
            let graphic = || v.get("graphic").and_then(Value::as_u64).unwrap_or(0) as u16;
            let coord = |k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0) as i32;
            let action = match cmd {
                "AddItem" => HouseDesignAction::AddItem {
                    graphic: graphic(),
                    x: coord("x"),
                    y: coord("y"),
                },
                "DeleteItem" => HouseDesignAction::DeleteItem {
                    graphic: graphic(),
                    x: coord("x"),
                    y: coord("y"),
                    z: coord("z"),
                },
                "AddStair" => HouseDesignAction::AddStair {
                    graphic: graphic(),
                    x: coord("x"),
                    y: coord("y"),
                },
                "AddRoof" => HouseDesignAction::AddRoof {
                    graphic: graphic(),
                    x: coord("x"),
                    y: coord("y"),
                    z: coord("z"),
                },
                "DeleteRoof" => HouseDesignAction::DeleteRoof {
                    graphic: graphic(),
                    x: coord("x"),
                    y: coord("y"),
                    z: coord("z"),
                },
                "GoToFloor" => HouseDesignAction::GoToFloor(
                    v.get("floor").and_then(Value::as_u64).unwrap_or(0) as u8,
                ),
                "Commit" => HouseDesignAction::Commit,
                "Close" => HouseDesignAction::Close,
                "Clear" => HouseDesignAction::Clear,
                "Revert" => HouseDesignAction::Revert,
                "Backup" => HouseDesignAction::Backup,
                "Restore" => HouseDesignAction::Restore,
                "Sync" => HouseDesignAction::Sync,
                other => return Err(format!("unknown house design cmd: {other}")),
            };
            Ok(Action::HouseDesign(action))
        }
        other => Err(format!("unknown action type: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anima_core::agent::TerrainTile;
    use anima_core::world::{PromptKind, TipKind};

    /// Table-driven: every [`Action`] variant round-trips through
    /// `{"type": ..} -> action_from_json -> Action`. Add a row here whenever
    /// the enum grows a variant.
    #[test]
    fn action_from_json_covers_every_variant() {
        let cases: Vec<(Value, Action)> = vec![
            (
                json!({"type": "Walk", "dir": 3, "run": true}),
                Action::Walk { dir: 3, run: true },
            ),
            (
                json!({"type": "WalkTo", "x": 1200, "y": 800}),
                Action::WalkTo { x: 1200, y: 800 },
            ),
            (
                json!({"type": "Say", "text": "hi"}),
                Action::Say {
                    text: "hi".into(),
                    mode: SpeechMode::Say,
                },
            ),
            (
                json!({"type": "Say", "text": "psst", "mode": "whisper"}),
                Action::Say {
                    text: "psst".into(),
                    mode: SpeechMode::Whisper,
                },
            ),
            (
                json!({"type": "StatLock", "stat": 1, "lock": 2}),
                Action::StatLock { stat: 1, lock: 2 },
            ),
            (
                json!({"type": "PartySay", "text": "go"}),
                Action::PartySay { text: "go".into() },
            ),
            (
                json!({"type": "Attack", "serial": 42}),
                Action::Attack { serial: 42 },
            ),
            (json!({"type": "AutoAttack"}), Action::AutoAttack),
            (json!({"type": "AttackLast"}), Action::AttackLast),
            (
                json!({"type": "Use", "serial": 7}),
                Action::Use { serial: 7 },
            ),
            (
                json!({"type": "Click", "serial": 7}),
                Action::Click { serial: 7 },
            ),
            (
                json!({"type": "PickUp", "serial": 1073741825u64, "amount": 5}),
                Action::PickUp {
                    serial: 0x4000_0001,
                    amount: 5,
                },
            ),
            (
                json!({"type": "Drop", "serial": 9, "x": 10, "y": 20, "z": -3, "container": 99}),
                Action::Drop {
                    serial: 9,
                    x: 10,
                    y: 20,
                    z: -3,
                    container: 99,
                },
            ),
            (
                json!({"type": "Equip", "serial": 9, "layer": 2}),
                Action::Equip {
                    serial: 9,
                    layer: 2,
                },
            ),
            (
                json!({"type": "WarMode", "on": true}),
                Action::WarMode { on: true },
            ),
            (
                json!({"type": "CastSpell", "spell": 8}),
                Action::CastSpell { spell: 8 },
            ),
            (
                json!({"type": "TargetObject", "serial": 4242}),
                Action::TargetObject { serial: 4242 },
            ),
            (
                json!({"type": "TargetGround", "x": 1000, "y": 2000, "z": -5, "graphic": 420}),
                Action::TargetGround {
                    x: 1000,
                    y: 2000,
                    z: -5,
                    graphic: 420,
                },
            ),
            (json!({"type": "TargetCancel"}), Action::TargetCancel),
            (
                json!({"type": "BuyItems", "vendor": 5, "items": [[1, 2]]}),
                Action::BuyItems {
                    vendor: 5,
                    items: vec![(1, 2)],
                },
            ),
            (
                json!({"type": "SellItems", "vendor": 5, "items": [{"serial": 1, "amount": 3}]}),
                Action::SellItems {
                    vendor: 5,
                    items: vec![(1, 3)],
                },
            ),
            (
                json!({"type": "BookRequest", "serial": 3, "pages": 2}),
                Action::BookRequest {
                    serial: 3,
                    pages: 2,
                },
            ),
            (
                json!({"type": "UseAbility", "ability": 4}),
                Action::UseAbility { ability: 4 },
            ),
            (json!({"type": "DisarmRequest"}), Action::DisarmRequest),
            (json!({"type": "StunRequest"}), Action::StunRequest),
            (json!({"type": "ToggleFlying"}), Action::ToggleFlying),
            (
                json!({"type": "BandageTarget", "bandage": 12, "target": 34}),
                Action::BandageTarget {
                    bandage: 12,
                    target: 34,
                },
            ),
            (
                json!({"type": "TargetedSpell", "spell": 1, "target": 34}),
                Action::TargetedSpell {
                    spell: 1,
                    target: 34,
                },
            ),
            (
                json!({"type": "TargetedSkill", "skill": 1, "target": 34}),
                Action::TargetedSkill {
                    skill: 1,
                    target: 34,
                },
            ),
            (
                json!({"type": "TargetByResource", "tool": 12, "resource": 2}),
                Action::TargetByResource {
                    tool: 12,
                    resource: 2,
                },
            ),
            (
                json!({"type": "SkillLock", "skill": 10, "lock": 2}),
                Action::SkillLock { skill: 10, lock: 2 },
            ),
            (
                json!({"type": "UseSkill", "skill": 21}),
                Action::UseSkill { skill: 21 },
            ),
            (json!({"type": "OpenDoor"}), Action::OpenDoor),
            (json!({"type": "EquipLastWeapon"}), Action::EquipLastWeapon),
            (
                json!({"type": "InvokeVirtue", "id": 1}),
                Action::InvokeVirtue { id: 1 },
            ),
            (
                json!({"type": "EmoteAction", "action": "bow"}),
                Action::EmoteAction {
                    action: "bow".into(),
                },
            ),
            (
                json!({"type": "CastSpellFromBook", "spell": 8, "book": 12}),
                Action::CastSpellFromBook { spell: 8, book: 12 },
            ),
            (json!({"type": "AllNames"}), Action::AllNames),
            (
                json!({"type": "ChangeRace", "skin_hue": 1, "hair_style": 2, "hair_hue": 3,
                       "beard_style": 4, "beard_hue": 5}),
                Action::ChangeRace {
                    skin_hue: 1,
                    hair_style: 2,
                    hair_hue: 3,
                    beard_style: 4,
                    beard_hue: 5,
                },
            ),
            (
                json!({"type": "ChangeRaceCancel"}),
                Action::ChangeRaceCancel,
            ),
            (json!({"type": "OpenUOStore"}), Action::OpenUOStore),
            (
                json!({"type": "OplRequest", "serial": 8}),
                Action::OplRequest { serial: 8 },
            ),
            (
                json!({"type": "BulletinRequestMessage", "board": 4, "message": 5}),
                Action::BulletinRequestMessage {
                    board: 4,
                    message: 5,
                },
            ),
            (
                json!({"type": "BulletinRequestSummary", "board": 4, "message": 5}),
                Action::BulletinRequestSummary {
                    board: 4,
                    message: 5,
                },
            ),
            (
                json!({"type": "BulletinPost", "board": 4, "reply_to": 0,
                       "subject": "Hi", "lines": ["a"]}),
                Action::BulletinPost {
                    board: 4,
                    reply_to: 0,
                    subject: "Hi".into(),
                    lines: vec!["a".into()],
                },
            ),
            (
                json!({"type": "BulletinRemove", "board": 4, "message": 5}),
                Action::BulletinRemove {
                    board: 4,
                    message: 5,
                },
            ),
            (
                json!({"type": "BoatMove", "dir": 2, "run": true}),
                Action::BoatMove { dir: 2, run: true },
            ),
            (json!({"type": "BoatStop"}), Action::BoatStop),
            (
                json!({"type": "BookHeaderChange", "serial": 9, "title": "T", "author": "A"}),
                Action::BookHeaderChange {
                    serial: 9,
                    title: "T".into(),
                    author: "A".into(),
                },
            ),
            (
                json!({"type": "BookPageWrite", "serial": 9, "page": 2, "lines": ["a", "b"]}),
                Action::BookPageWrite {
                    serial: 9,
                    page: 2,
                    lines: vec!["a".into(), "b".into()],
                },
            ),
            (
                json!({"type": "MapToggleEditable", "serial": 9}),
                Action::MapToggleEditable { serial: 9 },
            ),
            (
                json!({"type": "MapAddPin", "serial": 9, "x": 12, "y": 34}),
                Action::MapAddPin {
                    serial: 9,
                    x: 12,
                    y: 34,
                },
            ),
            (
                json!({"type": "MapInsertPin", "serial": 9, "index": 2, "x": 1, "y": 2}),
                Action::MapInsertPin {
                    serial: 9,
                    index: 2,
                    x: 1,
                    y: 2,
                },
            ),
            (
                json!({"type": "MapChangePin", "serial": 9, "index": 2, "x": 3, "y": 4}),
                Action::MapChangePin {
                    serial: 9,
                    index: 2,
                    x: 3,
                    y: 4,
                },
            ),
            (
                json!({"type": "MapRemovePin", "serial": 9, "index": 3}),
                Action::MapRemovePin {
                    serial: 9,
                    index: 3,
                },
            ),
            (
                json!({"type": "MapClearPins", "serial": 9}),
                Action::MapClearPins { serial: 9 },
            ),
            (json!({"type": "ChatOpen"}), Action::ChatOpen),
            (
                json!({"type": "ChatJoin", "channel": "General", "password": ""}),
                Action::ChatJoin {
                    channel: "General".into(),
                    password: String::new(),
                },
            ),
            (
                json!({"type": "ChatCreate", "channel": "anima", "password": ""}),
                Action::ChatCreate {
                    channel: "anima".into(),
                    password: String::new(),
                },
            ),
            (json!({"type": "ChatLeave"}), Action::ChatLeave),
            (
                json!({"type": "ChatSay", "text": "hello"}),
                Action::ChatSay {
                    text: "hello".into(),
                },
            ),
            (
                json!({"type": "Rename", "serial": 7, "name": "Fluffy"}),
                Action::Rename {
                    serial: 7,
                    name: "Fluffy".into(),
                },
            ),
            (
                json!({"type": "QuestArrowClick", "right_click": true}),
                Action::QuestArrowClick { right_click: true },
            ),
            (json!({"type": "HelpRequest"}), Action::HelpRequest),
            (json!({"type": "GuildMenu"}), Action::GuildMenu),
            (json!({"type": "QuestMenu"}), Action::QuestMenu),
            (json!({"type": "PartyInvite"}), Action::PartyInvite),
            (json!({"type": "PartyLeave"}), Action::PartyLeave),
            (
                json!({"type": "PartyKick", "member": 42}),
                Action::PartyKick { member: 42 },
            ),
            (
                json!({"type": "PartyPrivateMessage", "member": 42, "text": "on me"}),
                Action::PartyPrivateMessage {
                    member: 42,
                    text: "on me".into(),
                },
            ),
            (
                json!({"type": "PartySetCanLoot", "can_loot": true}),
                Action::PartySetCanLoot { can_loot: true },
            ),
            (
                json!({"type": "StatusRequest", "serial": 42}),
                Action::StatusRequest { serial: 42 },
            ),
            (json!({"type": "SkillsRequest"}), Action::SkillsRequest),
            (
                json!({"type": "NameRequest", "serial": 42}),
                Action::NameRequest { serial: 42 },
            ),
            (
                json!({"type": "ViewRange", "range": 24}),
                Action::ViewRange { range: 24 },
            ),
            (
                json!({"type": "ObjectHelp", "serial": 42}),
                Action::ObjectHelp { serial: 42 },
            ),
            (
                json!({"type": "Language", "code": "KOR"}),
                Action::Language { code: "KOR".into() },
            ),
            (
                json!({"type": "Animate", "action": 32}),
                Action::Animate { action: 32 },
            ),
            (
                json!({"type": "PublicHouseContent", "show": true}),
                Action::PublicHouseContent { show: true },
            ),
            (
                json!({"type": "OpenSpellbook", "book_type": 1}),
                Action::OpenSpellbook { book_type: 1 },
            ),
            (
                json!({"type": "PartyAccept", "leader": 11}),
                Action::PartyAccept { leader: 11 },
            ),
            (
                json!({"type": "PartyDecline", "leader": 11}),
                Action::PartyDecline { leader: 11 },
            ),
            (
                json!({"type": "PopupRequest", "serial": 6}),
                Action::PopupRequest { serial: 6 },
            ),
            (
                json!({"type": "PopupSelect", "serial": 6, "index": 1}),
                Action::PopupSelect {
                    serial: 6,
                    index: 1,
                },
            ),
            (
                json!({"type": "LegacyMenuSelect", "serial": 9, "index": 2}),
                Action::LegacyMenuSelect {
                    serial: 9,
                    index: 2,
                },
            ),
            (
                json!({"type": "HuePickerSelect", "serial": 10, "hue": 902}),
                Action::HuePickerSelect {
                    serial: 10,
                    hue: 902,
                },
            ),
            (
                json!({"type": "GumpResponse", "serial": 1, "gump_id": 2, "button": 3,
                       "switches": [1, 2], "entries": [[4, "hi"]]}),
                Action::GumpResponse {
                    serial: 1,
                    gump_id: 2,
                    button: 3,
                    switches: vec![1, 2],
                    entries: vec![(4, "hi".into())],
                },
            ),
            (
                json!({"type": "PromptResponse", "text": "Fido"}),
                Action::PromptResponse {
                    text: "Fido".into(),
                },
            ),
            (json!({"type": "PromptCancel"}), Action::PromptCancel),
            (
                json!({"type": "TipNavigate", "seq": 9, "next": true}),
                Action::TipNavigate { seq: 9, next: true },
            ),
            (
                json!({"type": "TipClose", "seq": 10}),
                Action::TipClose { seq: 10 },
            ),
            (
                json!({"type": "TextEntryResponse", "seq": 11, "text": "123", "accepted": false}),
                Action::TextEntryResponse {
                    seq: 11,
                    text: "123".into(),
                    accepted: false,
                },
            ),
            (
                json!({"type": "TextEntryClose", "seq": 12}),
                Action::TextEntryClose { seq: 12 },
            ),
            (
                json!({"type": "ProfileRequest", "serial": 13}),
                Action::ProfileRequest { serial: 13 },
            ),
            (
                json!({"type": "ProfileUpdate", "seq": 14, "text": "Biography"}),
                Action::ProfileUpdate {
                    seq: 14,
                    text: "Biography".into(),
                },
            ),
            (
                json!({"type": "ProfileClose", "seq": 15}),
                Action::ProfileClose { seq: 15 },
            ),
            (json!({"type": "Logout"}), Action::Logout),
            (
                json!({"type": "TradeAccept", "container": 55, "accept": true}),
                Action::TradeAccept {
                    container: 55,
                    accept: true,
                },
            ),
            (
                json!({"type": "TradeCancel", "container": 55}),
                Action::TradeCancel { container: 55 },
            ),
            (
                json!({"type": "TradeGold", "container": 55, "gold": 100, "platinum": 1}),
                Action::TradeGold {
                    container: 55,
                    gold: 100,
                    platinum: 1,
                },
            ),
            (
                json!({"type": "HouseDesign", "cmd": "AddItem", "graphic": 1234, "x": 5, "y": -6}),
                Action::HouseDesign(HouseDesignAction::AddItem {
                    graphic: 1234,
                    x: 5,
                    y: -6,
                }),
            ),
            (
                json!({"type": "HouseDesign", "cmd": "DeleteItem", "graphic": 1234, "x": 5, "y": -6, "z": 2}),
                Action::HouseDesign(HouseDesignAction::DeleteItem {
                    graphic: 1234,
                    x: 5,
                    y: -6,
                    z: 2,
                }),
            ),
            (
                json!({"type": "HouseDesign", "cmd": "AddStair", "graphic": 5150, "x": 1, "y": 2}),
                Action::HouseDesign(HouseDesignAction::AddStair {
                    graphic: 5150,
                    x: 1,
                    y: 2,
                }),
            ),
            (
                json!({"type": "HouseDesign", "cmd": "AddRoof", "graphic": 6001, "x": 3, "y": 4, "z": 20}),
                Action::HouseDesign(HouseDesignAction::AddRoof {
                    graphic: 6001,
                    x: 3,
                    y: 4,
                    z: 20,
                }),
            ),
            (
                json!({"type": "HouseDesign", "cmd": "DeleteRoof", "graphic": 6001, "x": 3, "y": 4, "z": 20}),
                Action::HouseDesign(HouseDesignAction::DeleteRoof {
                    graphic: 6001,
                    x: 3,
                    y: 4,
                    z: 20,
                }),
            ),
            (
                json!({"type": "HouseDesign", "cmd": "GoToFloor", "floor": 3}),
                Action::HouseDesign(HouseDesignAction::GoToFloor(3)),
            ),
            (
                json!({"type": "HouseDesign", "cmd": "Commit"}),
                Action::HouseDesign(HouseDesignAction::Commit),
            ),
            (
                json!({"type": "HouseDesign", "cmd": "Close"}),
                Action::HouseDesign(HouseDesignAction::Close),
            ),
            (
                json!({"type": "HouseDesign", "cmd": "Clear"}),
                Action::HouseDesign(HouseDesignAction::Clear),
            ),
            (
                json!({"type": "HouseDesign", "cmd": "Revert"}),
                Action::HouseDesign(HouseDesignAction::Revert),
            ),
            (
                json!({"type": "HouseDesign", "cmd": "Backup"}),
                Action::HouseDesign(HouseDesignAction::Backup),
            ),
            (
                json!({"type": "HouseDesign", "cmd": "Restore"}),
                Action::HouseDesign(HouseDesignAction::Restore),
            ),
            (
                json!({"type": "HouseDesign", "cmd": "Sync"}),
                Action::HouseDesign(HouseDesignAction::Sync),
            ),
        ];
        // Every `Action` variant must have a case above: the enum is read from its
        // source, so a variant added without a JSON arm fails here instead of
        // silently being unreachable from the bridge (`OpenSpellbook` was, for
        // eleven schema versions, while this test still passed).
        let covered: std::collections::HashSet<String> = cases
            .iter()
            .map(|(_, a)| {
                format!("{a:?}")
                    .split(|c: char| !c.is_alphanumeric())
                    .next()
                    .unwrap()
                    .to_string()
            })
            .collect();
        let src = include_str!("../../anima-core/src/agent.rs");
        let body = &src[src.find("pub enum Action {").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let missing: Vec<&str> = body
            .lines()
            .filter_map(|l| l.strip_prefix("    "))
            .filter(|l| l.starts_with(|c: char| c.is_ascii_uppercase()))
            .map(|l| l.split(|c: char| !c.is_alphanumeric()).next().unwrap())
            .filter(|name| !covered.contains(*name))
            .collect();
        assert!(
            missing.is_empty(),
            "Action variants with no action_from_json case: {missing:?}"
        );
        for (json, expected) in cases {
            let got = action_from_json(&json).unwrap_or_else(|e| panic!("{json} -> err {e}"));
            assert_eq!(got, expected, "mismatch for {json}");
        }

        assert!(action_from_json(&json!({"type": "Nope"})).is_err());
        assert!(action_from_json(&json!({})).is_err());

        // A malformed WalkTo must error, not silently walk to the map origin.
        assert!(
            action_from_json(&json!({"type": "WalkTo", "y": 800})).is_err(),
            "WalkTo missing x must error"
        );
        assert!(
            action_from_json(&json!({"type": "WalkTo", "x": 12.5, "y": 800})).is_err(),
            "WalkTo with a non-integer x must error"
        );

        // An unrecognized or missing house-design `cmd` must error rather
        // than silently drop the edit.
        assert!(
            action_from_json(&json!({"type": "HouseDesign", "cmd": "Bogus"})).is_err(),
            "HouseDesign with an unknown cmd must error"
        );
        assert!(
            action_from_json(&json!({"type": "HouseDesign"})).is_err(),
            "HouseDesign missing cmd must error"
        );
    }

    #[test]
    fn observation_serializes_pending_target() {
        use anima_core::world::{TargetCursor, World};
        let mut w = World::default();
        w.pending_target = Some(TargetCursor {
            target_type: 1,
            cursor_id: 0xABCD,
            cursor_flag: 0,
        });
        let v = observation_to_json(&w.observe(&mut 0));
        assert_eq!(v["pending_target"]["cursor_id"], 0xABCD);
        assert_eq!(v["pending_target"]["target_type"], 1);
    }

    #[test]
    fn observation_serializes_player_survival_state_explicitly() {
        let obs = Observation {
            player: PlayerView {
                body: 0x192,
                poisoned: true,
                dead: true,
                ..PlayerView::default()
            },
            ..Observation::default()
        };
        let v = observation_to_json(&obs);
        assert_eq!(v["player"]["body"], 0x192);
        assert_eq!(v["player"]["poisoned"], true);
        assert_eq!(v["player"]["dead"], true);

        let default = observation_to_json(&Observation::default());
        assert_eq!(default["player"]["poisoned"], false);
        assert_eq!(default["player"]["dead"], false);
    }

    #[test]
    fn schema_v30_retains_waypoint_exact_shape() {
        let obs = Observation {
            waypoints: vec![WaypointView {
                serial: 0x1234_5678,
                pos: Position {
                    x: 2588,
                    y: 406,
                    z: -7,
                },
                map: 2,
                kind: 6,
                ignore_object: true,
                cliloc: 1_060_023,
                name: "Wandering Healer".into(),
                distance: 17,
            }],
            ..Observation::default()
        };

        assert_eq!(
            observation_to_json(&obs)["waypoints"],
            json!([{
                "serial": 0x1234_5678,
                "pos": {"x": 2588, "y": 406, "z": -7},
                "map": 2,
                "kind": 6,
                "ignore_object": true,
                "cliloc": 1_060_023,
                "name": "Wandering Healer",
                "distance": 17,
            }])
        );
    }

    #[test]
    fn mobiles_carry_their_visible_condition() {
        let obs = Observation {
            mobiles: vec![MobileView {
                serial: 0x55,
                name: "Rook".into(),
                pos: Position {
                    x: 2600,
                    y: 490,
                    z: 20,
                },
                body: 0x190,
                notoriety: 1,
                hits: 12,
                hits_max: 25,
                distance: 3,
                status: anima_core::agent::MobileStatus {
                    poisoned: true,
                    poison_level: 2,
                    paralyzed: true,
                    war_mode: true,
                    hidden: false,
                    yellow_health: false,
                    running: false,
                    direction: 6,
                    ..Default::default()
                },
            }],
            ..Observation::default()
        };
        let m = &observation_to_json(&obs)["mobiles"][0];
        assert_eq!(m["poisoned"], true);
        assert_eq!(m["poison_level"], 2);
        assert_eq!(m["paralyzed"], true);
        assert_eq!(m["war_mode"], true);
        assert_eq!(m["hidden"], false);
        assert_eq!(m["yellow_health"], false);
        assert_eq!(m["running"], false);
        assert_eq!(m["direction"], 6);
    }

    #[test]
    fn schema_33_carries_what_the_core_tracked_and_the_brain_could_not_see() {
        use anima_core::agent::ItemDetail;
        let obs = Observation {
            player: PlayerView {
                hidden: true,
                paralyzed: true,
                notoriety: 3,
                mounted: true,
                tithing_points: 700,
                ..PlayerView::default()
            },
            items: vec![ItemView {
                serial: 9,
                graphic: 0x1BF2,
                amount: 20,
                pos: Position { x: 50, y: 60, z: 0 },
                container: Some(0x40),
                layer: 0,
                distance: 2,
                is_multi: false,
                detail: ItemDetail {
                    hue: 0x0973,
                    name: "ingots".into(),
                    movable: Some(true),
                    hidden: Some(false),
                },
            }],
            opl: vec![(9, vec![(1_060_483, "10".into())])],
            opl_text: vec![(9, vec!["Spell Damage Increase 10%".into()])],
            recent_lift_rejects: vec![(4, 1)],
            recent_effects: vec![Effect {
                seq: 7,
                kind: 0,
                src_serial: 5,
                tgt_serial: 6,
                graphic: 0x379F,
                sx: 1,
                sy: 2,
                sz: 0,
                tx: 3,
                ty: 4,
                tz: 0,
                speed: 5,
                duration: 1,
                hue: 0,
                blend: 0,
                explodes: false,
            }],
            ..Observation::default()
        };
        let v = observation_to_json(&obs);
        let p = &v["player"];
        assert_eq!(
            (
                p["hidden"].clone(),
                p["paralyzed"].clone(),
                p["mounted"].clone()
            ),
            (json!(true), json!(true), json!(true))
        );
        assert_eq!(p["notoriety"], 3);
        assert_eq!(p["tithing_points"], 700);
        let it = &v["items"][0];
        assert_eq!(
            (it["hue"].clone(), it["name"].clone(), it["movable"].clone()),
            (json!(0x0973), json!("ingots"), json!(true))
        );
        assert_eq!(v["opl"][0]["text"][0], "Spell Damage Increase 10%");
        assert_eq!(
            v["recent_lift_rejects"][0],
            json!({ "seq": 4, "reason": 1 })
        );
        assert_eq!(
            (
                v["recent_effects"][0]["src"].clone(),
                v["recent_effects"][0]["tgt"].clone()
            ),
            (json!(5), json!(6))
        );
        assert!(v["pending_multi_placement"].is_null());
    }

    #[test]
    fn character_choices_round_trip_from_json() {
        use anima_core::net::login::CharacterChoice;
        assert_eq!(
            character_choice_from_json(&json!({"play": 2})).unwrap(),
            CharacterChoice::Play(2)
        );
        assert_eq!(
            character_choice_from_json(&json!({"delete": 0})).unwrap(),
            CharacterChoice::Delete(0)
        );
        let CharacterChoice::Create(a) = character_choice_from_json(&json!({"create": {
            "name": "Ilse", "female": true, "strength": 30, "dexterity": 10, "intelligence": 50,
            "skills": [[25, 50], [46, 50], [16, 0], [26, 0]], "city_index": 3
        }}))
        .unwrap() else {
            panic!("not a create")
        };
        assert_eq!(
            (
                a.name.as_str(),
                a.female,
                a.intelligence,
                a.skills[0],
                a.city_index
            ),
            ("Ilse", true, 50, (25, 50), 3)
        );
        assert!(
            character_choice_from_json(&json!({"create": {"strength": 90, "dexterity": 90}}))
                .is_err()
        );
        assert!(character_choice_from_json(&json!({})).is_err());
    }

    #[test]
    fn terrain_serializes_compactly_and_is_null_when_unsurveyed() {
        // The core alone never perceives ground, so the default must be null
        // rather than an empty grid a brain could mistake for "all walls".
        assert_eq!(
            observation_to_json(&Observation::default())["terrain"],
            json!(null)
        );

        let obs = Observation {
            terrain: Some(TerrainView {
                origin: (1000, 2000),
                radius: 1,
                // A 3×3: two walls, one dip, one raised tile, one door.
                tiles: [
                    (true, 0, None),
                    (false, 0, None),
                    (true, -5, None),
                    (true, 0, None),
                    (true, 0, Some(0x4001)),
                    (true, 0, None),
                    (false, 0, None),
                    (true, 12, None),
                    (true, 0, None),
                ]
                .into_iter()
                .map(|(walkable, z, door)| TerrainTile { walkable, z, door })
                .collect(),
            }),
            ..Observation::default()
        };
        assert_eq!(
            observation_to_json(&obs)["terrain"],
            json!({
                "origin": [1000, 2000],
                "radius": 1,
                "side": 3,
                // One char per tile beats ~30 bytes of JSON object per tile on
                // a field this size that is re-sent every poll.
                "walk": ".#....#..",
                "z": [0, 0, -5, 0, 0, 0, 0, 12, 0],
                "doors": [[4, 0x4001]],
            })
        );
    }

    #[test]
    fn schema_v9_serializes_legacy_menus_with_one_based_entries() {
        let obs = Observation {
            legacy_menus: vec![LegacyMenu {
                serial: 0x0102_0304,
                menu_id: 7,
                question: "Choose".into(),
                kind: LegacyMenuKind::Items,
                entries: vec![LegacyMenuEntry {
                    graphic: 0x0F5E,
                    hue: 0x0481,
                    text: "Sword".into(),
                }],
            }],
            ..Observation::default()
        };
        assert_eq!(
            observation_to_json(&obs)["legacy_menus"],
            json!([{
                "serial": 0x0102_0304u32,
                "menu_id": 7,
                "question": "Choose",
                "kind": "items",
                "entries": [{ "index": 1, "graphic": 0x0F5E, "hue": 0x0481, "text": "Sword" }],
            }])
        );
    }

    #[test]
    fn schema_v13_serializes_hue_pickers_exact_shape() {
        let obs = Observation {
            hue_pickers: vec![HuePicker {
                serial: 0x0102_0304,
                graphic: 0x0FAB,
            }],
            ..Observation::default()
        };
        assert_eq!(
            observation_to_json(&obs)["hue_pickers"],
            json!([{ "serial": 0x0102_0304u32, "graphic": 0x0FAB }])
        );
    }

    #[test]
    fn schema_v13_serializes_prompt_kind_exactly() {
        for (kind, expected) in [
            (PromptKind::Ascii, "ascii"),
            (PromptKind::Unicode, "unicode"),
        ] {
            let obs = Observation {
                prompt: Some(PromptState {
                    sender_serial: 0x0102_0304,
                    prompt_id: 0xDEAD_BEEF,
                    kind,
                }),
                ..Observation::default()
            };
            assert_eq!(
                observation_to_json(&obs)["prompt"],
                json!({
                    "sender_serial": 0x0102_0304u32,
                    "prompt_id": 0xDEAD_BEEFu32,
                    "kind": expected,
                })
            );
        }
    }

    #[test]
    fn schema_v13_serializes_validated_open_url_events_exactly() {
        let obs = Observation {
            open_urls: vec![
                OpenUrlRequest {
                    seq: 7,
                    url: "https://uo.com/news".into(),
                },
                OpenUrlRequest {
                    seq: 8,
                    url: "http://localhost:8080/help".into(),
                },
            ],
            ..Observation::default()
        };
        assert_eq!(
            observation_to_json(&obs)["open_urls"],
            json!([
                { "seq": 7, "url": "https://uo.com/news" },
                { "seq": 8, "url": "http://localhost:8080/help" },
            ])
        );
    }

    #[test]
    fn schema_v13_serializes_tip_and_notice_windows_exactly() {
        let obs = Observation {
            tips: vec![
                TipNotice {
                    seq: 3,
                    tip: 0x1234_5678,
                    kind: TipKind::Tip,
                    text: "First\nSecond €".into(),
                },
                TipNotice {
                    seq: 4,
                    tip: 9,
                    kind: TipKind::Notice,
                    text: "Maintenance".into(),
                },
            ],
            ..Observation::default()
        };
        assert_eq!(
            observation_to_json(&obs)["tips"],
            json!([
                { "seq": 3, "tip": 0x1234_5678u32, "kind": "tip", "text": "First\nSecond €" },
                { "seq": 4, "tip": 9, "kind": "notice", "text": "Maintenance" },
            ])
        );
    }

    #[test]
    fn schema_v14_serializes_text_entry_dialogs_exactly() {
        let obs = Observation {
            text_entry_dialogs: vec![TextEntryDialog {
                seq: 7,
                serial: 0x0102_0304,
                parent_id: 5,
                button_id: 6,
                text: "Account €".into(),
                can_close: true,
                variant: 2,
                max_length: 12,
                description: "Digits only".into(),
            }],
            ..Observation::default()
        };
        assert_eq!(
            observation_to_json(&obs)["text_entry_dialogs"],
            json!([{
                "seq": 7,
                "serial": 0x0102_0304u32,
                "parent_id": 5,
                "button_id": 6,
                "text": "Account €",
                "can_close": true,
                "variant": 2,
                "max_length": 12,
                "description": "Digits only",
            }])
        );
    }

    #[test]
    fn schema_v15_serializes_character_profiles_exactly() {
        let obs = Observation {
            character_profiles: vec![CharacterProfile {
                seq: 8,
                serial: 0x0102_0304,
                header: "Anima the Adventurer".into(),
                footer: "This account is 10 days old.".into(),
                body: "Hello 😀".into(),
                can_edit: true,
            }],
            ..Observation::default()
        };
        assert_eq!(
            observation_to_json(&obs)["character_profiles"],
            json!([{
                "seq": 8,
                "serial": 0x0102_0304u32,
                "header": "Anima the Adventurer",
                "footer": "This account is 10 days old.",
                "body": "Hello 😀",
                "can_edit": true,
            }])
        );
    }

    #[test]
    fn schema_v16_serializes_logout_ack_exactly() {
        let obs = Observation {
            logout_ack: Some(LogoutAck {
                seq: 4,
                allowed: false,
            }),
            ..Observation::default()
        };
        assert_eq!(
            observation_to_json(&obs)["logout_ack"],
            json!({ "seq": 4, "allowed": false })
        );
    }

    #[test]
    fn observation_json_has_expected_keys() {
        assert_eq!(SCHEMA_VERSION, 33);
        let obs = Observation::default();
        let v = observation_to_json(&obs);
        for k in [
            "player",
            "mobiles",
            "items",
            "new_journal",
            "pending_target",
            "skills",
            "gumps",
            "prompt",
            "trades",
            "buffs",
            "shop_buy",
            "shop_sell",
            "popup",
            "legacy_menus",
            "hue_pickers",
            "race_change",
            "open_urls",
            "tips",
            "text_entry_dialogs",
            "character_profiles",
            "logout_ack",
            "book",
            "party",
            "quest_arrow",
            "waypoints",
            "weather",
            "season",
            "light",
            "war",
            "last_attack",
            "combatant",
            "corpse_of",
            "corpse_equip",
            "map_index",
            "bulletin_board",
            "bulletin_message",
            "chat",
            "chat_messages",
            "aos",
            "armed_ability",
            "active_spell_icons",
            "opl",
            "recent_damage",
            "spellbooks",
            "map_gumps",
            "terrain",
            "party_positions",
            "guild_positions",
            "recent_effects",
            "recent_anims",
            "recent_typed_anims",
            "recent_sounds",
            "recent_lift_rejects",
            "recent_drag_completions",
            "pending_multi_placement",
        ] {
            assert!(v.get(k).is_some(), "missing key {k}");
        }
        assert!(v["player"].get("hits_max").is_some());
        assert!(v["player"].get("weight_max").is_some());
        assert!(v["player"].get("body").is_some());
        assert!(v["player"].get("poisoned").is_some());
        assert!(v["player"].get("dead").is_some());
        // Nothing open by default: the Option-backed fields serialize to null.
        assert!(v["shop_buy"].is_null());
        assert!(v["book"].is_null());
        assert!(v["popup"].is_null());
        assert!(v["prompt"].is_null());
        assert_eq!(v["legacy_menus"], json!([]));
        assert_eq!(v["hue_pickers"], json!([]));
        assert!(v["race_change"].is_null());
        assert_eq!(v["open_urls"], json!([]));
        assert_eq!(v["tips"], json!([]));
        assert_eq!(v["text_entry_dialogs"], json!([]));
        assert_eq!(v["character_profiles"], json!([]));
        assert!(v["logout_ack"].is_null());
    }

    #[test]
    fn schema_v31_race_change_json() {
        let obs = Observation {
            race_change: Some(RaceChangePrompt {
                female: true,
                race: 3,
            }),
            ..Observation::default()
        };
        assert_eq!(
            observation_to_json(&obs)["race_change"],
            json!({ "female": true, "race": 3 })
        );
    }

    /// Schema v5: `items[].is_multi` — a placed boat/house shows up in
    /// `items` (it's a `World::items` entry like any other) but its `graphic`
    /// is a multi id, not an ART id (see [`ItemView`]'s doc); a brain must be
    /// able to tell the two apart from the JSON alone.
    #[test]
    fn item_json_serializes_is_multi() {
        use anima_core::types::Position;

        let normal = ItemView {
            serial: 1,
            graphic: 0x0EED,
            amount: 1,
            pos: Position {
                x: 100,
                y: 100,
                z: 0,
            },
            container: None,
            layer: 0,
            distance: 3,
            is_multi: false,
            detail: Default::default(),
        };
        let multi = ItemView {
            serial: 2,
            graphic: 0x0002, // a real ART id too — the collision `is_multi` guards against
            amount: 1,
            pos: Position {
                x: 1492,
                y: 1760,
                z: 0,
            },
            container: None,
            layer: 0,
            distance: 5,
            is_multi: true,
            detail: Default::default(),
        };
        assert_eq!(item_json(&normal)["is_multi"], false);
        assert_eq!(item_json(&multi)["is_multi"], true);
        assert_eq!(
            item_json(&multi)["graphic"],
            2,
            "graphic is still emitted — just not an ART id here"
        );
    }

    #[test]
    fn observation_serializes_opl_and_recent_damage() {
        use anima_core::world::World;
        let mut w = World::default();
        w.set_opl(0xABCD, 1, vec![(1042971, "".into()), (1060451, "3".into())]);
        w.push_damage(0xABCD, 12);
        w.push_damage(0xABCD, 7);
        let v = observation_to_json(&w.observe(&mut 0));

        assert_eq!(v["opl"][0]["serial"], 0xABCD);
        assert_eq!(v["opl"][0]["lines"][0]["cliloc"], 1042971);
        assert_eq!(v["opl"][0]["lines"][1]["args"], "3");

        assert_eq!(v["recent_damage"].as_array().unwrap().len(), 2);
        assert_eq!(v["recent_damage"][0]["serial"], 0xABCD);
        assert_eq!(v["recent_damage"][0]["amount"], 12);
        assert_eq!(v["recent_damage"][1]["amount"], 7);
        // Monotonic seq lets a brain dedupe across polls.
        assert!(
            v["recent_damage"][1]["seq"].as_u64().unwrap()
                > v["recent_damage"][0]["seq"].as_u64().unwrap()
        );
    }

    #[test]
    fn observation_serializes_spellbooks_split_lo_hi() {
        use anima_core::world::World;
        let mut w = World::default();
        // Magery book (graphic 0x0EFA), offset 1 (BookOffset(0)+1), a mask with
        // bit 0 set (spell 1) and bit 40 set (well past JS's 32-bit range) — the
        // split lo/hi halves must each carry the right bits.
        let content: u64 = 1 | (1u64 << 40);
        w.set_spellbook_content(0x4000_0010, 0x0EFA, 1, content);
        let v = observation_to_json(&w.observe(&mut 0));

        assert_eq!(v["spellbooks"].as_array().unwrap().len(), 1);
        let sb = &v["spellbooks"][0];
        assert_eq!(sb["serial"], 0x4000_0010);
        assert_eq!(sb["graphic"], 0x0EFA);
        assert_eq!(sb["offset"], 1);
        assert_eq!(sb["lo"], 1u64);
        assert_eq!(sb["hi"], 1u64 << 8); // bit 40 overall == bit 8 of the high half
    }

    #[test]
    fn observation_json_spellbooks_empty_by_default() {
        let v = observation_to_json(&Observation::default());
        assert!(v["spellbooks"].as_array().unwrap().is_empty());
    }

    /// Schema v6: `map_gumps` — a treasure/decoration map window (0x90/0xF5 +
    /// 0x56), with pins carried straight through in pixel space.
    #[test]
    fn observation_serializes_map_gumps() {
        use anima_core::world::World;
        let mut w = World::default();
        w.set_map_view(0x4000_1234, 0x139D, 3, 520, 0, 2580, 2050, 400, 400);
        w.apply_map_command(0x4000_1234, 1, 0, 100, 120); // the chest pin
        w.apply_map_command(0x4000_1234, 7, 1, 0, 0); // editable = true
        let v = observation_to_json(&w.observe(&mut 0));

        assert_eq!(v["map_gumps"].as_array().unwrap().len(), 1);
        let mv = &v["map_gumps"][0];
        assert_eq!(mv["serial"], 0x4000_1234);
        assert_eq!(mv["open_seq"], 1);
        assert_eq!(mv["gump_art"], 0x139D);
        assert_eq!(mv["facet"], 3);
        assert_eq!(mv["bounds"]["min_x"], 520);
        assert_eq!(mv["bounds"]["max_y"], 2050);
        assert_eq!(
            (
                mv["width"].as_u64().unwrap(),
                mv["height"].as_u64().unwrap()
            ),
            (400, 400)
        );
        assert_eq!(mv["pins"][0][0], 100);
        assert_eq!(mv["pins"][0][1], 120);
        assert_eq!(mv["editable"], true);
    }

    #[test]
    fn observation_json_map_gumps_empty_by_default() {
        let v = observation_to_json(&Observation::default());
        assert!(v["map_gumps"].as_array().unwrap().is_empty());
    }

    #[test]
    fn gump_element_serializes_cliloc_reference_unresolved() {
        use anima_core::gump_layout::{GumpElement, HtmlText};
        let el = GumpElement::Html {
            x: 1,
            y: 2,
            w: 100,
            h: 20,
            text: HtmlText::Cliloc {
                id: 1042971,
                args: Some("a\tb".into()),
            },
            page: 0,
        };
        let v = gump_element_json(&el);
        assert_eq!(v["type"], "html");
        assert_eq!(v["text"]["cliloc"]["id"], 1042971);
        assert_eq!(v["text"]["cliloc"]["args"], "a\tb");
    }
}

#[cfg(test)]
mod housing_observation_tests {
    use super::*;
    use anima_core::world::{HouseDesign, HousePlane, World};

    #[test]
    fn authoritative_house_design_is_visible_headless_and_pruned_on_delete() {
        let mut world = World::new();
        world.customizing_house = Some(42);
        world.house_designs.insert(
            42,
            HouseDesign {
                revision: 7,
                planes: vec![HousePlane {
                    mode: 0,
                    plane_z: 0,
                    data: vec![0x05, 0x18, 255, 2, 27],
                }],
                ..Default::default()
            },
        );
        let value = observation_to_json(&world.observe(&mut 0));
        assert_eq!(value["customizing_house"], 42);
        assert_eq!(value["house_designs"][0]["revision"], 7);
        assert_eq!(
            value["house_designs"][0]["planes"][0]["data"],
            json!([5, 24, 255, 2, 27])
        );
        world.remove(42);
        let value = observation_to_json(&world.observe(&mut 0));
        assert_eq!(value["house_designs"], json!([]));
        // An item leaving view does not end a server-owned design session.
        anima_core::net::game::apply_packet(
            &mut world,
            &[
                0xbf, 0, 17, 0, 0x20, 0, 0, 0, 42, 5, 0, 0, 255, 255, 255, 255, 255,
            ],
        );
        assert!(observation_to_json(&world.observe(&mut 0))["customizing_house"].is_null());
    }
}
