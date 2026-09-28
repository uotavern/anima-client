//! Tests for the scene builder and the walkability/Z math under it.
//!
//! An ordinary `mod tests` (`use super::*` reaches every private helper);
//! it lives in its own file because it outgrew the module it tests. The
//! ones marked `#[ignore]` need real UO data files — see docs/TESTING.md.

use super::*;
use anima_assets::ZReason;

#[test]
fn ceil_hz_cave_does_not_hide_a_roof_below_the_ceiling() {
    // ClassicUO land-overhang branch: maxZ = pz+16, `_noDrawRoofs` stays false.
    // A roof at z=10 under a cave ceiling of 16 must still draw — inferring
    // `_noDrawRoofs` from `max_z < 127` is what used to hide every roof in view.
    assert!(!ceil_hz(10, 16, false, true));
    assert!(
        ceil_hz(16, 16, false, true),
        "z >= max_z still hides, even in a cave"
    );
    assert!(!ceil_hz(15, 16, false, false));
}

#[test]
fn ceil_hz_high_z_clamp_still_hides_roofs() {
    // Player z≥111 clamps max_z back to 127; `_noDrawRoofs` must survive that
    // or the roof stays drawn (`GameSceneDrawingSorting.cs:203-206`).
    assert!(ceil_hz(120, 127, true, true));
    assert!(
        !ceil_hz(120, 127, true, false),
        "a non-roof at z<max_z stays drawn"
    );
    assert!(!ceil_hz(50, 127, false, true), "open sky draws roofs");
}

#[test]
fn gump_layout_parses_common_commands() {
    let layout = "{ resizepic 0 0 5054 200 120 }{ button 20 90 247 248 1 0 7 }\
                  { text 20 20 0 0 }{ checkbox 20 50 210 211 1 3 }\
                  { textentry 20 65 120 18 0 4 1 }";
    let text = vec!["Accept the quest?".to_string(), "Name".to_string()];
    let parsed = gump_layout::parse(layout, &text);
    let els: Vec<Value> = parsed
        .elements
        .iter()
        .map(|e| gump_element_json(e, None))
        .collect();
    // Width comes straight from the resizepic; height grows to fit elements
    // that extend below it (the button at y=90 + padding).
    assert_eq!(parsed.width, 200);
    assert!(parsed.height >= 120, "h={}", parsed.height);

    // bg, button(id 7), text("Accept…"), check(id 3,on), entry(id 4,"Name").
    let kinds: Vec<&str> = els.iter().map(|e| e["t"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["bg", "button", "text", "check", "entry"]);
    assert_eq!(els[1]["id"], 7);
    // pageflag 1 (reply) — this is what makes the button send a GumpResponse
    // instead of jumping pages locally.
    assert_eq!(els[1]["pageflag"], 1);
    assert_eq!(els[2]["s"], "Accept the quest?");
    assert_eq!(
        (els[3]["id"].as_i64(), els[3]["on"].as_i64()),
        (Some(3), Some(1))
    );
    assert_eq!(els[4]["id"], 4);
    assert_eq!(els[4]["s"], "Name");
}

#[test]
fn gump_layout_tracks_pages_and_button_pageflag() {
    // Elements before the first "page" token are page 0 (always visible,
    // e.g. the background + a "next"/"prev" nav button that must show no
    // matter which page is active). "page 1" then "page 2" bracket the two
    // navigable sections; the pageflag-0 button on page 1 jumps to page 2
    // locally (no server round-trip), while the pageflag-1 button on page 2
    // is a real reply button.
    let layout = "{ resizepic 0 0 5054 200 200 }\
                  { page 1 }{ text 10 10 0 0 }\
                  { button 10 30 4005 4007 0 2 0 }\
                  { page 2 }{ text 10 10 0 1 }\
                  { button 10 30 247 248 1 0 99 }";
    let text = vec!["Page one".to_string(), "Page two".to_string()];
    let parsed = gump_layout::parse(layout, &text);
    let els: Vec<Value> = parsed
        .elements
        .iter()
        .map(|e| gump_element_json(e, None))
        .collect();

    // bg(page0), text(page1), button(page1, pageflag0→page2), text(page2), button(page2, pageflag1, id99)
    let pages: Vec<i64> = els.iter().map(|e| e["page"].as_i64().unwrap()).collect();
    assert_eq!(pages, [0, 1, 1, 2, 2]);

    let jump_btn = &els[2];
    assert_eq!(jump_btn["t"], "button");
    assert_eq!(jump_btn["pageflag"], 0);
    assert_eq!(jump_btn["param"], 2); // switches to page 2, contacts no server

    let reply_btn = &els[4];
    assert_eq!(reply_btn["t"], "button");
    assert_eq!(reply_btn["pageflag"], 1);
    assert_eq!(reply_btn["id"], 99); // reply id sent to the server on click
}

#[test]
fn gump_layout_preserves_html_tags_and_handles_cliloc() {
    // Tags are no longer stripped here — the client's `renderGumpHtml`
    // interprets them (CENTER/BASEFONT/etc.) for display; the scene JSON
    // just carries the resolved string through unchanged, same as it
    // always has for a cliloc-driven `html` element.
    let layout = "{ htmlgump 5 5 180 40 0 0 0 }{ xmfhtmlgump 5 50 180 20 1015313 0 0 }";
    let text = vec!["<basefont color=#fff>Hello <b>world</b>".to_string()];
    let parsed = gump_layout::parse(layout, &text);
    let els: Vec<Value> = parsed
        .elements
        .iter()
        .map(|e| gump_element_json(e, None))
        .collect();
    assert_eq!(els[0]["s"], "<basefont color=#fff>Hello <b>world</b>");
    assert_eq!(els[1]["s"], "#1015313"); // cliloc placeholder (no table)
}

#[test]
fn equip_conv_gump_resolves_bare_and_baked_ids() {
    // A bare graphic id (below MALE_GUMP_OFFSET) just gets the wearer's gender
    // offset added — e.g. Equipconv.def's "0 → equipmentID" / "-1 → newGraphic"
    // cases store a plain item graphic like 538 or 977.
    assert_eq!(equip_conv_gump(400, 538), 50_538); // male wearer
    assert_eq!(equip_conv_gump(401, 538), 60_538); // female wearer (401)
                                                   // A value already baked with SOME gender's offset gets that offset
                                                   // stripped and the wearer's ACTUAL gender's offset re-added (ClassicUO
                                                   // `GetAnimID`) — here the def literally stores the female-baked 61250 for
                                                   // a female (401) wearer, so it round-trips unchanged...
    assert_eq!(equip_conv_gump(401, 61_250), 61_250);
    // ...but a MALE wearer (400) re-bases it onto the male offset instead.
    assert_eq!(equip_conv_gump(400, 61_250), 51_250);
    // A male-baked id (50xxx) re-based onto a female wearer.
    assert_eq!(equip_conv_gump(401, 50_684), 60_684);
    // Elf female body (606) is EVEN — must not fall out via a parity test.
    assert_eq!(equip_conv_gump(606, 538), 60_538);
}

// ---- build_scene coverage -------------------------------------------------
//
// `build_scene` itself takes `&mut Session`, and `Session` can only be built
// via `connect_and_login` (a live `TcpStream`) — per this crate's testing
// convention (see `route_tests`'s doc in `lib.rs`), unit tests don't spin up
// a live Session/socket. `tile_walkable`/`can_walk`/`can_step_to` similarly
// need a real `anima_assets::MapData`, which only opens actual UO data files
// (no in-memory constructor) — coverage for these needs either a `MapData`
// test constructor (a real seam, not attempted here) or an `#[ignore]`d test
// gated on a local UO install; `can_step_to` (which `can_walk`/`step_ok` now
// wrap) has exactly that below (`can_step_to_allows_the_stairs_climb_...`).
// `calculate_new_z` avoids this by testing its `bound_min_max_z`/
// `resolve_standing_z` pure cores directly with synthetic `PathObj` literals
// (see the staircase tests below), plus one `#[ignore]`d real-data test
// against an actual staircase for end-to-end confidence.
//
// What *is* both pure (`&World`/primitives in, `Value`/`bool` out) and where
// most of the shaping logic actually lives has been tested directly below:
// the `*_json` helpers `build_scene` calls, plus the two little pieces
// (`stack_fields`/`corpse_fields`) pulled out of its item loop so the
// corpse/stackable shaping is unit-testable without a live Session.

use anima_assets::MultiComponent;
use anima_core::types::{Position, Serial};
use anima_core::world::{
    Book, HuePicker, LegacyMenu, LegacyMenuEntry, LegacyMenuKind, MultiPlacement, PopupEntry,
    PopupMenu, PromptKind, PromptState, TargetCursor, TipKind, TradeState,
};

#[test]
fn player_is_ghost_recognizes_all_servuo_ghost_bodies() {
    let mut w = World::default();
    assert!(!player_is_ghost(&w), "no player yet");

    w.player = Some(Serial(1));
    w.mobile_mut(1).body = 400; // ordinary human male
    assert!(!player_is_ghost(&w));

    for body in [402, 403, 607, 608, 694, 695, 970] {
        w.mobile_mut(1).body = body;
        assert!(player_is_ghost(&w), "body {body} must be a ghost");
    }
}

#[test]
fn trades_json_empty_when_no_sessions_reflects_when_open() {
    let mut w = World::default();
    assert_eq!(trades_json(&w), json!([]), "no trades → empty array");

    w.open_trade(TradeState {
        opponent_serial: 0x1001,
        opponent_name: "Bob".to_string(),
        my_container: 0x2001,
        their_container: 0x2002,
        my_accept: true,
        their_accept: false,
        my_offer_gold: 50,
        my_offer_platinum: 0,
        their_offer_gold: 0,
        their_offer_platinum: 1,
        balance_gold: 500,
        balance_platinum: 2,
    });
    let v = trades_json(&w);
    let arr = v.as_array().expect("array");
    assert_eq!(arr.len(), 1);
    let t = &arr[0];
    assert_eq!(t["opponent"], "Bob");
    assert_eq!(t["opponentSerial"], 0x1001);
    assert_eq!(t["myCont"], 0x2001);
    assert_eq!(t["theirCont"], 0x2002);
    assert_eq!(t["myAccept"], true);
    assert_eq!(t["theirAccept"], false);
    assert_eq!(t["myOfferGold"], 50);
    assert_eq!(t["theirOfferPlat"], 1);
    assert_eq!(t["balanceGold"], 500);
}

#[test]
fn prompt_json_reports_active_and_ids_or_inactive() {
    let mut w = World::default();
    assert_eq!(prompt_json(&w), json!({ "active": 0 }), "no prompt pending");

    w.prompt = Some(PromptState {
        sender_serial: 0x77,
        prompt_id: 42,
        kind: PromptKind::Ascii,
    });
    assert_eq!(
        prompt_json(&w),
        json!({ "active": 1, "serial": 0x77, "promptId": 42, "kind": "ascii" })
    );
}

#[test]
fn open_urls_json_preserves_seq_and_validated_url() {
    let mut w = World::default();
    assert_eq!(open_urls_json(&w), json!([]));
    w.push_open_url("https://uo.com/news".into());
    w.push_open_url("http://localhost:8080/help".into());
    assert_eq!(
        open_urls_json(&w),
        json!([
            { "seq": 1, "url": "https://uo.com/news" },
            { "seq": 2, "url": "http://localhost:8080/help" },
        ])
    );
}

#[test]
fn container_opens_json_skips_vendor_buy_and_spellbook_gump_ids() {
    let mut w = World::default();
    // DisplayBuyList (vendor "Buy" window): gumpId 0x30 — must NOT open a
    // (spurious, empty) container window; the vendor's shop already opens
    // via `shop`/0x74/0x3B.
    w.push_container_open(0x1000_0055, 0x0030);
    assert_eq!(
        container_opens_json(&w),
        json!([]),
        "vendor buy gumpId must not signal an open"
    );

    // DisplaySpellbook: gumpId 0xFFFF — must NOT open one either; the book
    // already opens via `spellbooks`/0xBF/0x1B.
    w.push_container_open(0x4000_0066, 0xFFFF);
    assert_eq!(
        container_opens_json(&w),
        json!([]),
        "spellbook gumpId must not signal an open"
    );

    // A normal container gumpId (e.g. a bank box) DOES open.
    w.push_container_open(0x4000_0077, 0x0048);
    assert_eq!(
        container_opens_json(&w),
        json!([{ "seq": 3, "serial": 0x4000_0077u32 }]),
        "a real container gumpId must still signal an open"
    );
}

#[test]
fn a_server_only_container_open_carries_both_halves_the_window_needs() {
    // The banker's-box case: no local `openContainer` ever ran (the box is on
    // the player's Bank layer, not something in view to double-click), so the
    // ONLY thing that puts a window on screen is 0x24 → `containerOpens` →
    // `ingestContainerOpens` → `openContainer` (web/js/08-overlays.js). Two
    // scene fields have to agree for that window to be *visible*, and losing
    // either one reads to a player as "nothing opened":
    //
    //   * `containerOpens` names the serial, or nothing is opened at all;
    //   * `contGumps` names the SAME serial, or `refreshContainer` parks the
    //     window in its "0x24 hasn't landed yet" placeholder — chromeless and
    //     transparent, i.e. invisible (web/js/10-housing.js).
    //
    // ClassicUO does both in one step, which is why it cannot drift apart
    // there: `PacketHandlers.cs:1305` `OpenContainer` passes the packet's
    // `graphic` straight into `new ContainerGump(world, item, graphic,
    // playsound)`. We split it because the gump id is retained state and the
    // open is an event (see [`anima_core::world::World::container_gumps`]), so
    // it is worth pinning that the split stays consistent.
    let mut w = World::default();
    // ServUO gives a bank box (item 0xE7C) gump 0x4A — `Data/containers.cfg`.
    const BANK: u32 = 0x4000_0123;
    w.push_container_open(BANK, 0x004A);

    assert_eq!(
        container_opens_json(&w),
        json!([{ "seq": 1, "serial": BANK }]),
        "a server-initiated open must reach the renderer as an open event"
    );
    assert_eq!(
        w.container_gumps.get(&BANK),
        Some(&0x004A),
        "…and the same 0x24 must leave behind the art the window draws from"
    );
    // `contInfo` covers the serial too, even though a bank box is not an item
    // this client necessarily holds — see `container_info_resolves_graphic_and_
    // falls_back` for the g=0/no-name degradation that keeps the entry present.
    let look = Look {
        map: None,
        anim: None,
        animdata: None,
        tileart: None,
    };
    assert!(container_info_json(&w, &look).contains_key(&BANK.to_string()));

    // The two overloads stay excluded (see `container_opens_json_skips_vendor_
    // buy_and_spellbook_gump_ids`) — but note they still land in the retained
    // map, because that filter is the *open-a-window* policy, not a claim about
    // what 0x24 said.
    w.push_container_open(0x1000_0055, GUMP_ID_VENDOR_BUY);
    assert_eq!(
        container_opens_json(&w),
        json!([{ "seq": 1, "serial": BANK }]),
        "a vendor buy list must not add a second container window"
    );
}

#[test]
fn drag_completions_json_preserves_packet_and_optional_token() {
    let mut w = World::default();
    assert_eq!(drag_completions_json(&w), json!([]));

    w.push_drag_completion(0x28, Some(0x4000_1234));
    w.push_drag_completion(0x29, None);
    assert_eq!(
        drag_completions_json(&w),
        json!([
            { "seq": 1, "packet": 0x28, "token": 0x4000_1234u32 },
            { "seq": 2, "packet": 0x29, "token": null }
        ])
    );
}

#[test]
fn death_screen_json_is_a_seq_gated_event_not_alive_state() {
    let mut w = World::default();
    assert_eq!(death_screen_json(&w), Value::Null);

    w.on_death_screen(0);
    assert_eq!(death_screen_json(&w), json!({ "seq": 1, "action": 0 }));
    w.on_death_screen(2);
    assert_eq!(death_screen_json(&w), json!({ "seq": 2, "action": 2 }));

    w.on_death_screen(1);
    assert_eq!(death_screen_json(&w), json!({ "seq": 2, "action": 2 }));
}

#[test]
fn paperdoll_json_null_when_none_reports_when_set() {
    let mut w = World::default();
    assert_eq!(paperdoll_json(&w), Value::Null, "no paperdoll signal yet");

    w.set_paperdoll(
        0xDEAD_BEEFu32,
        "Anima the Adventurer".to_string(),
        true,
        false,
    );
    assert_eq!(
        paperdoll_json(&w),
        json!({
            "seq": 1, "serial": 0xDEAD_BEEFu32, "title": "Anima the Adventurer",
            "warmode": true, "canLift": false,
        })
    );
}

#[test]
fn maps_json_empty_then_reports_bounds_and_pins() {
    let mut w = World::default();
    assert_eq!(maps_json(&w), json!([]), "no map window open yet");

    w.set_map_view(0x4000_1234, 0x139D, 3, 520, 0, 2580, 2050, 400, 400);
    w.apply_map_command(0x4000_1234, 1, 0, 100, 120); // chest pin, index 0
    assert_eq!(
        maps_json(&w),
        json!([{
            "serial": 0x4000_1234u32, "openSeq": 1, "gumpArt": 0x139D, "facet": 3,
            "bounds": { "minX": 520, "minY": 0, "maxX": 2580, "maxY": 2050 },
            "w": 400, "h": 400,
            "pins": [[100, 120]],
            "editable": false,
        }])
    );

    // A re-decode/re-click bumps `openSeq` — the web client's seq-gate is
    // what tells it to reopen a closed window.
    w.set_map_view(0x4000_1234, 0x139D, 3, 520, 0, 2580, 2050, 400, 400);
    let v = maps_json(&w);
    assert_eq!(v[0]["openSeq"], 2);
    assert_eq!(
        v[0]["pins"].as_array().unwrap().len(),
        0,
        "a resend resets pins"
    );
}

#[test]
fn resolve_shop_name_leaves_plain_names_alone() {
    assert_eq!(resolve_shop_name("a hatchet", None), "a hatchet");
    // A small numeric-looking name (below the cliloc-id floor) is left as-is.
    assert_eq!(resolve_shop_name("123", None), "123");
}

#[test]
fn resolve_shop_name_resolves_cliloc_shaped_ids_bare_and_hashed() {
    // No table loaded → falls back to the raw string exactly as given
    // (the '#' is only stripped for the numeric *parse*, not the fallback).
    assert_eq!(resolve_shop_name("1060834", None), "1060834");
    assert_eq!(resolve_shop_name("#1060834", None), "#1060834");

    // With a real (synthetic, on-disk) Cliloc table, both ServUO's actual
    // bare-numeric shape (`IShopSellInfo.GetNameFor`'s `LabelNumber.ToString()`)
    // and a hypothetical '#'-prefixed one resolve to the same real name.
    // `Cliloc` only loads from a directory (`Cliloc::open`), so this writes a
    // minimal synthetic `Cliloc.enu` (6-byte header + one record — same shape
    // `anima_assets::cliloc`'s own tests build) to a scratch dir.
    let dir = std::env::temp_dir().join(format!(
        "anima_scene_test_cliloc_{}_{}",
        std::process::id(),
        line!()
    ));
    std::fs::create_dir_all(&dir).expect("create scratch dir");
    let id: u32 = 1_060_834;
    let text = "a hatchet";
    let mut buf = vec![0u8; 6]; // 6-byte header, contents unused by the parser
    buf.extend_from_slice(&id.to_le_bytes());
    buf.push(0); // flag
    buf.extend_from_slice(&(text.len() as u16).to_le_bytes());
    buf.extend_from_slice(text.as_bytes());
    std::fs::write(dir.join("Cliloc.enu"), &buf).expect("write synthetic Cliloc.enu");
    let cliloc = Cliloc::open(&dir).expect("open synthetic Cliloc.enu");

    assert_eq!(resolve_shop_name("1060834", Some(&cliloc)), "a hatchet");
    assert_eq!(resolve_shop_name("#1060834", Some(&cliloc)), "a hatchet");

    let _ = std::fs::remove_dir_all(&dir); // best-effort cleanup
}

#[test]
fn stack_fields_marks_stackable_only_when_flagged() {
    // A stack of reagents (Stackable tiledata flag set): "amount" + "st":1 so
    // the renderer offers the split-stack dialog, and "pl":1 so it draws as a
    // heap (ClassicUO's second sprite at -5,-5).
    assert_eq!(
        stack_fields(40, true, false),
        json!({ "amount": 40, "st": 1, "pl": 1 })
    );
    // A non-stackable item (e.g. a sword) never gets "st", even with
    // amount > 1 (shouldn't normally happen, but the field must still be
    // omitted so the renderer doesn't offer to split it).
    assert_eq!(stack_fields(1, false, false), json!({ "amount": 1 }));
    assert_eq!(stack_fields(5, false, false), json!({ "amount": 5 }));
}

#[test]
fn stack_fields_pile_bit_follows_classicuo_item_view() {
    // ClassicUO `ItemView.Draw`: `!IsMulti && !IsCoin && Amount > 1 &&
    // IsStackable`. One of the four failing is enough to suppress the pile.
    // A single stackable item is not a pile.
    assert_eq!(
        stack_fields(1, true, false),
        json!({ "amount": 1, "st": 1 })
    );
    // Coins are excluded — they carry amount-tiered art instead. All three of
    // `Item.IsCoin`'s graphics, not just gold.
    assert_eq!(
        stack_fields(600, true, true),
        json!({ "amount": 600, "st": 1 })
    );
    // Not stackable → no pile even at a nonsense amount.
    assert_eq!(stack_fields(9, false, false), json!({ "amount": 9 }));
}

#[test]
fn worn_light_offset_matches_classicuo_add_light() {
    // ClassicUO `GameScene.AddLight` (`:466-497`), relative to the tile centre
    // both of its mobile call sites pass. Five of the eight facings move the
    // flame into the hand; North, West and Up leave it on the body.
    assert_eq!(worn_light_offset(0), (0, 0)); // North
    assert_eq!(worn_light_offset(1), (22, 33)); // Right
    assert_eq!(worn_light_offset(2), (22, 55)); // East
    assert_eq!(worn_light_offset(3), (0, 55)); // Down
    assert_eq!(worn_light_offset(4), (-22, 55)); // South
    assert_eq!(worn_light_offset(5), (-22, 33)); // Left
    assert_eq!(worn_light_offset(6), (0, 0)); // West
    assert_eq!(worn_light_offset(7), (0, 0)); // Up
                                              // The running bit (0x80) rides in the same byte a mobile's direction does;
                                              // it must not fall through to the no-offset arm.
    assert_eq!(worn_light_offset(0x80 | 2), (22, 55));
}

#[test]
fn light_blocked_only_by_an_opaque_wall_in_the_band() {
    const OPAQUE: u64 = 0;
    // A torch at z=0: the floor it stands on never blocks it…
    assert!(!light_blocked(0, 127, &[(0, OPAQUE), (4, OPAQUE)]));
    // …but a wall piece from z+5 up does. That 5 is ClassicUO's `z5`.
    assert!(light_blocked(0, 127, &[(5, OPAQUE)]));
    assert!(light_blocked(0, 127, &[(40, OPAQUE)]));
    // Above the draw ceiling it has already been culled, so it cannot block.
    assert!(!light_blocked(0, 20, &[(20, OPAQUE)]));
    assert!(light_blocked(0, 20, &[(19, OPAQUE)]));
    // A window/grate/archway (`TileFlag.Transparent`) lets the light through.
    assert!(!light_blocked(0, 127, &[(10, FLAG_TRANSPARENT)]));
    // Transparent is 0x4, NOT the 0x8 Translucent next door — a translucent
    // curtain still blocks.
    assert!(light_blocked(0, 127, &[(10, FLAG_TRANSLUCENT)]));
    // A torch raised onto a table still shines over a low wall beside it.
    assert!(!light_blocked(20, 127, &[(10, OPAQUE)]));
    assert!(!light_blocked(0, 127, &[]));
}

#[test]
fn classicuo_light_ranges_force_shape_2_without_a_tiledata_flag() {
    // No map: `item_light_range` is a pure graphic test, and `item_light`'s
    // range arm must not need one either.
    let look = Look {
        map: None,
        anim: None,
        animdata: None,
        tileart: None,
    };
    // `ItemView.Draw`'s two ranges — ServUO's spell fields live in them.
    for g in [0x3E02, 0x3E07, 0x3E0B, 0x3914, 0x3922, 0x3929] {
        assert!(look.item_light_range(g), "0x{g:04X}");
        assert!(look.ground_item_is_light(g), "0x{g:04X}");
        assert_eq!(look.item_light(g).0, 2, "0x{g:04X} is AddLight's shape 2");
    }
    // Just outside both ranges, and the flag is all that is left.
    for g in [0x3E01, 0x3E0C, 0x3913, 0x392A] {
        assert!(!look.item_light_range(g), "0x{g:04X}");
        assert!(!look.ground_item_is_light(g), "0x{g:04X}");
    }
    // `AddLight`'s third special graphic is a lone id, not a range: a candelabra
    // is IsLight with tiledata shape 1, and ClassicUO overrides it to 2.
    assert_eq!(look.item_light(0x0B1D).0, 2);
    assert!(
        !look.item_light_range(0x0B1D),
        "…but it is not part of the GATE"
    );
}

/// The three ways a carried light differs from one on the ground, against real
/// tiledata: it exists at all, it sits on the WEARER's tile, and it takes the
/// facing nudge. Graphic 0x0A12 is tiledata's "torch" (LightSource, light.mul
/// shape 2).
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn a_carried_torch_lights_its_wearers_tile() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let map = MapData::open(&dir).expect("open map data");
    const TORCH: u16 = 0x0A12;
    const MOB: u32 = 0x201;
    const HELD: u32 = 0x202;
    let look = Look {
        map: Some(&map),
        anim: None,
        animdata: None,
        tileart: None,
    };

    let mut world = anima_core::World::new();
    let m = world.mobile_mut(MOB);
    m.pos.x = 100;
    m.pos.y = 200;
    m.pos.z = 5;
    m.direction = 2; // East
    let it = world.item_mut(HELD);
    it.serial = HELD;
    it.graphic = TORCH;
    it.container = Some(MOB);
    it.layer = 1; // one-handed
    it.pos.x = 4000; // an equipped item's own coords are meaningless
    it.pos.y = 4000;

    // [0] is the player's own glow; [1] is the torch, on the WEARER's tile.
    let lights = lights_json(&world, &look, 0, 0, 0);
    assert_eq!(lights.len(), 2, "{lights:?}");
    assert_eq!(
        (
            lights[1]["x"].as_i64(),
            lights[1]["y"].as_i64(),
            lights[1]["z"].as_i64()
        ),
        (Some(100), Some(200), Some(5)),
        "a held light follows the body, not the item's stale coords"
    );
    assert_eq!(
        lights[1]["id"].as_u64(),
        Some(2),
        "light.mul shape from tiledata"
    );
    assert_eq!(
        (lights[1]["dx"].as_i64(), lights[1]["dy"].as_i64()),
        (Some(22), Some(55)),
        "facing East puts the flame in the hand"
    );

    // Facing North takes no nudge, and the keys are omitted rather than zeroed.
    world.mobile_mut(MOB).direction = 0;
    let lights = lights_json(&world, &look, 0, 0, 0);
    assert!(
        lights[1].get("dx").is_none() && lights[1].get("dy").is_none(),
        "{lights:?}"
    );

    // The same torch loose in a backpack lights nothing: `layer == 0`.
    world.item_mut(HELD).layer = 0;
    assert_eq!(lights_json(&world, &look, 0, 0, 0).len(), 1);

    // …and one whose holder is not a mobile we can see lights nothing either.
    world.item_mut(HELD).layer = 1;
    world.item_mut(HELD).container = Some(0xDEAD);
    assert_eq!(lights_json(&world, &look, 0, 0, 0).len(), 1);

    // The gate is asymmetric, as ClassicUO's is: a spell-field graphic lights
    // the GROUND (`ItemView`'s extra range test) but not a wearer (`MobileView`
    // tests the tiledata flag alone) — and this one has no flag to test.
    let it = world.item_mut(HELD);
    it.graphic = 0x3915; // ServUO PoisonField
    it.layer = 1;
    it.container = Some(MOB);
    assert!(!map.item_is_light(0x3915), "the range items carry no flag");
    assert_eq!(lights_json(&world, &look, 0, 0, 0).len(), 1, "not worn");
    let it = world.item_mut(HELD);
    it.container = None;
    it.pos.x = 300;
    it.pos.y = 400;
    let lights = lights_json(&world, &look, 0, 0, 0);
    assert_eq!(lights.len(), 2, "on the ground it glows: {lights:?}");
    assert_eq!(lights[1]["id"].as_u64(), Some(2), "AddLight's shape 2");
    assert_eq!(lights[1]["x"].as_i64(), Some(300));
}

/// The occlusion pass end to end, against a real Britain stone wall: ClassicUO
/// tests the tile at `(x + 1, y + 1)`, so a light one tile up-left of the wall
/// is the one it kills.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn a_light_behind_a_britain_wall_is_dropped() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    let world = anima_core::World::new();
    // (1491,1620) is a four-storey Britain wall — stone at z=10, plaster at 20
    // and 40, a beam at 60, all opaque; (1490,1620) carries no statics at all.
    let light = |x: i64, y: i64, z: i32| json!({ "x": x, "y": y, "z": z, "r": 3, "id": 2 });

    let mut lights = vec![
        light(0, 0, 0),       // index 0: the player's own glow, always exempt
        light(1490, 1619, 0), // in front of it sits the wall
        light(1489, 1619, 0), // in front of it sits nothing
    ];
    apply_light_occlusion(&world, &mut map, None, 127, &mut lights);
    assert_eq!(lights.len(), 2, "the walled-in light is gone: {lights:?}");
    assert_eq!(
        lights[0]["x"].as_i64(),
        Some(0),
        "the personal glow survives"
    );
    assert_eq!(lights[1]["x"].as_i64(), Some(1489));

    // Raise the light above the whole wall and it shines again — the band is
    // `[z + 5, maxZ)`, so a torch on the roof clears every storey below it.
    let mut lights = vec![light(0, 0, 0), light(1490, 1619, 60)];
    apply_light_occlusion(&world, &mut map, None, 127, &mut lights);
    assert_eq!(lights.len(), 2, "{lights:?}");

    // Lower the draw ceiling under the wall (standing inside a building) and the
    // wall stops blocking, because it is no longer drawn.
    let mut lights = vec![light(0, 0, 0), light(1490, 1619, 0)];
    apply_light_occlusion(&world, &mut map, None, 10, &mut lights);
    assert_eq!(lights.len(), 2, "{lights:?}");

    // Even a light standing exactly where the player is gets tested, unless it
    // is the personal one — the exemption is positional, not by content.
    let mut lights = vec![light(1490, 1619, 0), light(1490, 1619, 0)];
    apply_light_occlusion(&world, &mut map, None, 127, &mut lights);
    assert_eq!(lights.len(), 1);
}

#[test]
fn hidden_field_present_only_when_true() {
    assert_eq!(hidden_field(true), json!({ "hidden": true }));
    // Not hidden → no key at all (not `"hidden": false`), so the renderer's
    // default (fully opaque) needs no per-mobile check.
    assert_eq!(hidden_field(false), json!({}));
}

#[test]
fn overhead_covers_matches_classicuo_inequality() {
    // GameSceneDrawingSorting.HasSurfaceOverhead: tile.Z > obj.Z, NoShoot|Window,
    // and `_maxZ - tile.Z + 5 >= tile.Z - obj.Z`.
    const NS: u64 = FLAG_NOSHOOT;
    const WIN: u64 = FLAG_WINDOW;
    // Outside (maxZ=127): a noshoot/window slab above the mobile covers it.
    assert!(overhead_covers(0, 127, 20, NS));
    assert!(overhead_covers(0, 127, 20, WIN));
    assert!(
        !overhead_covers(0, 127, 20, FLAG_ROOF),
        "a roof flag alone is not cover"
    );
    assert!(
        !overhead_covers(0, 127, 0, NS),
        "same-Z wall is not above the mobile"
    );
    // Inside a house maxZ sits at the eave. A noshoot at that same Z is NOT close
    // enough: 20-20+5 >= 20-0 → 5 >= 20, so the NPC in the room stays drawn.
    assert!(!overhead_covers(0, 20, 20, NS));
    // A slightly higher ceiling still covers: 40-20+5 >= 20 → 25 >= 20.
    assert!(overhead_covers(0, 40, 20, NS));
}

#[test]
fn surface_overhead_requires_the_whole_4x4() {
    let mut covered = std::collections::HashSet::new();
    for dy in -1..=2 {
        for dx in -1..=2 {
            covered.insert((dx, dy));
        }
    }
    assert!(has_surface_overhead_neighborhood(
        |dx, dy| covered.contains(&(dx, dy))
    ));
    covered.remove(&(2, 2));
    assert!(!has_surface_overhead_neighborhood(
        |dx, dy| covered.contains(&(dx, dy))
    ));
}

#[test]
fn corpse_equip_only_lists_what_is_still_on_the_corpse() {
    // 0x89 CorpseEquip is a one-shot snapshot; nothing on the wire retracts it
    // when a layer is looted. The view therefore has to ask what the corpse
    // *currently* holds — ClassicUO gets that for free from `FindItemByLayer`,
    // which searches the container's live contents.
    //
    // With no data files a `Look` resolves every AnimID to 0, so this asserts
    // the container rule the only way it can be asserted here: an item that has
    // left the corpse is dropped before any art lookup happens. The layering
    // itself is verified live (docs/CLASSICUO_GAPS.md, Tier 3).
    let mut world = anima_core::World::new();
    const CORPSE: u32 = 0x4001_9947;
    const WORN: u32 = 0x4001_9940;
    const LOOTED: u32 = 0x4001_9944;
    for (serial, container) in [(WORN, CORPSE), (LOOTED, 0x1234)] {
        let it = world.item_mut(serial);
        it.serial = serial;
        it.graphic = 0x1516;
        it.container = Some(container);
    }
    world.set_corpse_equip(CORPSE, vec![(23, WORN), (2, LOOTED)]);
    let look = Look {
        map: None,
        anim: None,
        animdata: None,
        tileart: None,
    };
    // Both entries survive the container filter or not; with no tiledata both
    // then fail the AnimID check, so the observable difference is on the World
    // side. Assert the rule directly against what the corpse holds.
    let still_worn: Vec<u32> = world.corpse_equip[&CORPSE]
        .iter()
        .filter(|&&(_, s)| world.items.get(&s).and_then(|i| i.container) == Some(CORPSE))
        .map(|&(_, s)| s)
        .collect();
    assert_eq!(still_worn, vec![WORN], "the looted layer must not be drawn");
    assert!(corpse_equip_json(&world, &look, CORPSE, 401).is_empty());
}

#[test]
fn yellow_field_present_only_when_true() {
    assert_eq!(yellow_field(true), json!({ "yellow": true }));
    // An ordinary killable mobile carries no key — the ignore list's guard
    // reads the absence as "fine to ignore".
    assert_eq!(yellow_field(false), json!({}));
}

#[test]
fn poisoned_field_present_only_when_true() {
    assert_eq!(poisoned_field(true), json!({ "poisoned": true }));
    // Not poisoned → no key at all (not `"poisoned": false`), so the
    // renderer's default (HP-fraction-only bar color) needs no per-mobile
    // check.
    assert_eq!(poisoned_field(false), json!({}));
}

#[test]
fn corpse_fields_carries_remapped_body_dir_and_death_group() {
    // Values here are already Corpse.def-remapped/resolved by the caller
    // (`build_scene`'s item loop) — this just checks the shaping.
    let v = corpse_fields(
        /* body */ 26, /* hue */ 1102, /* dir */ 3, /* dg */ 8,
    );
    assert_eq!(v, json!({ "body": 26, "dir": 3, "dg": 8, "hue": 1102 }));
}

#[test]
fn mount_info_for_keeps_the_table_offset() {
    // Offsets the previous `mount_anim_for` discarded. Ethereal horse -9,
    // cu sidhe +18 — the two signs the rider would sit wrong without.
    assert_eq!(mount_info_for(0x3E9B, &|_| 0xFFFF), (0x00C0, -9));
    assert_eq!(mount_info_for(0x3EC7, &|_| 0xFFFF), (0x04E6, 18));
    assert_eq!(mount_info_for(0x0001, &|g| g.wrapping_add(1)), (2, 0));
}

#[test]
fn drag_anims_json_mirrors_the_world_ring() {
    let mut w = World::default();
    w.push_drag_anim(anima_core::world::DragAnimation {
        seq: 0,
        graphic: 0x0EEF,
        hue: 5,
        count: 1,
        source: 0xAAAA,
        source_x: 10,
        source_y: 20,
        source_z: 3,
        dest: 0,
        dest_x: 111,
        dest_y: 222,
        dest_z: 4,
    });
    let v = drag_anims_json(&w);
    assert_eq!(v.len(), 1);
    assert_eq!(v[0]["seq"], 1);
    assert_eq!(v[0]["g"], 0x0EEF);
    assert_eq!(v[0]["hue"], 5);
    assert_eq!(v[0]["src"], 0xAAAA);
    assert_eq!(v[0]["sx"], 10);
    assert_eq!(v[0]["tx"], 111);
    assert_eq!(v[0]["tz"], 4);
}

#[test]
fn party_json_reports_members_leader_and_pending_invite() {
    let mut w = World::default();
    // Not in a party: empty members, leader 0, no invite.
    assert_eq!(
        party_json(&w),
        json!({ "leader": 0, "members": [], "invite": 0 })
    );

    w.party.leader = 0x100;
    w.party.members = vec![0x100, 0x101];
    w.party.pending_invite = Some(0x200);
    // Member 0x101 is in view (has a Mobile); 0x100 (the leader) isn't, so it
    // falls back to the "Member"/0/0 placeholder.
    w.mobile_mut(0x101).name = "Alice".to_string();
    w.mobile_mut(0x101).hits = 80;
    w.mobile_mut(0x101).hits_max = 100;
    let v = party_json(&w);
    assert_eq!(v["leader"], 0x100);
    assert_eq!(v["invite"], 0x200);
    let members = v["members"].as_array().unwrap();
    assert_eq!(members[0]["name"], "Member"); // 0x100 not in view
    assert_eq!(members[1]["name"], "Alice");
    assert_eq!(members[1]["hits"], 80);
    assert_eq!(members[1]["hitsMax"], 100);
    // Mana/stam are 0 until an `Action::StatusRequest` draws a 0x2D for them —
    // nothing pushes another mobile's real values (see `party_json`'s comment).
    assert_eq!(members[1]["mana"], 0);
    assert_eq!(members[1]["stamMax"], 0);
    w.mobile_mut(0x101).mana = 12;
    w.mobile_mut(0x101).mana_max = 40;
    w.mobile_mut(0x101).stam = 30;
    w.mobile_mut(0x101).stam_max = 35;
    let v = party_json(&w);
    let members = v["members"].as_array().unwrap();
    assert_eq!(members[1]["mana"], 12);
    assert_eq!(members[1]["manaMax"], 40);
    assert_eq!(members[1]["stam"], 30);
    assert_eq!(members[1]["stamMax"], 35);
}

#[test]
fn popup_json_null_when_absent_resolves_entries_when_open() {
    let mut w = World::default();
    assert_eq!(popup_json(&w, None), Value::Null);

    w.popup = Some(PopupMenu {
        serial: 0x555,
        entries: vec![PopupEntry {
            index: 0,
            cliloc: 3000123,
            flags: 0,
        }],
    });
    let v = popup_json(&w, None);
    assert_eq!(v["serial"], 0x555);
    // No Cliloc table available → falls back to "#<id>".
    assert_eq!(v["entries"][0]["text"], "#3000123");
    assert_eq!(v["entries"][0]["index"], 0);
}

#[test]
fn legacy_menus_json_is_sorted_and_preserves_item_metadata() {
    let mut w = World::default();
    w.legacy_menus = vec![
        LegacyMenu {
            serial: 20,
            menu_id: 0,
            question: "Continue?".into(),
            kind: LegacyMenuKind::Question,
            entries: vec![LegacyMenuEntry {
                text: "Yes".into(),
                ..LegacyMenuEntry::default()
            }],
        },
        LegacyMenu {
            serial: 10,
            menu_id: 7,
            question: "Choose".into(),
            kind: LegacyMenuKind::Items,
            entries: vec![LegacyMenuEntry {
                graphic: 0x0F5E,
                hue: 0x0481,
                text: "Sword".into(),
            }],
        },
    ];
    let v = legacy_menus_json(&w);
    assert_eq!(v[0]["serial"], 10);
    assert_eq!(v[0]["kind"], "items");
    assert_eq!(v[0]["entries"][0]["index"], 1);
    assert_eq!(v[0]["entries"][0]["graphic"], 0x0F5E);
    assert_eq!(v[0]["entries"][0]["hue"], 0x0481);
    assert_eq!(v[1]["serial"], 20);
    assert_eq!(v[1]["kind"], "question");
}

#[test]
fn hue_pickers_json_is_sorted_and_exact() {
    let mut w = World::default();
    w.hue_pickers = vec![
        HuePicker {
            serial: 20,
            graphic: 0x2006,
        },
        HuePicker {
            serial: 10,
            graphic: 0x0FAB,
        },
    ];
    assert_eq!(
        hue_pickers_json(&w),
        json!([
            { "serial": 10, "graphic": 0x0FAB },
            { "serial": 20, "graphic": 0x2006 },
        ])
    );
}

#[test]
fn race_change_json_is_null_or_exact() {
    let mut w = World::default();
    assert_eq!(race_change_json(&w), json!(null));
    w.race_change = Some(anima_core::world::RaceChangePrompt {
        female: false,
        race: 1,
    });
    assert_eq!(race_change_json(&w), json!({ "female": false, "race": 1 }));
}

#[test]
fn tips_json_preserves_concurrent_window_identity_and_kind() {
    let mut w = World::default();
    assert_eq!(tips_json(&w), json!([]));
    w.push_tip(0x1234_5678, TipKind::Tip, "First\nSecond".into());
    w.push_tip(9, TipKind::Notice, "Maintenance".into());
    assert_eq!(
        tips_json(&w),
        json!([
            { "seq": 1, "tip": 0x1234_5678u32, "kind": "tip", "text": "First\nSecond" },
            { "seq": 2, "tip": 9, "kind": "notice", "text": "Maintenance" },
        ])
    );
}

#[test]
fn text_entry_dialogs_json_preserves_callbacks_and_constraints() {
    let mut w = World::default();
    assert_eq!(text_entry_dialogs_json(&w), json!([]));
    w.push_text_entry_dialog(
        0x0102_0304,
        5,
        6,
        "Account €".into(),
        true,
        2,
        12,
        "Digits only".into(),
    );
    assert_eq!(
        text_entry_dialogs_json(&w),
        json!([{
            "seq": 1,
            "serial": 0x0102_0304u32,
            "parentId": 5,
            "buttonId": 6,
            "text": "Account €",
            "canClose": true,
            "variant": 2,
            "maxLength": 12,
            "description": "Digits only",
        }])
    );
}

#[test]
fn character_profiles_json_preserves_order_text_and_editability() {
    let mut w = World::default();
    w.character_profiles = vec![
        anima_core::world::CharacterProfile {
            seq: 7,
            serial: 0x0102_0304,
            header: "Header €".into(),
            footer: "Footer 😀".into(),
            body: "Biography".into(),
            can_edit: true,
        },
        anima_core::world::CharacterProfile {
            seq: 8,
            serial: 0,
            header: "Locked".into(),
            footer: String::new(),
            body: "Read only".into(),
            can_edit: false,
        },
    ];
    assert_eq!(
        character_profiles_json(&w),
        json!([
            {
                "seq": 7,
                "serial": 0x0102_0304u32,
                "header": "Header €",
                "footer": "Footer 😀",
                "body": "Biography",
                "canEdit": true,
            },
            {
                "seq": 8,
                "serial": 0,
                "header": "Locked",
                "footer": "",
                "body": "Read only",
                "canEdit": false,
            },
        ])
    );
}

#[test]
fn logout_ack_json_is_null_then_preserves_permission_identity() {
    let mut w = World::default();
    assert_eq!(logout_ack_json(&w), Value::Null);
    w.set_logout_ack(false);
    assert_eq!(logout_ack_json(&w), json!({ "seq": 1, "allowed": false }));
    w.set_logout_ack(true);
    assert_eq!(logout_ack_json(&w), json!({ "seq": 2, "allowed": true }));
}

#[test]
fn boat_movements_json_preserves_rigid_group_and_speed() {
    let mut w = World::default();
    w.push_boat_movement(anima_core::world::BoatMovement {
        seq: 0,
        boat_serial: 0x4000_1000,
        speed: 4,
        moving_direction: 2,
        facing_direction: 6,
        from: anima_core::types::Position {
            x: 10,
            y: 20,
            z: -5,
        },
        to: anima_core::types::Position {
            x: 11,
            y: 20,
            z: -5,
        },
        entities: vec![anima_core::world::BoatMovedEntity {
            serial: 0x42,
            from: anima_core::types::Position {
                x: 10,
                y: 21,
                z: -4,
            },
            to: anima_core::types::Position {
                x: 11,
                y: 21,
                z: -4,
            },
        }],
    });
    assert_eq!(
        boat_movements_json(&w),
        json!([{
            "seq": 1, "boat": 0x4000_1000u32, "speed": 4, "dir": 2, "facing": 6,
            "entities": [
                { "serial": 0x4000_1000u32, "from": { "x": 10, "y": 20, "z": -5 }, "to": { "x": 11, "y": 20, "z": -5 } },
                { "serial": 0x42, "from": { "x": 10, "y": 21, "z": -4 }, "to": { "x": 11, "y": 21, "z": -4 } },
            ]
        }])
    );
}

#[test]
fn book_json_null_when_absent_full_when_open() {
    let mut w = World::default();
    assert_eq!(book_json(&w), Value::Null);

    w.book = Some(Book {
        serial: 0x900,
        title: "Notes".to_string(),
        author: "Anon".to_string(),
        writable: true,
        page_count: 2,
        pages: vec![vec!["hello".to_string()], vec![]],
    });
    let v = book_json(&w);
    assert_eq!(v["title"], "Notes");
    assert_eq!(v["writable"], true);
    assert_eq!(v["pageCount"], 2);
    assert_eq!(v["pages"][0][0], "hello");
}

#[test]
fn map_index_defaults_to_felucca_and_updates_via_on_map_change() {
    // Feeds `build_scene`'s "facet" field directly (`s.world.map_index`, no
    // further shaping) — see `World::map_index`'s doc.
    let mut w = World::default();
    assert_eq!(w.map_index, 0, "facet defaults to Felucca (0)");
    w.player = Some(Serial(1));
    w.mobile_mut(1).pos = Position {
        x: 100,
        y: 100,
        z: 0,
    };
    w.on_map_change(2); // Ilshenar
    assert_eq!(w.map_index, 2);
}

// ---- synthetic staircase tests for calculate_new_z's pure cores ----------
//
// A Bridge-flagged static (ClassicUO `ItemData.IsBridge`, ServUO
// `ItemData.Bridge`) stands at HALF height — `avg_z = z + height/2` — not
// its full top surface (`z + height`). This is intentional on BOTH
// references (ClassicUO `CreateItemList`'s `staticAverageZ /= 2`; ServUO
// `TileData.CalcHeight` halves for `Bridge` too), and it's what makes a
// staircase built from stacked Bridge tiles climb in the first place — a
// synthetic run of 5-tall stair statics based at z=0,5,10,15,20 (as this
// test was originally going to assert should read as its FULL top surface)
// would have been asserting the wrong behavior; these tests assert the
// *correct*, half-height one instead, and that a UNIFORMLY-built staircase
// (each tile based exactly at the half-height of the one before) climbs by
// an EVEN delta per tile — proving the unevenness on the real Britain-bank
// stair (+2, +5, +3) comes from THAT staircase's non-uniform geometry
// (mixed static heights/bases), not from the algorithm.
fn bridge_tile(z: i32, height: i32) -> PathObj {
    PathObj {
        flags: POF_IMPASS | POF_SURFACE | POF_BRIDGE,
        z,
        avg_z: z + height / 2,
        height,
        land_stretched: false,
    }
}

#[test]
fn bridge_tile_stands_at_half_height_not_top_surface() {
    // A single 5-tall stair static at z=0 (top surface = 5): standing Z must
    // be the half-height average (0 + 5/2 = 2), not the top (5).
    let list = vec![bridge_tile(0, 5)];
    let (min_z, max_z) = bound_min_max_z(&[bridge_tile(0, 5)], 0, 0);
    let z = resolve_standing_z(list, min_z, max_z, 0).expect("stands on the bridge tile");
    assert_eq!(
        z, 2,
        "Bridge standing Z is z + height/2, not the top surface (5)"
    );
}

#[test]
fn synthetic_staircase_climbs_and_descends_evenly() {
    // 5 tiles, each an 8-tall Bridge riser based exactly at the HALF-height
    // (avg) of the tile before: bases 0,4,8,12,16 -> avgs 4,8,12,16,20. If
    // this geometry is uniform, `calculate_new_z` (via its two pure cores)
    // should climb by the SAME +4 delta every tile.
    let tiles: Vec<PathObj> = (0..5).map(|i| bridge_tile(4 * i, 8)).collect();

    // Start already standing on tile 0 (avg 4), then climb through 1..4.
    let mut z = tiles[0].avg_z; // 4
    let mut seq = vec![z];
    for i in 1..tiles.len() {
        let (min_z, max_z) = bound_min_max_z(&[tiles[i - 1]], z, 0);
        z = resolve_standing_z(vec![tiles[i]], min_z, max_z, z).expect("climbs the next riser");
        seq.push(z);
    }
    assert_eq!(
        seq,
        vec![4, 8, 12, 16, 20],
        "uniform risers climb by an even +4 delta each tile"
    );

    // Descend back down through 3..0 — must mirror the climb exactly.
    let mut z = tiles[4].avg_z; // 20
    let mut seq = vec![z];
    for i in (0..4).rev() {
        let (min_z, max_z) = bound_min_max_z(&[tiles[i + 1]], z, 0);
        z = resolve_standing_z(vec![tiles[i]], min_z, max_z, z)
            .expect("descends the next riser down");
        seq.push(z);
    }
    assert_eq!(
        seq,
        vec![20, 16, 12, 8, 4],
        "descent mirrors the climb exactly"
    );
}

// Real-data regression for the Britain West Bank staircase (facet 0, x=1495,
// y=1625..1629) — the tiles a live ANIMA_DEBUG capture flagged as "janky":
// climbing north the resolved Z went 10 -> 12 -> 17 -> 20 (deltas +2, +5,
// +3), and the first stair static's *top* surface (z+height) is 15 while the
// resolved standing Z is only 12 — 3 below it. That looked like a bug (stand
// ON the stair, not 3 below), so this test hand-derives what
// `calculate_new_z` + the REAL tile data (dumped via `MapData::land`/
// `statics`) should produce, to check whether 10,12,17,20 is actually right.
//
// Dumped real data (facet 0):
//   (1495,1627) land g=0x03eb z=10 flags=0            — flat, walkable
//     static g=0x0739 z=10 h=5  flags surf+bridge      (avg = z + h/2 = 12)
//   (1495,1626) land g=0x03ec z=10 flags=0
//     static g=0x0738 z=10 h=10 flags surf+bridge      (avg = 10 + 5 = 15)
//     static g=0x0739 z=15 h=5  flags surf+bridge      (avg = 15 + 2 = 17)
//   (1495,1625) land g=0x0401 z=10 flags=0
//     static g=0x04ab z=20 h=0  flags surf (not bridge) (avg = z + h = 20)
//     static g=0x04ba z=40 h=0  flags surf              (avg = 40)
//     static g=0x013a z=40 h=20 impassable only          (a wall, not standable)
//     (+ other impassable-only wall statics — none are candidate surfaces)
//   (1495,1628) land g=0x0401 z=10 flags=0, no statics  — flat, walkable
//   (1495,1629) land g=0x03ec z=10 flags=0, no statics  — flat, walkable (start)
//
// `Bridge` (stair) tiles stand at HALF height (ClassicUO
// `staticAverageZ /= 2` in `CreateItemList`; ServUO `ItemData.CalcHeight`
// does the identical halving) — by design, NOT the tile's raw top surface.
// Hand-running `calculate_new_z` (`CalculateMinMaxZ` bounds the step by the
// tile left behind, then the candidate nearest current Z with BLOCK_HEIGHT
// clearance wins):
//   1629(z10) -> 1628: flat both sides -> 10 (unchanged, trivial)
//   1628(z10) -> 1627: bound from 1628 (flat) gives min=10,max=12; land(10)
//     and static 0x0739(avg12) are candidates under the z=128 sky sentinel;
//     nearest to current_z=10 with clearance is avg=12 -> **12**
//   1627(z12) -> 1626: bound from 1627 (bridge avg12==current_z -> max
//     bumped to z+height=15) gives min=12,max=17; candidates land(10),
//     0x0738(avg15), 0x0739(avg17); nearest to 12 with clearance is 0x0739
//     avg=17 (0x0738's avg 15 fails the `tavg >= cur_z` ordering test) ->
//     **17**
//   1626(z17) -> 1625: bound from 1626 (bridge avg17==current_z -> max
//     bumped to z+height=20) gives min=15,max=22; only 0x04ab (avg20) has
//     clearance and fits within max=22 -> **20**
// So the captured sequence 10,12,17,20 IS the correct output of the ported
// algorithm on the real data — not a bug. The "3 below the top" the capture
// flagged is the Bridge half-height rule working as intended (see
// `calculate_new_z`'s doc); the real jank is client-side easing (fixed in
// `web/main.js`: see `RZ_CATCHUP`), not this Z resolution.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn britain_bank_stair_z_sequence_matches_captured_climb() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    let world = anima_core::World::new();
    const X: i64 = 1495;
    const NORTH: u8 = 0;
    const SOUTH: u8 = 4;

    // Climb north (y decreasing): 1629 -> 1628 -> 1627 -> 1626 -> 1625.
    let mut z = 10i32;
    let mut seq = vec![z];
    for y in [1628i64, 1627, 1626, 1625] {
        z = calculate_new_z(&world, &mut map, None, X, y, z, NORTH).expect("stair climbs north");
        seq.push(z);
    }
    assert_eq!(
        seq,
        vec![10, 10, 12, 17, 20],
        "climbing-north Z sequence (trivial 10->10 step included)"
    );

    // Descend south (y increasing), mirroring the climb exactly.
    let mut z = 20i32;
    let mut seq = vec![z];
    for y in [1626i64, 1627, 1628, 1629] {
        z = calculate_new_z(&world, &mut map, None, X, y, z, SOUTH).expect("stair descends south");
        seq.push(z);
    }
    assert_eq!(
        seq,
        vec![20, 17, 12, 10, 10],
        "descending-south Z sequence (trivial 10->10 step included)"
    );
}

/// Root-cause regression for the live `walkto (1621,1588) rejected: no
/// path from (1620,1595,5)` bug: (1621,1588) sits behind a real, closed
/// "wooden door" (graphic 0x06A5/0x06A7, tiledata Door+Impassable) at
/// (1611,1591)/(1612,1591) — a genuine ServUO gate a live probe walked up
/// to (confirmed live: opening it with `use:<serial>` made the very same
/// `walkto` succeed). The strict check must still deny it (a closed door
/// really does block a live step); the planning check must not (so click-
/// to-walk can route through, and the executor can open it) — and
/// `door_blocking_at` must find its serial so the executor knows to.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn closed_door_blocks_strictly_but_not_for_planning() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    assert!(
        map.item_is_door(0x06A5),
        "0x06A5 should be a real door graphic"
    );

    let mut world = anima_core::World::new();
    let door_serial = 1_073_751_127;
    world.items.insert(
        door_serial,
        anima_core::world::Item {
            serial: door_serial,
            graphic: 0x06A5,
            amount: 1,
            pos: anima_core::types::Position {
                x: 1611,
                y: 1591,
                z: 0,
            },
            container: None,
            layer: 0,
            hue: 0,
            name: String::new(),
            direction: 0,
            is_multi: false,
            ..Default::default()
        },
    );

    // Strict (manual-walk / minimap) check: the closed door really blocks.
    match explain_tile_walkable(&world, &mut map, None, 1611, 1591, 5) {
        Err(StepDeny::DynamicItem { graphic, .. }) => assert_eq!(graphic, 0x06A5),
        other => panic!("expected a closed-door deny, got {other:?}"),
    }
    assert!(!tile_walkable(&world, &mut map, None, 1611, 1591, 5));

    // Planning check: the same closed door does not block.
    assert!(
        tile_walkable_for_planning(&world, &mut map, None, 1611, 1591, 5).is_some(),
        "click-to-walk planning must route through a closed (openable) door"
    );

    // The executor can find the door to open.
    assert_eq!(
        door_blocking_at(&world, &map, 1611, 1591, 5),
        Some(door_serial)
    );
    assert_eq!(
        door_blocking_at(&world, &map, 1611, 1591 /* unrelated tile */ + 1, 5),
        None
    );
}

/// FIX 4 regression: a door AND a non-door blocker (e.g. a crate someone
/// dropped in the doorway) sitting on the SAME tile must still deny
/// planning. Before this fix, the door-recovery branch fired the moment
/// `explain_tile_walkable`'s `.find()` reported ANY door on the tile,
/// then recomputed with the STATIC-only `walkable_z` — silently ignoring
/// every OTHER dynamic item there too. Since `World::items` is a
/// `HashMap`, which blocker `.find()` hits first is iteration-order
/// dependent, not a real answer — this asserts under two different
/// serial-number arrangements for the pair (a `HashMap`'s iteration
/// order is a function of its keys, not insertion sequence) so the
/// fixed "every blocker must be a door" check can't quietly regress back
/// to a `.find()`-shaped bug that just happens to pass for one layout.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn tile_walkable_for_planning_denies_a_door_tile_with_a_non_door_blocker_too() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    assert!(
        map.item_is_door(0x06A5),
        "0x06A5 should be a real door graphic"
    );
    assert!(
        !map.item_is_door(0x0E3D),
        "0x0E3D (crate) should not be a door"
    );
    assert!(
        map.item_blocks(0x0E3D, 5, 5),
        "0x0E3D (crate) should be an impassable blocker at these Zs"
    );

    for (door_serial, crate_serial) in [(1u32, 2u32), (2u32, 1u32)] {
        let mut world = anima_core::World::new();
        world.items.insert(
            door_serial,
            anima_core::world::Item {
                serial: door_serial,
                graphic: 0x06A5,
                amount: 1,
                pos: anima_core::types::Position {
                    x: 1611,
                    y: 1591,
                    z: 0,
                },
                container: None,
                layer: 0,
                hue: 0,
                name: String::new(),
                direction: 0,
                is_multi: false,
                ..Default::default()
            },
        );
        world.items.insert(
            crate_serial,
            anima_core::world::Item {
                serial: crate_serial,
                graphic: 0x0E3D,
                amount: 1,
                pos: anima_core::types::Position {
                    x: 1611,
                    y: 1591,
                    z: 5,
                },
                container: None,
                layer: 0,
                hue: 0,
                name: String::new(),
                direction: 0,
                is_multi: false,
                ..Default::default()
            },
        );
        assert!(
            tile_walkable_for_planning(&world, &mut map, None, 1611, 1591, 5).is_none(),
            "a crate blocking the same tile as an openable door must still deny planning \
             (door_serial={door_serial}, crate_serial={crate_serial})"
        );
    }
}

/// The `dr` land-tile field's source of truth: `explain_tile_walkable_for_planning`
/// must name a door's serial exactly when the tile is walkable-for-planning ONLY
/// because of that door — never when the tile is either strictly walkable outright
/// (no door involved) or, per the FIX 4 rule, blocked by something a door can't
/// excuse (e.g. a crate sharing the doorway). Exercises the fn directly rather than
/// `build_scene`'s JSON output, since assembling a full `Session`/scene just to read
/// one optional field would be needless overhead — and this is the exact function
/// `build_scene`'s `dr` suffix calls.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn explain_tile_walkable_for_planning_names_the_door_only_when_it_alone_blocks() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    assert!(
        map.item_is_door(0x06A5),
        "0x06A5 should be a real door graphic"
    );
    assert!(
        !map.item_is_door(0x0E3D),
        "0x0E3D (crate) should not be a door"
    );

    let door_serial = 1_073_751_127;
    let mut world = anima_core::World::new();
    world.items.insert(
        door_serial,
        anima_core::world::Item {
            serial: door_serial,
            graphic: 0x06A5,
            amount: 1,
            pos: anima_core::types::Position {
                x: 1611,
                y: 1591,
                z: 0,
            },
            container: None,
            layer: 0,
            hue: 0,
            name: String::new(),
            direction: 0,
            is_multi: false,
            ..Default::default()
        },
    );

    // A tile with ONLY a closed door: walkable-for-planning, and the door's
    // own serial comes back with it.
    let (z, door) = explain_tile_walkable_for_planning(&world, &mut map, None, 1611, 1591, 5);
    assert!(
        z.is_some(),
        "a door-only tile must be walkable for planning"
    );
    assert_eq!(
        door,
        Some(door_serial),
        "must name the door blocking this tile"
    );

    // The SAME tile, plus a non-door impassable crate: no longer plannable at
    // all (FIX 4 — every blocker must be a door, not just one of them), so no
    // door serial either.
    let crate_serial = 2u32;
    world.items.insert(
        crate_serial,
        anima_core::world::Item {
            serial: crate_serial,
            graphic: 0x0E3D,
            amount: 1,
            pos: anima_core::types::Position {
                x: 1611,
                y: 1591,
                z: 5,
            },
            container: None,
            layer: 0,
            hue: 0,
            name: String::new(),
            direction: 0,
            is_multi: false,
            ..Default::default()
        },
    );
    let (z, door) = explain_tile_walkable_for_planning(&world, &mut map, None, 1611, 1591, 5);
    assert!(
        z.is_none(),
        "a crate alongside the door must still deny planning"
    );
    assert_eq!(
        door, None,
        "no door serial when the tile isn't even plannable"
    );

    // An ordinary walkable tile with no items at all: walkable outright, and
    // (since no door was ever involved) no door serial.
    let empty_world = anima_core::World::new();
    let (z, door) = explain_tile_walkable_for_planning(&empty_world, &mut map, None, 1611, 1591, 5);
    assert!(
        z.is_some(),
        "an ordinary tile with no items must be walkable"
    );
    assert_eq!(
        door, None,
        "an ordinary walkable tile must not get a door serial"
    );
}

#[test]
fn multi_distance_bonus_matches_classicuo_and_grows_for_design_tiles() {
    // ClassicUO `Item.LoadMulti` inits min/max at 0 and folds every component
    // (`Item.cs:236-254`) before the visibility branch, then
    // `MultiDistanceBonus = max(|minX|, maxX, |minY|, maxY)` (`:305-308`).
    let comps = [
        MultiComponent {
            graphic: 1,
            dx: -4,
            dy: 0,
            dz: 0,
            visible: true,
            server_keeps: true,
            is_origin: true,
        },
        MultiComponent {
            graphic: 2,
            dx: 10,
            dy: -3,
            dz: 0,
            visible: false,
            server_keeps: false,
            is_origin: false,
        },
    ];
    assert_eq!(multi_distance_bonus(&comps, &[]), 10);
    // A custom-house piece 40 tiles off expands the bonus past any stock
    // `multi.mul` footprint — the `near_multis` filter used to use a fixed 32.
    assert_eq!(multi_distance_bonus(&comps, &[(40, 0)]), 40);
}

#[test]
fn multi_origin_in_view_uses_view_plus_bonus() {
    // ClassicUO `HouseManager.IsHouseInRange`: `distance += MultiDistanceBonus`
    // then independent-axis Chebyshev (`HouseManager.cs:75-77`).
    assert!(
        !multi_origin_in_view(50, 0, 0, 0, 18, 31),
        "18+31=49 does not reach origin at 50"
    );
    assert!(
        multi_origin_in_view(50, 0, 0, 0, 18, 32),
        "18+32=50 includes origin at 50"
    );
}

#[test]
fn invisible_origin_is_drawn_when_graphic_exceeds_two() {
    // ClassicUO `AllowedToDraw = MultiGraphic > 2` (`Item.cs:358`).
    assert!(!multi_component_never_draw(false, true, 3));
    assert!(multi_component_never_draw(false, true, 2));
    assert!(multi_component_never_draw(false, true, 0));
    assert!(
        !multi_component_never_draw(true, true, 1),
        "a visible origin is a Multi, drawn regardless of graphic <= 2"
    );
    assert!(
        multi_component_never_draw(false, false, 0x58A5),
        "a non-origin invisible component stays a path-only nd record"
    );
}

// ---- FIX 1/2/6/7: multi-component walkability + rendering -----------------

fn synth_item(
    serial: u32,
    graphic: u16,
    x: u16,
    y: u16,
    z: i8,
    is_multi: bool,
) -> anima_core::world::Item {
    anima_core::world::Item {
        serial,
        graphic,
        amount: 1,
        pos: anima_core::types::Position { x, y, z },
        container: None,
        layer: 0,
        hue: 0,
        name: String::new(),
        direction: 0,
        is_multi,
        ..Default::default()
    }
}

/// FIX 7 (pure, no map/file data needed): [`multi_components_at`] must
/// force-include an invisible index-0 (`is_origin`) component — matching
/// ServUO's own collision grid (`Server/MultiData.cs::MultiComponentList`:
/// `if (i == 0 || allTiles[i].m_Flags != 0)`) — while still dropping any
/// OTHER invisible component, and never returning a component from a
/// different tile or a different (non-multi) `World::items` entry.
#[test]
fn multi_components_at_includes_invisible_origin_but_not_invisible_others() {
    let mut world = anima_core::World::new();
    world
        .items
        .insert(1, synth_item(1, 42, 1000, 1000, -15, true)); // graphic 42 = multi id
    world
        .items
        .insert(2, synth_item(2, 0x0BB8, 1000, 1000, 0, false)); // an ordinary item, ignored

    let multis = Multis::from_components(std::collections::HashMap::from([(
        42,
        vec![
            MultiComponent {
                graphic: 0x1000,
                dx: 0,
                dy: 0,
                dz: 0,
                visible: false,
                server_keeps: false,
                is_origin: true,
            },
            MultiComponent {
                graphic: 0x1001,
                dx: 0,
                dy: 0,
                dz: 4,
                visible: false,
                server_keeps: false,
                is_origin: false,
            },
            MultiComponent {
                graphic: 0x1002,
                dx: 0,
                dy: 0,
                dz: 8,
                visible: true,
                server_keeps: true,
                is_origin: false,
            },
            MultiComponent {
                graphic: 0x2000,
                dx: 1,
                dy: 0,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: false,
            },
        ],
    )]));

    let here = multi_components_at(&world, &multis, 1000, 1000);
    assert_eq!(
        here.len(),
        2,
        "invisible origin + visible component only: {here:?}"
    );
    assert!(
        here.contains(&(0x1000, -15)),
        "invisible index-0 origin must still count for walkability"
    );
    assert!(here.contains(&(0x1002, -7)), "visible component must count");
    assert!(
        !here.iter().any(|&(g, _)| g == 0x1001),
        "invisible NON-origin component must be excluded"
    );

    assert_eq!(
        multi_components_at(&world, &multis, 1001, 1000),
        vec![(0x2000, -15)]
    );
    assert!(
        multi_components_at(&world, &multis, 50_000, 50_000).is_empty(),
        "way outside any multi's footprint must return nothing"
    );
}

#[test]
fn placement_json_none_when_nothing_pending() {
    let world = anima_core::World::new();
    let multis = Multis::from_components(std::collections::HashMap::new());
    assert!(placement_json(&world, Some(&multis)).is_none());
}

#[test]
fn placement_json_none_without_multis_even_if_pending() {
    let mut world = anima_core::World::new();
    world.pending_target = Some(TargetCursor {
        target_type: 1,
        cursor_id: 1,
        cursor_flag: 0,
    });
    world.pending_multi_placement = Some(MultiPlacement {
        multi_id: 0x64,
        x_off: 0,
        y_off: 0,
        z_off: 0,
        hue: 0,
    });
    assert!(
        placement_json(&world, None).is_none(),
        "no Multis loaded -> omit rather than error"
    );
}

#[test]
fn placement_json_none_for_unknown_multi_id() {
    let mut world = anima_core::World::new();
    world.pending_target = Some(TargetCursor {
        target_type: 1,
        cursor_id: 1,
        cursor_flag: 0,
    });
    world.pending_multi_placement = Some(MultiPlacement {
        multi_id: 0xFFFF, // no entry in `multis` below
        x_off: 0,
        y_off: 0,
        z_off: 0,
        hue: 0,
    });
    let multis = Multis::from_components(std::collections::HashMap::new());
    assert!(placement_json(&world, Some(&multis)).is_none());
}

/// A stale `pending_multi_placement` (the browser task's real bug target)
/// must not render once the target cursor it belonged to is gone —
/// `respond_target`/`cancel_target` (`lib.rs`, outside this crate's game
/// packet handlers) clear `pending_target` the instant the reply is sent
/// but can't also reach `pending_multi_placement`, so `placement_json`
/// gates on BOTH (see its doc).
#[test]
fn placement_json_none_once_target_answered_or_cancelled() {
    let mut world = anima_core::World::new();
    world.pending_target = None; // already answered/cancelled
    world.pending_multi_placement = Some(MultiPlacement {
        multi_id: 0x64,
        x_off: 0,
        y_off: 0,
        z_off: 0,
        hue: 0,
    });
    let multis = Multis::from_components(std::collections::HashMap::from([(
        0x64,
        vec![MultiComponent {
            graphic: 0x1,
            dx: 0,
            dy: 0,
            dz: 0,
            visible: true,
            server_keeps: true,
            is_origin: true,
        }],
    )]));
    assert!(placement_json(&world, Some(&multis)).is_none());
}

#[test]
fn placement_json_dedupes_footprint_and_carries_offsets_hue() {
    let mut world = anima_core::World::new();
    world.pending_target = Some(TargetCursor {
        target_type: 1,
        cursor_id: 0xBEEF,
        cursor_flag: 0,
    });
    world.pending_multi_placement = Some(MultiPlacement {
        multi_id: 0x64,
        x_off: 3,
        y_off: 4,
        z_off: 1,
        hue: 0x21,
    });
    let multis = Multis::from_components(std::collections::HashMap::from([(
        0x64,
        vec![
            MultiComponent {
                graphic: 0x1,
                dx: 0,
                dy: 0,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: true,
            },
            // A second-floor component stacked on the SAME (dx, dy) as the
            // origin — the outline only needs the tile once.
            MultiComponent {
                graphic: 0x2,
                dx: 0,
                dy: 0,
                dz: 4,
                visible: true,
                server_keeps: true,
                is_origin: false,
            },
            MultiComponent {
                graphic: 0x3,
                dx: 1,
                dy: 0,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: false,
            },
            MultiComponent {
                graphic: 0x4,
                dx: 0,
                dy: 1,
                dz: 0,
                visible: false,
                server_keeps: false,
                is_origin: false,
            },
        ],
    )]));

    let v = placement_json(&world, Some(&multis)).expect("placement pending");
    assert_eq!(v["multiId"], 0x64);
    assert_eq!(v["hue"], 0x21);
    assert_eq!(v["xOff"], 3);
    assert_eq!(v["yOff"], 4);
    assert_eq!(v["zOff"], 1);
    let mut tiles: Vec<(i64, i64)> = v["tiles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| (t[0].as_i64().unwrap(), t[1].as_i64().unwrap()))
        .collect();
    tiles.sort();
    assert_eq!(
        tiles,
        vec![(0, 0), (0, 1), (1, 0)],
        "deduped by (dx, dy): {tiles:?}"
    );
}

/// End-to-end against REAL `SmallOldHouse` (multi id `0x64`, ServUO
/// `Multis/Houses.cs`) component data — confirms `placement_json` resolves
/// a genuine multi (not just the synthetic lists the tests above use) and
/// actually dedupes: the module doc records ~148 raw components for this
/// id, most of them floors/roof stacked over a much smaller set of
/// distinct `(dx, dy)` footprint tiles.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn placement_json_real_house_multi_produces_deduped_footprint() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let multis = Multis::open(&dir).expect("open multi data");

    let mut world = anima_core::World::new();
    world.pending_target = Some(TargetCursor {
        target_type: 1,
        cursor_id: 1,
        cursor_flag: 0,
    });
    world.pending_multi_placement = Some(MultiPlacement {
        multi_id: 0x64,
        x_off: 0,
        y_off: 0,
        z_off: 0,
        hue: 0,
    });

    let v = placement_json(&world, Some(&multis)).expect("SmallOldHouse must resolve");
    let raw_len = multis.components(0x64).expect("id 0x64 must exist").len();
    let tiles = v["tiles"].as_array().unwrap();
    assert!(!tiles.is_empty());
    assert!(
        tiles.len() < raw_len,
        "deduped outline ({}) must be smaller than the raw component list ({raw_len})",
        tiles.len()
    );
    // (0, 0) is always the origin tile — every multi's index-0 component
    // sits at its own origin.
    assert!(
        tiles.iter().any(|t| t[0] == 0 && t[1] == 0),
        "origin tile (0,0) must be part of the footprint: {v}"
    );
    // `parts` carries the real (non-deduped) component list — the browser
    // draws the actual house shape from these, not just the footprint.
    let parts = v["parts"].as_array().unwrap();
    assert!(!parts.is_empty(), "parts must be non-empty: {v}");
    assert!(
        parts.len() >= tiles.len(),
        "raw component list ({}) must be at least as long as the deduped footprint ({})",
        parts.len(),
        tiles.len()
    );
    for p in parts {
        let entry = p.as_array().expect("each part is a 4-element array");
        assert_eq!(entry.len(), 4, "each part is [dx, dy, dz, graphic]: {p}");
    }
}

/// ServUO's pre-built keeps/castles (`Multis/HousePlacementTool.cs` places
/// `0x147C` as the 23x23 3-Story Customizable Keep) exist ONLY in
/// `MultiCollection.uop`, not in `multi.idx`/`multi.mul`. While the reader
/// was MUL-only they resolved no components at all, so this crate's two
/// consumers both silently did nothing: [`placement_json`] bailed at its
/// `multis?.components(...)?` and the placement preview drew nothing, and
/// [`multi_components_at`] returned an empty fold so the structure was
/// walk-through. Both must now see the real component list.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn uop_only_keep_multi_drives_placement_preview_and_walkability() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let multis = Multis::open(&dir).expect("open multi data");
    let mut map = MapData::open(&dir).expect("open map data");

    // Placement preview: a footprint, and the raw parts the browser draws.
    let mut world = anima_core::World::new();
    world.pending_target = Some(TargetCursor {
        target_type: 1,
        cursor_id: 1,
        cursor_flag: 0,
    });
    world.pending_multi_placement = Some(MultiPlacement {
        multi_id: 0x147C,
        x_off: 0,
        y_off: 0,
        z_off: 0,
        hue: 0,
    });
    let v = placement_json(&world, Some(&multis)).expect("keep foundation must resolve");
    let raw = multis.components(0x147C).expect("keep components").len();
    assert_eq!(raw, 622, "keep component count");
    assert_eq!(
        v["parts"].as_array().unwrap().len(),
        raw,
        "the whole component list fits under the parts cap"
    );
    assert!(!v["tiles"].as_array().unwrap().is_empty());
    // 23x23 plot => a 4-story foundation (ServUO `HouseFoundation`), which
    // only resolves now that the id has bounds to fold at all.
    assert_eq!(house_design_max_levels(Some(&multis), 0x147C), 4);

    // Walkability: place the keep over the same verified open-water box the
    // SmallBoat test uses (nothing is walkable there without a multi), and
    // check its components now reach the fold. A wall piece denies where
    // open water alone merely had no surface; a floor piece carries a
    // standing Z. Both are `DynamicItem`/`Ok` answers that only exist
    // because `components_at` finally returns something for this id.
    let (kx, ky, kz): (i64, i64, i32) = (1459, 1767, -15);
    let mut world = anima_core::World::new();
    world.items.insert(
        1,
        synth_item(1, 0x147C, kx as u16, ky as u16, kz as i8, true),
    );
    let flipped = multis
        .components(0x147C)
        .unwrap()
        .iter()
        .filter(|c| c.visible)
        .filter(|c| {
            let (tx, ty) = (kx + c.dx as i64, ky + c.dy as i64);
            tile_walkable(&world, &mut map, None, tx, ty, kz)
                != tile_walkable(&world, &mut map, Some(&multis), tx, ty, kz)
        })
        .count();
    assert!(
        flipped > 100,
        "the keep's components must change walkability on its own footprint, got {flipped}"
    );
}

#[test]
fn placement_json_caps_tile_count() {
    let mut world = anima_core::World::new();
    world.pending_target = Some(TargetCursor {
        target_type: 1,
        cursor_id: 1,
        cursor_flag: 0,
    });
    world.pending_multi_placement = Some(MultiPlacement {
        multi_id: 1,
        x_off: 0,
        y_off: 0,
        z_off: 0,
        hue: 0,
    });
    // 100 * 50 = 5000 distinct (dx, dy) offsets, comfortably over the cap.
    let mut comps = Vec::new();
    for dx in 0..100i16 {
        for dy in 0..50i16 {
            comps.push(MultiComponent {
                graphic: 1,
                dx,
                dy,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: dx == 0 && dy == 0,
            });
        }
    }
    let multis = Multis::from_components(std::collections::HashMap::from([(1, comps)]));
    let v = placement_json(&world, Some(&multis)).unwrap();
    assert_eq!(
        v["tiles"].as_array().unwrap().len(),
        PLACEMENT_TILE_CAP,
        "must cap rather than dump every distinct offset"
    );
}

#[test]
fn house_design_json_none_when_not_customizing() {
    let world = anima_core::World::new();
    assert!(house_design_json(&world, None).is_none());
}

#[test]
fn house_design_json_none_without_a_known_foundation_item() {
    let mut world = anima_core::World::new();
    // The 0xBF/0x20 notice arrived, but the foundation's own item state hasn't (yet).
    world.customizing_house = Some(0x4003_0001);
    assert!(
        house_design_json(&world, None).is_none(),
        "no known world position -> omit rather than guess"
    );
}

#[test]
fn house_design_json_carries_serial_revision_and_world_position() {
    let mut world = anima_core::World::new();
    let serial = 0x4003_0002u32;
    world.customizing_house = Some(serial);
    world.item_mut(serial).graphic = 0x64; // arbitrary multi id, unknown to `multis` below
    world.item_mut(serial).pos = Position {
        x: 100,
        y: 200,
        z: 5,
    };

    // No 0xD8 design details have arrived yet -> revision defaults to 0.
    let v = house_design_json(&world, None).expect("customizing a known foundation");
    assert_eq!(v["serial"], serial);
    assert_eq!(v["revision"], 0);
    assert_eq!(v["floors"], 3, "no multis loaded -> conservative default");
    assert_eq!(v["x"], 100);
    assert_eq!(v["y"], 200);
    assert_eq!(v["z"], 5);

    let design = anima_core::world::HouseDesign {
        revision: 7,
        ..Default::default()
    };
    world.house_designs.insert(serial, design);
    let v = house_design_json(&world, None).unwrap();
    assert_eq!(v["revision"], 7, "once the 0xD8 arrives, its revision wins");
}

#[test]
fn house_design_max_levels_uses_the_14_tile_rule() {
    let mut comps = std::collections::HashMap::new();
    comps.insert(
        1,
        vec![
            MultiComponent {
                graphic: 1,
                dx: -3,
                dy: -3,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: true,
            },
            MultiComponent {
                graphic: 1,
                dx: 3,
                dy: 3,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: false,
            },
        ], // 7x7 footprint -> below the 14-tile threshold
    );
    comps.insert(
        2,
        vec![
            MultiComponent {
                graphic: 1,
                dx: -7,
                dy: -7,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: true,
            },
            MultiComponent {
                graphic: 1,
                dx: 6,
                dy: 6,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: false,
            },
        ], // exactly 14x14 -> at the threshold
    );
    let multis = Multis::from_components(comps);
    assert_eq!(house_design_max_levels(Some(&multis), 1), 3);
    assert_eq!(house_design_max_levels(Some(&multis), 2), 4);
    assert_eq!(
        house_design_max_levels(Some(&multis), 999),
        3,
        "unknown multi id -> conservative default"
    );
    assert_eq!(
        house_design_max_levels(None, 1),
        3,
        "no multis loaded -> conservative default"
    );
}

/// T4: once a custom-house design is decoded (`tiles_ready`), it must
/// REPLACE the foundation's multi.mul components for that multi entirely
/// — never merge with them — matching the identical swap the emission
/// loop in `build_scene` makes (§3c/§3d of the housing plan).
#[test]
fn multi_components_at_design_replaces_multi_mul_components() {
    let mut world = anima_core::World::new();
    world
        .items
        .insert(1, synth_item(1, 42, 1000, 1000, 0, true)); // graphic 42 = multi id

    let multis = Multis::from_components(std::collections::HashMap::from([(
        42,
        vec![MultiComponent {
            graphic: 0x1000,
            dx: 0,
            dy: 0,
            dz: 0,
            visible: true,
            server_keeps: true,
            is_origin: true,
        }],
    )]));

    // No design yet (or not decoded) → the stock multi.mul component wins.
    assert_eq!(
        multi_components_at(&world, &multis, 1000, 1000),
        vec![(0x1000, 0)]
    );

    let mut design = anima_core::world::HouseDesign::default();
    design.tiles.insert((0, 0), vec![(0x4001, 5)]);
    world.house_designs.insert(1, design); // tiles_ready still false — must be ignored
    assert_eq!(
        multi_components_at(&world, &multis, 1000, 1000),
        vec![(0x1000, 0)],
        "a design that isn't tiles_ready yet must not replace anything"
    );

    world.house_designs.get_mut(&1).unwrap().tiles_ready = true;
    assert_eq!(
        multi_components_at(&world, &multis, 1000, 1000),
        vec![(0x4001, 5)],
        "a tiles_ready design must replace the multi.mul component entirely, not merge"
    );
}

/// FIX 1 + FIX 7, end-to-end against REAL SmallBoat multi data (id 0,
/// ServUO `SmallBoat.NorthID`) and a REAL clear-open-water spot: probed
/// directly (see the `anima-assets` `probe_water`-style scan this test's
/// coordinates came from) — every tile in a 7×7 box around (1459,1767) is
/// impassable deep water with zero real statics, so any walkability there
/// comes ONLY from the synthetic boat placed by this test, not dock
/// clutter. Component offsets/flags below were read directly off this
/// boat id's real component list (`Multis::components(0)`):
/// `(dx=0,dy=-2)` is graphic `0x3EAC` (Surface, visible, height 3 — a deck
/// plank); `(dx=-2,dy=-1)` is graphic `0x3EB1` (Impassable, visible — a
/// hull side piece). Both at `dz=0`: every SmallBoat component sits
/// coplanar with the multi's own Z (verified: every one of the 38
/// components for every facing has `dz == 0`).
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn fix1_smallboat_deck_walkable_hull_blocks_using_real_boat_data() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    let multis = Multis::open(&dir).expect("open multi data");

    // Confirm the fixture assumption: a clear 7x7 open-water box, no statics.
    for oy in -3i64..=3 {
        for ox in -3i64..=3 {
            let (tx, ty) = ((1459 + ox) as u32, (1767 + oy) as u32);
            assert!(
                map.land(tx, ty).impassable(),
                "({tx},{ty}) should be deep water"
            );
            assert!(
                map.statics(tx, ty).is_empty(),
                "({tx},{ty}) should have no real statics"
            );
        }
    }

    // A SmallBoat (multi id 0) "placed" at (1459,1767); this shard snaps a
    // placed boat's Z to -15 (see FIX 3's live verification) — the exact
    // value doesn't matter to this check (only that the deck resolves
    // within one climb-step of it), so it's used as-observed.
    let (boat_x, boat_y, boat_z): (i64, i64, i32) = (1459, 1767, -15);
    let mut world = anima_core::World::new();
    world.items.insert(
        1,
        synth_item(1, 0, boat_x as u16, boat_y as u16, boat_z as i8, true),
    );

    // Deck tile: must be walkable, `tile_walkable` (the renderer's `w`
    // flag) and `tile_walkable_for_planning` (the click-to-walk A*
    // terrain adapter) must agree, and the standing Z must be the deck's
    // own top (boat_z + height 3).
    let (deck_x, deck_y) = (boat_x, boat_y - 2);
    assert_eq!(
        explain_tile_walkable(&world, &mut map, Some(&multis), deck_x, deck_y, boat_z),
        Ok(boat_z + 3),
        "the deck component must contribute a standing surface over open water"
    );
    assert!(tile_walkable(
        &world,
        &mut map,
        Some(&multis),
        deck_x,
        deck_y,
        boat_z
    ));
    assert!(
        tile_walkable_for_planning(&world, &mut map, Some(&multis), deck_x, deck_y, boat_z)
            .is_some()
    );
    // Without the boat, the SAME tile is unwalkable open water — proves
    // the deck (not some coincidental real static) is what's carrying it.
    assert!(!tile_walkable(
        &world, &mut map, None, deck_x, deck_y, boat_z
    ));

    // Hull tile: must deny. HONEST finding (this is exactly the FIX 3
    // re-verification the review asked for): the hull piece (0x3EB1) is
    // Impassable-only, contributing NO standing candidate of its own
    // (`score_walkable_z`'s candidate rule is `surface() && !impassable()`)
    // — and this exact (dx,dy) has no OTHER (deck) component sharing it.
    // So the deny reason is `NoSurface` (nothing to stand on at all), NOT
    // `Blocked` (an overlapping impassable object stepping on an
    // otherwise-valid candidate) — `multi_blocker_at`'s DynamicItem path
    // never even fires here, because `walkable_z_explain` already denies
    // first. Either way the OBSERVABLE result is the same: the hull tile
    // is unwalkable, matching what a real player sees at the ship's rail.
    let (hull_x, hull_y) = (boat_x - 2, boat_y - 1);
    match explain_tile_walkable(&world, &mut map, Some(&multis), hull_x, hull_y, boat_z) {
        Err(StepDeny::Terrain(ZReason::NoSurface)) => {}
        other => panic!("expected a NoSurface deny at the hull tile, got {other:?}"),
    }
    assert!(!tile_walkable(
        &world,
        &mut map,
        Some(&multis),
        hull_x,
        hull_y,
        boat_z
    ));
}

/// Real-bug regression (the actual root cause this fix addresses, distinct
/// from FIX 1's boat-as-multi case above): on THIS shard, a boat's deck
/// arrives as an ORDINARY DYNAMIC WORLD ITEM, not as a multi component at
/// all — live-verified graphics 0x3EA1/0x3EAC/0x3EB0 at `z=-5`, tiledata
/// `height` 3, `SURFACE` (not `Impassable`), giving a standing Z of
/// `-5 + 3 = -2`. Before `dynamic_statics_at` existed,
/// `explain_tile_walkable` only ever folded MULTI components into its
/// scoring — an ordinary item was consulted ONLY as a blocker — so this
/// exact tile shape denied every step, with `sz` falling back to the water
/// underneath. Reuses the same known-clear open-water box (no real
/// statics, all impassable deep water) `fix1_smallboat_...` verified above,
/// so the standing surface is provably coming from the synthetic dynamic
/// item, not some coincidental real static.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn dynamic_item_deck_over_water_contributes_a_standing_surface() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    for (tx, ty) in [(1459u32, 1765u32), (1460u32, 1765u32)] {
        assert!(
            map.land(tx, ty).impassable(),
            "({tx},{ty}) should be deep water"
        );
        assert!(
            map.statics(tx, ty).is_empty(),
            "({tx},{ty}) should have no real statics"
        );
    }

    // Deck alone, as a plain (non-multi) dynamic item: must contribute a
    // standing surface exactly like a real static would.
    let mut world = anima_core::World::new();
    world
        .items
        .insert(1, synth_item(1, 0x3EAC, 1459, 1765, -5, false));
    assert_eq!(
        explain_tile_walkable(&world, &mut map, None, 1459, 1765, -5),
        Ok(-2),
        "a dynamic deck item must contribute a standing surface over open water"
    );
    assert!(tile_walkable(&world, &mut map, None, 1459, 1765, -5));

    // Without it, the SAME tile is unwalkable open water.
    world.items.remove(&1);
    assert!(!tile_walkable(&world, &mut map, None, 1459, 1765, -5));

    // Companion check: a hull piece (impassable, no surface) as a plain
    // dynamic item on a DIFFERENT clear-water tile must still fully deny —
    // it must never itself become a standing candidate (see
    // `dynamic_statics_at`'s doc: impassable items are excluded from the
    // surface fold, so this keeps denying through the unchanged
    // `StepDeny::DynamicItem`/blocker path, not by accident).
    world
        .items
        .insert(2, synth_item(2, 0x3EB1, 1460, 1765, -5, false));
    assert!(!tile_walkable(&world, &mut map, None, 1460, 1765, -5));
}

/// FIX 2: a multi's own roof component must lift `max_draw_z`'s ceiling
/// exactly like a real static roof would — the static map alone has no
/// idea a multi is even there, so without this a boat/house roof would
/// never cull and the interior would never show. Uses a real ROOF-flagged
/// graphic (0x0586, `FLAG_ROOF` set, non-surface, height 3 — probed
/// directly off tiledata.mul) so the tiledata half of the check is real,
/// not synthetic.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn max_draw_z_culls_a_multi_roof_component_above_the_player() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    assert_ne!(
        map.item_flags(0x0586) & FLAG_ROOF,
        0,
        "0x0586 should be a real roof graphic"
    );

    // New Haven spawn: outdoors, open sky — baseline with no multi at all.
    let (px, py, pz) = (3503i64, 2574, 0i32);
    let baseline = max_draw_z(&anima_core::World::new(), &mut map, None, px, py, pz);
    assert_eq!(
        baseline.max_z, 127,
        "open field with no roof over the player: draw everything"
    );

    // A synthetic multi whose one component (the real roof graphic) sits
    // directly over the tile the player faces into (px+1, py+1) — the
    // same tile real statics use for `max_draw_z`'s roof-flood check.
    let mut world = anima_core::World::new();
    world.items.insert(
        1,
        synth_item(
            1,
            999,
            (px + 1) as u16,
            (py + 1) as u16,
            (pz + 15) as i8,
            true,
        ),
    );
    let multis = Multis::from_components(std::collections::HashMap::from([(
        999,
        vec![MultiComponent {
            graphic: 0x0586,
            dx: 0,
            dy: 0,
            dz: 0,
            visible: true,
            server_keeps: true,
            is_origin: true,
        }],
    )]));

    let culled = max_draw_z(&world, &mut map, Some(&multis), px, py, pz);
    assert!(
        culled.max_z < 127,
        "the multi's roof component must cull max_draw_z, got {culled:?}"
    );
    assert!(
        culled.no_draw_roofs,
        "a roof over the player must set no_draw_roofs, not just max_z"
    );
}

/// FIX 6 (pure given real tiledata/animdata, no `Session` needed): an
/// animated multi component (mill wheel, pennant) must get the SAME
/// frame-sequence treatment [`anim_suffix`] gives a real static — not
/// freeze on frame 0. Uses a real animated graphic (0x03AE, 3 frames,
/// probed directly off animdata.mul).
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn anim_suffix_emits_frame_sequence_for_a_real_animated_graphic() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let map = MapData::open(&dir).expect("open map data");
    let animdata = AnimData::open(&dir).expect("open animdata");
    assert!(
        map.item_is_animated(0x03AE),
        "0x03AE should be a real animated graphic"
    );

    let suffix = anim_suffix(&map, Some(&animdata), 0x03AE);
    assert!(suffix.contains("\"a\":[942,943,944]"), "suffix={suffix}");
    assert!(suffix.contains("\"ai\":"), "suffix={suffix}");

    // A non-animated graphic (an ordinary wall) emits nothing.
    assert_eq!(anim_suffix(&map, Some(&animdata), 0x0001), "");
    // No animdata table at all → nothing, even for an animated graphic.
    assert_eq!(anim_suffix(&map, None, 0x03AE), "");
}

/// T0.5 (pure given real tiledata/animdata): the dynamic-item loop reads the
/// frame sequence through [`anim_frames`], so a server-spawned campfire
/// (0x0DE3) must resolve the same >1-frame list a static would — that's the
/// whole reason a placed campfire flickers instead of freezing.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn anim_frames_resolves_a_spawnable_animated_item() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let map = MapData::open(&dir).expect("open map data");
    let animdata = AnimData::open(&dir).expect("open animdata");

    let (seq, ai) = anim_frames(&map, Some(&animdata), 0x0DE3).expect("campfire is animated");
    assert!(
        seq.len() > 1,
        "campfire needs a real frame cycle, got {seq:?}"
    );
    assert!((100..=1000).contains(&ai), "interval out of range: {ai}");
    // Same source as the statics path, so the two can never drift apart.
    let suffix = anim_suffix(&map, Some(&animdata), 0x0DE3);
    assert!(suffix.contains(&format!("\"ai\":{ai}")), "suffix={suffix}");

    assert!(anim_frames(&map, Some(&animdata), 0x0001).is_none()); // plain wall
    assert!(anim_frames(&map, None, 0x0DE3).is_none()); // no animdata table
}

/// T0.4: a dyed item's hue must reach the art request, and a
/// `TileFlag.PartialHue` item must reach it with bit 0x8000 set so
/// `anima_assets::apply_hue` recolors only the gray pixels (a full hue on a
/// partial-hue item looks worse than none at all). Pure — no data files.
#[test]
fn item_art_hue_marks_partial_hue_items_and_leaves_undyed_ones_alone() {
    assert_eq!(item_art_hue(0x21, 0), 0x21);
    assert_eq!(item_art_hue(0x21, FLAG_PARTIAL_HUE), 0x8021);
    // Unrelated flags must not set the bit…
    assert_eq!(item_art_hue(0x21, FLAG_STACKABLE | FLAG_FOLIAGE), 0x21);
    // …and an undyed item stays "no hue" whatever tiledata says, or the
    // renderer would request a hue of 0x8000 (= partial hue id 0).
    assert_eq!(item_art_hue(0, FLAG_PARTIAL_HUE), 0);
}

#[test]
fn static_hue_suffix_omits_undyed_and_marks_partial() {
    assert_eq!(static_hue_suffix(0, 0), "");
    assert_eq!(static_hue_suffix(0, FLAG_PARTIAL_HUE), "");
    assert_eq!(static_hue_suffix(0x21, 0), ",\"hue\":33");
    assert_eq!(static_hue_suffix(0x21, FLAG_PARTIAL_HUE), ",\"hue\":32801");
}

/// Real bug regression (see `blocking_item_at`'s doc for the full live
/// diagnosis): a house foundation's stairs put a body on a **bridge**
/// (`0x0751`, height 5, z 0 → half-height stand z=2), and the tile one
/// step further carries the foundation's own **impassable** riser
/// (`0x0063`, z 0..5) topped by the empty plot's own **surface**
/// (`0x31F4`, z 7) — a +5 climb exactly like a bridge is for.
/// `calculate_new_z` resolves this correctly to z=7 (verified below), but
/// checked against a body still down at the pre-step z=2 — exactly what
/// `tile_walkable` always checks against — the SAME riser genuinely
/// overlaps that lower body (`item_blocks`'s span test), which is why
/// `tile_walkable` denies the climb outright (also verified below): the
/// two calculators don't just differ in their surface scoring, the
/// blocker check disagrees too depending on WHICH Z it's asked about.
/// `build_scene`'s fix is to trust `calculate_new_z`'s landing Z and ask
/// `blocking_item_at` about THAT Z, not the pre-step one. Reuses the
/// known-clear open-deep-water box around (1459,1767) (see
/// `fix1_smallboat_...`'s doc) so every candidate below is provably the
/// synthetic multi, not real terrain/statics.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn foundation_stairs_bridge_climb_walkable_via_chain_and_resolved_z_blocker_check() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");

    // Confirm the live-diagnosed tiledata facts this fix leans on.
    assert_eq!(
        map.item_flags(0x0751) & (FLAG_SURFACE | FLAG_BRIDGE),
        FLAG_SURFACE | FLAG_BRIDGE,
        "0x0751 must be a surface+bridge"
    );
    assert_eq!(map.item_height(0x0751), 5);
    assert_eq!(
        map.item_flags(0x0063) & (FLAG_IMPASSABLE | FLAG_SURFACE),
        FLAG_IMPASSABLE,
        "0x0063 must be impassable and NOT itself a surface"
    );
    assert_eq!(map.item_height(0x0063), 5);
    assert_ne!(
        map.item_flags(0x31F4) & FLAG_SURFACE,
        0,
        "0x31F4 must be a surface"
    );

    let (bridge_x, bridge_y) = (1459i64, 1766i64);
    let (plot_x, plot_y) = (bridge_x, bridge_y - 1);
    for (tx, ty) in [(bridge_x, bridge_y), (plot_x, plot_y)] {
        assert!(
            map.land(tx as u32, ty as u32).impassable(),
            "({tx},{ty}) should be deep water"
        );
        assert!(
            map.statics(tx as u32, ty as u32).is_empty(),
            "({tx},{ty}) should have no real statics"
        );
    }

    let mut world = anima_core::World::new();
    world.items.insert(
        1,
        synth_item(1, 0, bridge_x as u16, bridge_y as u16, 0, true), // multi id 0, origin = the bridge tile
    );
    let multis = Multis::from_components(std::collections::HashMap::from([(
        0u32,
        vec![
            MultiComponent {
                graphic: 0x0751,
                dx: 0,
                dy: 0,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: true,
            },
            MultiComponent {
                graphic: 0x0063,
                dx: 0,
                dy: -1,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: false,
            },
            MultiComponent {
                graphic: 0x31F4,
                dx: 0,
                dy: -1,
                dz: 7,
                visible: true,
                server_keeps: true,
                is_origin: false,
            },
        ],
    )]));

    // `sz_chain`'s authoritative half: stepping north from the bridge
    // (stand z=2) resolves the climb to z=7.
    let landing_z = calculate_new_z(
        &world,
        &mut map,
        Some(&multis),
        plot_x,
        plot_y,
        2,
        0, /* north */
    )
    .expect("the bridge-widened climb must resolve a landing Z");
    assert_eq!(landing_z, 7);

    // `blocking_item_at`'s other half, checked against the body's ACTUAL
    // landing height: the riser does NOT block.
    let dyn_items = dynamic_statics_at(&world, &map, plot_x, plot_y);
    assert!(
        blocking_item_at(
            &world,
            &mut map,
            Some(&multis),
            plot_x,
            plot_y,
            landing_z,
            &dyn_items,
            false
        )
        .is_none(),
        "the riser must not block a body actually standing at the resolved landing Z"
    );

    // Combined: this is EXACTLY `build_scene`'s new per-tile `w` derivation.
    let walk = calculate_new_z(&world, &mut map, Some(&multis), plot_x, plot_y, 2, 0).is_some()
        && blocking_item_at(
            &world,
            &mut map,
            Some(&multis),
            plot_x,
            plot_y,
            landing_z,
            &dyn_items,
            false,
        )
        .is_none();
    assert!(
        walk,
        "the foundation's stairs must be walkable onto the plot"
    );

    // The SAME riser, checked against the OLD pre-step Z (2) instead,
    // DOES block — proving why `build_scene` must pass the RESOLVED z,
    // not `pz`, into `blocking_item_at`.
    assert!(
        blocking_item_at(
            &world,
            &mut map,
            Some(&multis),
            plot_x,
            plot_y,
            2,
            &dyn_items,
            false
        )
        .is_some(),
        "checked against the pre-step Z the riser genuinely overlaps the body"
    );

    // And the OLD/unchanged `tile_walkable` (which always checks against
    // the pre-step Z, matching `step_ok`) still disagrees with the chain
    // answer — the exact split `build_scene`'s per-tile `w` now resolves
    // in favor of the chain, inside `CHAIN_RADIUS`.
    assert!(
        !tile_walkable(&world, &mut map, Some(&multis), plot_x, plot_y, 2),
        "tile_walkable's own (unchanged, pre-step-Z) semantics must still deny this climb"
    );
}

/// Companion to the above: with NO surface at all over the impassable
/// riser (the plot's own floor removed), the climb must genuinely stay
/// unwalkable — `calculate_new_z` must return `None` (nothing to land
/// on) — proving the fix isn't "the riser never blocks", it depends on
/// there being a real destination surface to land on.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn foundation_riser_with_no_surface_above_is_genuinely_unwalkable() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");

    let (bridge_x, bridge_y) = (1459i64, 1766i64);
    let (plot_x, plot_y) = (bridge_x, bridge_y - 1);
    for (tx, ty) in [(bridge_x, bridge_y), (plot_x, plot_y)] {
        assert!(
            map.land(tx as u32, ty as u32).impassable(),
            "({tx},{ty}) should be deep water"
        );
        assert!(
            map.statics(tx as u32, ty as u32).is_empty(),
            "({tx},{ty}) should have no real statics"
        );
    }

    let mut world = anima_core::World::new();
    world.items.insert(
        1,
        synth_item(1, 0, bridge_x as u16, bridge_y as u16, 0, true),
    );
    let multis = Multis::from_components(std::collections::HashMap::from([(
        0u32,
        vec![
            MultiComponent {
                graphic: 0x0751,
                dx: 0,
                dy: 0,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: true,
            },
            MultiComponent {
                graphic: 0x0063,
                dx: 0,
                dy: -1,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: false,
            },
            // no floor component this time — nothing to stand on.
        ],
    )]));

    assert_eq!(
        calculate_new_z(&world, &mut map, Some(&multis), plot_x, plot_y, 2, 0),
        None,
        "an impassable riser with nothing to stand on above it must not resolve a landing Z"
    );
    assert!(
        !tile_walkable(&world, &mut map, Some(&multis), plot_x, plot_y, 2),
        "and must still be unwalkable through the ordinary (unchanged) check too"
    );
}

/// Root-cause regression for the SERVER'S OWN movement gate (`can_walk`/
/// `step_ok`, now [`can_step_to`]): before this fix, a real committed step
/// — the browser's keyboard walk, resolved server-side to decide which
/// direction to actually send — used the same pre-step-Z blocker bug
/// `blocking_item_at` was split out to fix for `build_scene`'s `w`, just
/// never applied here. Live-reproduced: a character climbed the ground →
/// stairs (landing on the bridge at z=2) and then could not step onto the
/// foundation, even though `build_scene` already reported that tile
/// `w=1`. Exercises the exact same bridge/riser/plot geometry as
/// `foundation_stairs_bridge_climb_walkable_via_chain_and_resolved_z_blocker_check`
/// above, but through `can_step_to` itself (the real gate), and proves
/// the fix didn't weaken anything a real step must still refuse: a
/// closed door and a genuinely unclimbable wall — both still deny (as
/// `StepDeny::NoLanding`; see the door assertion's own doc for the
/// honest reason they share that variant).
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn can_step_to_allows_the_stairs_climb_and_still_blocks_a_door_and_a_wall() {
    let dir_path = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir_path).expect("open map data");

    // --- 1. the foundation's stairs must now be ALLOWED, landing at z=7,
    // through the REAL gate — not just `calculate_new_z` + `blocking_item_at`
    // called by hand (already proven above).
    let (bridge_x, bridge_y) = (1459i64, 1766i64);
    let (plot_x, plot_y) = (bridge_x, bridge_y - 1);
    let mut climb_world = anima_core::World::new();
    climb_world.items.insert(
        1,
        synth_item(1, 0, bridge_x as u16, bridge_y as u16, 0, true),
    );
    let climb_multis = Multis::from_components(std::collections::HashMap::from([(
        0u32,
        vec![
            MultiComponent {
                graphic: 0x0751,
                dx: 0,
                dy: 0,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: true,
            },
            MultiComponent {
                graphic: 0x0063,
                dx: 0,
                dy: -1,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: false,
            },
            MultiComponent {
                graphic: 0x31F4,
                dx: 0,
                dy: -1,
                dz: 7,
                visible: true,
                server_keeps: true,
                is_origin: false,
            },
        ],
    )]));
    match can_step_to(
        &climb_world,
        &mut map,
        Some(&climb_multis),
        bridge_x,
        bridge_y,
        2,
        0, /* north: bridge -> plot */
    ) {
        Ok(z) => assert_eq!(z, 7, "must resolve the same landing Z calculate_new_z does"),
        other => panic!("expected the foundation stairs climb to be allowed, got {other:?}"),
    }
    // Sanity: (plot_x, plot_y) really is the tile the step above landed on.
    assert_eq!((plot_x, plot_y), (bridge_x, bridge_y - 1));

    // --- 2. a closed door must STILL refuse — same door/geometry as
    // `closed_door_blocks_strictly_but_not_for_planning`, walked through
    // `can_step_to` instead of `explain_tile_walkable` directly.
    //
    // HONEST finding (same spirit as `fix1_smallboat_..._using_real_boat_data`'s
    // hull-tile note above): the deny comes back as `NoLanding`, not
    // `DynamicItem`. ClassicUO's `CreateItemList` (`Pathfinder.cs`) only
    // drops a door's own Impassable flag from Z-scoring when the
    // `SmoothDoors` profile option is on — off by default (a plain `bool`
    // field, so `false` unless a player opts in) — so by default a closed
    // door's tiledata (Impassable, height ~20) poisons `calculate_new_z`'s
    // scoring the same way an actual wall would, and it returns `None`
    // before `blocking_item_at` is ever consulted. This is faithful, not a
    // regression: the OLD (pre-fix) `step_ok` ALSO called
    // `calculate_new_z(..).is_none()` as its very first check, before its
    // own inline blocker logic — so a closed door already denied a real
    // step this exact way before this fix, and still does; this fix only
    // changed how the tile SURFACE is scored and at which Z the blocker
    // rules apply, not this early exit.
    assert!(
        map.item_is_door(0x06A5),
        "0x06A5 should be a real door graphic"
    );
    let mut door_world = anima_core::World::new();
    let door_serial = 1_073_751_127;
    door_world.items.insert(
        door_serial,
        anima_core::world::Item {
            serial: door_serial,
            graphic: 0x06A5,
            amount: 1,
            pos: anima_core::types::Position {
                x: 1611,
                y: 1591,
                z: 0,
            },
            container: None,
            layer: 0,
            hue: 0,
            name: String::new(),
            direction: 0,
            is_multi: false,
            ..Default::default()
        },
    );
    match can_step_to(
        &door_world,
        &mut map,
        None,
        1611,
        1592,
        5,
        0, /* north, into the door */
    ) {
        Err(StepDeny::NoLanding) => {}
        other => panic!("expected the closed door to still deny the step, got {other:?}"),
    }

    // --- 3. a plain (unclimbable) wall must still refuse: the SAME
    // impassable riser as the stairs climb above, but with no surface
    // above it at all this time — nothing for `calculate_new_z` to land
    // on, matching `foundation_riser_with_no_surface_above_is_genuinely_unwalkable`.
    let mut wall_world = anima_core::World::new();
    wall_world.items.insert(
        1,
        synth_item(1, 0, bridge_x as u16, bridge_y as u16, 0, true),
    );
    let wall_multis = Multis::from_components(std::collections::HashMap::from([(
        0u32,
        vec![
            MultiComponent {
                graphic: 0x0751,
                dx: 0,
                dy: 0,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: true,
            },
            MultiComponent {
                graphic: 0x0063,
                dx: 0,
                dy: -1,
                dz: 0,
                visible: true,
                server_keeps: true,
                is_origin: false,
            },
            // no floor component this time — nothing to stand on.
        ],
    )]));
    match can_step_to(
        &wall_world,
        &mut map,
        Some(&wall_multis),
        bridge_x,
        bridge_y,
        2,
        0,
    ) {
        Err(StepDeny::NoLanding) => {}
        other => {
            panic!("expected the unclimbable riser to refuse with NoLanding, got {other:?}")
        }
    }
}

// ---------------------------------------------------------------------------
// Seasonal graphic substitution (scene/season.rs).
//
// The table itself is not re-derived here — it was parsed independently from
// ClassicUO's shipped `Data/Client/seasons.txt` and from the 498 `WriteLine`
// literals of `SeasonManager.CreateDefaultSeasonsFile` that regenerate it, and
// the two reconciled byte-for-byte before the table was written. What these
// tests pin is everything a future edit could get wrong *around* it: which
// direction a row reads, that a substitution is never chased, which seasons are
// identity, and — the one that matters — that a season change cannot move a
// single pathing byte.
// ---------------------------------------------------------------------------

#[test]
fn season_remap_reads_from_to_and_never_chases() {
    // Direction. Rows are `<season>,<kind>,<from>,<to>`; a `to` that appeared as
    // a `from` would mean we had it backwards. 573 grass → 1861 snow is the
    // canonical one, and the winter `from` column contains zero snow tiles.
    assert_eq!(season::land_draw_graphic(3, 573), 1861);
    assert_eq!(season::land_draw_graphic(3, 578), 1866);
    assert_eq!(season::static_draw_graphic(3, 3244), 3389);

    // ONE hop, never a chain. The winter statics bucket holds exactly three
    // rows whose `to` is itself a `from` — 3245, 3246 and 3253 all map to 3379,
    // and 3379 maps on to 6093. A fixed-point loop would walk 3245 → 3379 →
    // 6093 and over-substitute; ClassicUO reads the array once
    // (`arr[g] == 0 ? g : arr[g]`), so 3245 lands on 3379 and stops.
    for g in [3245u16, 3246, 3253] {
        assert_eq!(season::static_draw_graphic(3, g), 3379);
        assert_ne!(season::static_draw_graphic(3, g), 6093);
    }
    assert_eq!(season::static_draw_graphic(3, 3379), 6093);
}

#[test]
fn season_remap_is_identity_where_the_table_is_empty() {
    // Summer IS the art as shipped — it has no rows at all.
    assert_eq!(season::static_draw_graphic(1, 3244), 3244);
    assert_eq!(season::land_draw_graphic(1, 573), 573);
    // Only winter remaps LAND; spring/fall/desolation are statics-only.
    for s in [0u8, 1, 2, 4] {
        assert_eq!(
            season::land_draw_graphic(s, 573),
            573,
            "season {s} moved land"
        );
    }
    // A graphic with no row is returned untouched, and an out-of-range season
    // (a malformed 0xBC) must not panic or substitute.
    assert_eq!(season::static_draw_graphic(3, 0xFFFF), 0xFFFF);
    assert_eq!(season::static_draw_graphic(9, 3244), 3244);
    assert_eq!(season::land_draw_graphic(9, 573), 573);
}

#[test]
fn season_tables_are_sorted_and_free_of_duplicate_keys() {
    // The lookup is a binary search, so an unsorted or duplicated key silently
    // returns the wrong graphic (or none) instead of failing loudly.
    let mut n = 0;
    for (season, get) in [
        (3u8, season::land_draw_graphic as fn(u8, u16) -> u16),
        (0, season::static_draw_graphic as fn(u8, u16) -> u16),
        (2, season::static_draw_graphic as fn(u8, u16) -> u16),
        (3, season::static_draw_graphic as fn(u8, u16) -> u16),
        (4, season::static_draw_graphic as fn(u8, u16) -> u16),
    ] {
        // Sweeping every graphic proves the search finds each row from either
        // side — an out-of-order entry makes `binary_search` miss it.
        n += (0..=u16::MAX).filter(|&g| get(season, g) != g).count();
    }
    assert_eq!(n, 312 + 17 + 27 + 70 + 72, "reachable rows != 498");
}

#[test]
fn foliage_hide_rule_matches_classicuo_scope() {
    // `IsFoliage && !IsMultiMovable && season >= Winter`.
    let leafy = FLAG_FOLIAGE;
    let boat_leafy = FLAG_FOLIAGE | FLAG_MULTI_MOVABLE;
    for s in [0u8, 1, 2] {
        assert!(
            !foliage_hidden(s, leafy),
            "season {s} stripped foliage early"
        );
    }
    assert!(foliage_hidden(3, leafy));
    assert!(foliage_hidden(4, leafy));
    // A movable multi's own greenery survives — a boat must not go bare.
    assert!(!foliage_hidden(3, boat_leafy));
    assert!(!foliage_hidden(4, boat_leafy));
    // Not foliage at all: never hidden.
    assert!(!foliage_hidden(4, FLAG_SURFACE));
}

/// The regression that guards the whole design: a season may repaint the world
/// but must not move one byte of what the client walks on.
///
/// ClassicUO stores the substitution *in* `Graphic` and then indexes tiledata
/// with it everywhere, including in `Pathfinder.CreateItemList` — so it really
/// does pathfind on substituted flags, and 29 of the 312 winter land rows flip
/// IMPASSABLE (27 impassable → passable). ServUO's `MovementImpl` never looks at
/// `Map.Season`. We follow the server. If someone ever "simplifies" this by
/// rebinding the tile struct — `LandTile { graphic: draw_g, ..land }` — `li`
/// follows the graphic and this test fails.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn a_season_change_moves_no_pathing_field() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    // Britain's north field: plain grass and trees, i.e. dense in rows from
    // both the winter land table and the winter statics table.
    const CENTER: (i64, i64, i32) = (1495, 1620, 0);

    let emit = |map: &mut MapData, season: u8| {
        let mut world = anima_core::World::new();
        world.season = season;
        let mut lights = Vec::new();
        let e = emit_tiles(
            &world,
            map,
            None,
            None,
            &mut None,
            CENTER,
            127,
            false,
            &mut lights,
        );
        let parse = |body: &str| -> Vec<Value> {
            serde_json::from_str(&format!("[{}]", body.trim_end_matches(','))).expect("scene json")
        };
        (parse(&e.tiles), parse(&e.statics))
    };
    let (summer_t, summer_s) = emit(&mut map, 1);
    let (winter_t, winter_s) = emit(&mut map, 3);

    // The remap has to actually be doing something here, or the comparison
    // below passes vacuously.
    let remapped_t = winter_t.iter().filter(|t| t.get("dg").is_some()).count();
    let remapped_s = winter_s.iter().filter(|t| t.get("dg").is_some()).count();
    assert!(
        remapped_t > 0,
        "no land remapped at {CENTER:?} — pick a greener tile"
    );
    assert!(remapped_s > 0, "no statics remapped at {CENTER:?}");
    assert!(
        summer_t.iter().all(|t| t.get("dg").is_none()),
        "summer remapped land"
    );

    // Every field that feeds a walk decision, byte for byte.
    const PATH_FIELDS: [&str; 8] = ["w", "z", "g", "sz", "li", "dr", "h", "pf"];
    assert_eq!(
        summer_t.len(),
        winter_t.len(),
        "tile count changed with the season"
    );
    for (a, b) in summer_t.iter().zip(&winter_t) {
        for f in PATH_FIELDS {
            assert_eq!(a.get(f), b.get(f), "land field `{f}` moved: {a} vs {b}");
        }
    }
    // Statics keep their identity too — a season must not add, drop or reorder
    // one, because the browser's `calculate_new_z` walks this exact list.
    assert_eq!(
        summer_s.len(),
        winter_s.len(),
        "static count changed with the season"
    );
    for (a, b) in summer_s.iter().zip(&winter_s) {
        for f in ["x", "y", "z", "g", "h", "pf", "ms"] {
            assert_eq!(a.get(f), b.get(f), "static field `{f}` moved: {a} vs {b}");
        }
    }
}

// ---------------------------------------------------------------------------
// `TileFlag.Translucent` (scene field `tr`).
// ---------------------------------------------------------------------------

#[test]
fn translucent_is_bit_8_and_the_flag_table_matches_classicuo() {
    // The bit itself. This constant lived in `anima-assets` as `WET` — the name
    // was wrong by one nibble and it had no readers, so nothing misbehaved, but
    // an implementer reaching for "the water flag" would have got this one.
    assert_eq!(FLAG_TRANSLUCENT, 0x8);
    assert_ne!(FLAG_TRANSLUCENT, 0x80, "0x80 is Wet, not Translucent");
    assert_eq!(
        FLAG_TRANSLUCENT,
        anima_assets::tiledata::flags::TRANSLUCENT,
        "the assets and scene copies of the bit must agree"
    );

    // While we are here: the rest of the table, against ClassicUO's
    // `TileDataLoader.cs` enum. A wrong bit here is silent and wide-blast.
    for (name, ours, classicuo) in [
        ("Impassable", FLAG_IMPASSABLE, 0x0000_0040_u64),
        ("Surface", FLAG_SURFACE, 0x0000_0200),
        ("Bridge", FLAG_BRIDGE, 0x0000_0400),
        ("Stackable", FLAG_STACKABLE, 0x0000_0800),
        ("Foliage", FLAG_FOLIAGE, 0x0002_0000),
        ("PartialHue", FLAG_PARTIAL_HUE, 0x0004_0000),
        ("Roof", FLAG_ROOF, 0x1000_0000),
        ("MultiMovable", FLAG_MULTI_MOVABLE, 0x100_0000_0000),
    ] {
        assert_eq!(ours, classicuo, "{name} bit disagrees with ClassicUO");
    }
}

/// Emitter coverage: `tr` is present on exactly the statics whose DRAWN graphic
/// carries the bit, and on no others.
///
/// Note what this does NOT prove. At a center where no season row fires,
/// `draw_g == s.graphic`, so a buggy implementation reading `s.flags` satisfies
/// this too — the discrimination lives in the desolation test below. What this
/// one catches is a wrong bit, a missed emit site, and a `tr` that leaks onto
/// something opaque.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn translucent_is_emitted_for_exactly_the_translucent_statics() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    // A blood-soaked clearing on the main continent — 120 translucent statics
    // inside the +/-24 statics window, all `blood`/`blood smear`. Deliberately
    // NOT one of the spiderweb clusters: every dense one of those sits at
    // x > 5120, i.e. in the Lost Lands, which a shard may not have loaded.
    const CENTER: (i64, i64, i32) = (956, 700, 0);

    let world = anima_core::World::new();
    let mut lights = Vec::new();
    let e = emit_tiles(
        &world,
        &mut map,
        None,
        None,
        &mut None,
        CENTER,
        127,
        false,
        &mut lights,
    );
    let statics: Vec<Value> =
        serde_json::from_str(&format!("[{}]", e.statics.trim_end_matches(',')))
            .expect("statics json");
    let tiles: Vec<Value> =
        serde_json::from_str(&format!("[{}]", e.tiles.trim_end_matches(','))).expect("tiles json");

    let mut n_tr = 0;
    for s in &statics {
        let g = s["g"].as_u64().unwrap() as u16;
        let drawn = s.get("dg").and_then(|v| v.as_u64()).unwrap_or(g as u64) as u16;
        let want = map.item_flags(drawn) & FLAG_TRANSLUCENT != 0;
        let got = s.get("tr").is_some();
        assert_eq!(
            got, want,
            "`tr` disagrees with tiledata for graphic {drawn}: {s}"
        );
        n_tr += got as usize;
    }
    assert!(
        n_tr > 100,
        "expected ~120 translucent statics at {CENTER:?}, got {n_tr}"
    );

    // Land is never translucent: 0 of 16384 land graphics carry the bit, and
    // ClassicUO's `case Land land:` never calls `ProcessAlpha` at all
    // (GameSceneDrawingSorting.cs:624). So the land stream must stay clean.
    assert!(
        tiles.iter().all(|t| t.get("tr").is_none()),
        "a land tile grew a `tr` field"
    );
}

/// The fault injection: translucency must follow the DRAWN graphic.
///
/// Desolation remaps mushrooms 3345/3348/3351 → blood 4651, and blood IS
/// translucent while a mushroom is not. So an implementation that reads
/// `s.flags` instead of the seasonal `dflags` draws exactly these opaque in the
/// one season that produces them. There is a real mushroom at the center below,
/// verified against `statics0.mul`.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn translucency_follows_the_seasonal_draw_graphic() {
    // `scene_season` caches ANIMA_SEASON in a process-wide OnceLock, which would
    // collapse both halves of this test onto one season and pass it vacuously.
    assert!(
        std::env::var("ANIMA_SEASON").is_err(),
        "unset ANIMA_SEASON — it pins scene_season process-wide"
    );
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    const CENTER: (i64, i64, i32) = (1532, 1603, 7);
    const MUSHROOM: u64 = 3351;
    const BLOOD: u64 = 4651;

    let at = |map: &mut MapData, season: u8| -> Vec<Value> {
        let mut world = anima_core::World::new();
        world.season = season;
        let mut lights = Vec::new();
        let e = emit_tiles(
            &world,
            map,
            None,
            None,
            &mut None,
            CENTER,
            127,
            false,
            &mut lights,
        );
        let all: Vec<Value> =
            serde_json::from_str(&format!("[{}]", e.statics.trim_end_matches(',')))
                .expect("statics json");
        all.into_iter()
            .filter(|s| s["g"].as_u64() == Some(MUSHROOM))
            .collect()
    };

    let summer = at(&mut map, 1);
    let deso = at(&mut map, 4);
    assert!(!summer.is_empty(), "no mushroom {MUSHROOM} at {CENTER:?}");
    assert_eq!(
        summer.len(),
        deso.len(),
        "the season added or dropped a static"
    );

    for s in &summer {
        assert!(s.get("dg").is_none(), "summer remapped a mushroom: {s}");
        assert!(s.get("tr").is_none(), "a mushroom is not translucent: {s}");
    }
    for s in &deso {
        assert_eq!(
            s["dg"].as_u64(),
            Some(BLOOD),
            "desolation should draw blood: {s}"
        );
        assert!(
            s.get("tr").is_some(),
            "blood IS translucent — this static was classified from the ORIGINAL \
             graphic instead of the drawn one: {s}"
        );
        // …and the pathing graphic is still the mushroom, as always.
        assert_eq!(s["g"].as_u64(), Some(MUSHROOM));
    }
}

// ---------------------------------------------------------------------------
// Ceiling hiding: the pathing-parity golden.
//
// The invariant this row must not break is "which objects carry pathing fields,
// and what those fields say". A golden derived from the NEW emitter could not
// certify that — `filter(new) == filter(new)` is vacuous — so this fixture is
// captured from the emitter as it stood BEFORE ceiling-hidden objects were
// emitted at all, and is checked in. Regenerating it requires an explicit
// `ANIMA_BLESS_GOLDEN=1`, because a silent regeneration turns the row's central
// safety proof back into a tautology.
// ---------------------------------------------------------------------------

/// Centers chosen to fire different halves of the ceiling rule: a Britain house
/// (roof overhead), Blackthorn's castle (the densest under-cover window found),
/// and a Trinsic staircase (an upper-floor slab, not a roof).
const CEILING_CENTERS: [(&str, i64, i64, i32); 3] = [
    ("britain_house", 1585, 1560, 20),
    ("blackthorn", 1522, 1431, 15),
    ("trinsic_stair", 1922, 2689, 0),
];

/// Centers that actually exercise the draw-predicate sites, unlike
/// [`CEILING_CENTERS`] — measured to emit ZERO `nd` records, to reach `multis:
/// None` on every call, and never to touch the 4000 draw budget, which is why
/// the ceiling golden was blind to all six of them.
/// - `nodraw_dense`: Felucca (5575,810), where 327 of 760 path-bearing statics
///   inside `PATH_RADIUS` are tiledata-`nodraw` and were being deleted outright.
/// - `over_budget`: map1 (1499,1455), 7041 statics in the 49x49 window — past
///   `DRAWN_STATIC_CAP`, so the budget itself was dropping path-bearing records.
const DRAW_CENTERS: [(&str, i64, i64, i32); 2] = [
    ("nodraw_dense", 5575, 810, 0),
    ("over_budget", 1499, 1455, 0),
];

fn draw_golden_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/scene/testdata/drawn_set_golden.json")
}

/// The DRAWN multiset: every record the renderer will actually build a sprite
/// for, keyed by identity. This row may add never-drawn records freely, but it
/// must not add, drop or alter a single drawn one — and the ceiling golden
/// cannot see that, because none of its three centers reach any of the sites.
fn drawn_projection(map: &mut MapData, multis: Option<&Multis>, c: (i64, i64, i32)) -> Vec<String> {
    let world = anima_core::World::new();
    let mut lights = Vec::new();
    let ceil = max_draw_z(&world, map, multis, c.0, c.1, c.2);
    let e = emit_tiles(
        &world,
        map,
        multis,
        None,
        &mut None,
        (c.0, c.1, c.2),
        ceil.max_z,
        ceil.no_draw_roofs,
        &mut lights,
    );
    let statics: Vec<Value> =
        serde_json::from_str(&format!("[{}]", e.statics.trim_end_matches(',')))
            .expect("statics json");
    let mut out: Vec<String> = statics
        .iter()
        .filter(|s| s.get("nd").is_none())
        .map(|s| {
            format!(
                "{},{},{},{},{}",
                s["x"],
                s["y"],
                s["z"],
                s["g"],
                s.get("ms").map_or(-1, |v| v.as_i64().unwrap_or(-1))
            )
        })
        .collect();
    out.sort();
    out
}

#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn draw_predicate_row_moves_no_drawn_record() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    let multis = Multis::open(&dir).ok();
    let path = draw_golden_path();

    let mut fresh = serde_json::Map::new();
    for (name, x, y, z) in DRAW_CENTERS {
        let mut m = MapData::open_facet(&dir, if name == "over_budget" { 1 } else { 0 })
            .unwrap_or_else(|_| MapData::open(&dir).expect("open map data"));
        fresh.insert(
            name.to_string(),
            json!(drawn_projection(&mut m, multis.as_ref(), (x, y, z))),
        );
    }
    let _ = &mut map;

    if std::env::var("ANIMA_BLESS_GOLDEN").is_ok() {
        std::fs::write(&path, serde_json::to_string_pretty(&fresh).unwrap()).unwrap();
        eprintln!("blessed {} centers into {}", fresh.len(), path.display());
        return;
    }
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "missing golden {} ({e}) — bless it on a build PREDATING the change",
            path.display()
        )
    });
    let golden: serde_json::Map<String, Value> = serde_json::from_str(&raw).unwrap();
    for (name, _, _, _) in DRAW_CENTERS {
        let want = golden
            .get(name)
            .unwrap_or_else(|| panic!("golden lacks {name}"));
        assert!(
            want.as_array().is_some_and(|a| a.len() > 500),
            "{name}: golden too small to be exercising anything"
        );
        assert_eq!(want, &fresh[name], "{name}: the DRAWN set moved");
    }
}

fn ceiling_golden_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/scene/testdata/ceiling_pathing_golden.json")
}

/// The projection that must be byte-identical across this change: every static
/// that carries a pathing field, with its values. A ceiling-hidden static is
/// allowed to APPEAR in the stream (that is the row's whole point) but must
/// never bring `h`/`pf` with it, so it can never enter this set.
fn ceiling_pathing_projection(map: &mut MapData, c: (i64, i64, i32)) -> Vec<String> {
    let world = anima_core::World::new();
    let mut lights = Vec::new();
    // The REAL ceiling. Passing a literal 127 here would mean `max_z` never
    // fires, nothing is ever ceiling-hidden, and both this golden and its
    // positive control pass vacuously — which is precisely the failure mode the
    // golden exists to rule out.
    let ceil = max_draw_z(&world, map, None, c.0, c.1, c.2);
    let e = emit_tiles(
        &world,
        map,
        None,
        None,
        &mut None,
        (c.0, c.1, c.2),
        ceil.max_z,
        ceil.no_draw_roofs,
        &mut lights,
    );
    let statics: Vec<Value> =
        serde_json::from_str(&format!("[{}]", e.statics.trim_end_matches(',')))
            .expect("statics json");
    // Two projections, guarding two different regressions.
    // `path:` — the pathing fields themselves, which must never move.
    // `draw:` — the set of DRAWN statics, which must not shrink either: hidden
    //           objects share the emit loop, and if they also shared its 4000-entry
    //           budget they would truncate the drawn set and silently restore the
    //           very pop this row removes. (Measured: they did, until they got
    //           their own counter.)
    let mut out: Vec<String> = statics
        .iter()
        .filter(|s| s.get("h").is_some() || s.get("pf").is_some())
        .map(|s| {
            format!(
                "path:{},{},{},{},{},{}",
                s["x"],
                s["y"],
                s["z"],
                s["g"],
                s.get("h").map_or(-1, |v| v.as_i64().unwrap_or(-1)),
                s.get("pf").map_or(-1, |v| v.as_i64().unwrap_or(-1))
            )
        })
        .chain(
            statics
                .iter()
                .filter(|s| s.get("hz").is_none())
                .map(|s| format!("draw:{},{},{},{}", s["x"], s["y"], s["z"], s["g"])),
        )
        .collect();
    out.sort();
    out
}

#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn ceiling_hidden_objects_move_no_pathing_field() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    let path = ceiling_golden_path();

    let mut fresh = serde_json::Map::new();
    for (name, x, y, z) in CEILING_CENTERS {
        fresh.insert(
            name.to_string(),
            json!(ceiling_pathing_projection(&mut map, (x, y, z))),
        );
    }

    if std::env::var("ANIMA_BLESS_GOLDEN").is_ok() {
        std::fs::write(&path, serde_json::to_string_pretty(&fresh).unwrap()).unwrap();
        eprintln!("blessed {} centers into {}", fresh.len(), path.display());
        return;
    }

    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("missing golden {} ({e}) — regenerate with ANIMA_BLESS_GOLDEN=1 on a build that PREDATES the change", path.display())
    });
    let golden: serde_json::Map<String, Value> = serde_json::from_str(&raw).unwrap();
    for (name, _, _, _) in CEILING_CENTERS {
        let want = golden
            .get(name)
            .unwrap_or_else(|| panic!("golden lacks {name}"));
        let got = &fresh[name];
        assert!(
            want.as_array().is_some_and(|a| !a.is_empty()),
            "golden for {name} is empty — it would pass vacuously"
        );
        // SUPERSET, not equality. Ceiling-hidden objects now ship their `h`/`pf`
        // too — they were withheld when this golden was blessed — so the `path:`
        // set legitimately GREW. What must still hold is that nothing which had
        // pathing fields lost them or had them altered: the pre-change projection
        // has to survive entry-for-entry inside the new one. The `draw:` half must
        // still match EXACTLY, because the drawn set is unaffected by any of this
        // and a change there would mean hidden objects had started evicting drawn
        // ones from the emit budget again.
        let got_set: std::collections::HashSet<&str> = got
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        for e in want.as_array().unwrap() {
            let e = e.as_str().unwrap();
            assert!(
                got_set.contains(e),
                "{name}: a pre-change pathing entry vanished or changed: {e}"
            );
        }
        let drawn = |v: &Value| -> Vec<String> {
            v.as_array()
                .unwrap()
                .iter()
                .filter_map(|e| e.as_str())
                .filter(|e| e.starts_with("draw:"))
                .map(String::from)
                .collect()
        };
        assert_eq!(drawn(want), drawn(got), "{name}: the DRAWN set moved");
    }
}

/// Positive control for [`ceiling_hidden_objects_move_no_pathing_field`]: the
/// golden above would pass vacuously if the ceiling rule had simply stopped
/// firing. This asserts the hidden objects are really there, really flagged, and
/// really stripped of everything a faded object must not carry.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn ceiling_hidden_objects_are_emitted_and_inert() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    for (name, x, y, z) in CEILING_CENTERS {
        let world = anima_core::World::new();
        let mut lights = Vec::new();
        let ceil = max_draw_z(&world, &mut map, None, x, y, z);
        let e = emit_tiles(
            &world,
            &mut map,
            None,
            None,
            &mut None,
            (x, y, z),
            ceil.max_z,
            ceil.no_draw_roofs,
            &mut lights,
        );
        assert!(
            ceil.max_z < 127,
            "{name}: max_z is 127 — this center is not under cover"
        );
        let statics: Vec<Value> =
            serde_json::from_str(&format!("[{}]", e.statics.trim_end_matches(',')))
                .expect("statics json");
        let hidden: Vec<&Value> = statics.iter().filter(|s| s.get("hz").is_some()).collect();
        assert!(
            hidden.len() > 50,
            "{name}: only {} ceiling-hidden statics emitted — the rule stopped firing, \
             which would make the pathing golden pass vacuously",
            hidden.len()
        );
        for s in &hidden {
            // Hidden objects DO carry pathing fields now. Withholding them was
            // measured to shift the browser's `calculateNewZ` by up to 20 Z units
            // on tiles the server marks walkable; only DRAW properties are
            // suppressed. The presence assertion is after this loop, because
            // `h`/`pf` are PATH_RADIUS-gated and most hidden statics are outside it.
            // A faded object animates nothing (ClassicUO returns before every
            // render list when AlphaHue == 0), and an invisible animated sprite
            // would keep the browser's on-demand renderer awake forever.
            assert!(
                s.get("a").is_none() && s.get("ai").is_none(),
                "{name}: hidden static kept anim frames: {s}"
            );
        }
        assert!(
            hidden.iter().any(|s| s.get("pf").is_some()),
            "{name}: no ceiling-hidden static carries `pf` — the pathing gate never lifted"
        );
        // …and it must not light the room either. A ceiling-hidden lamp reaching
        // `lights` would both illuminate from a hidden storey and, since LIGHT_CAP
        // is a hard 64 with static lights appended last, evict the nearest real ones.
        for l in &lights {
            let (lx, ly, lz) = (
                l["x"].as_i64().unwrap(),
                l["y"].as_i64().unwrap(),
                l["z"].as_i64().unwrap(),
            );
            assert!(
                !hidden.iter().any(|s| s["x"].as_i64() == Some(lx)
                    && s["y"].as_i64() == Some(ly)
                    && s["z"].as_i64() == Some(lz)),
                "{name}: a ceiling-hidden object at ({lx},{ly},{lz}) is still lighting the scene"
            );
        }
        eprintln!(
            "{name}: {} statics, {} ceiling-hidden, {} lights",
            statics.len(),
            hidden.len(),
            lights.len()
        );
    }
}

/// Positive control for [`draw_predicate_row_moves_no_drawn_record`]: that golden
/// would pass just as happily if the never-drawn records were never emitted at
/// all, which is exactly how the ceiling golden ended up blind to all six of
/// these sites.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn never_drawn_records_carry_pathing_and_nothing_else() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let multis = Multis::open(&dir).ok();
    for (name, x, y, z) in DRAW_CENTERS {
        let mut map = MapData::open_facet(&dir, if name == "over_budget" { 1 } else { 0 })
            .unwrap_or_else(|_| MapData::open(&dir).expect("open map data"));
        let world = anima_core::World::new();
        let mut lights = Vec::new();
        let ceil = max_draw_z(&world, &mut map, multis.as_ref(), x, y, z);
        let e = emit_tiles(
            &world,
            &mut map,
            multis.as_ref(),
            None,
            &mut None,
            (x, y, z),
            ceil.max_z,
            ceil.no_draw_roofs,
            &mut lights,
        );
        let statics: Vec<Value> =
            serde_json::from_str(&format!("[{}]", e.statics.trim_end_matches(',')))
                .expect("statics json");
        let nd: Vec<&Value> = statics.iter().filter(|s| s.get("nd").is_some()).collect();
        assert!(
            nd.len() > 20,
            "{name}: only {} never-drawn records — the golden beside this would be vacuous",
            nd.len()
        );
        for s in &nd {
            // The point of the record: it exists to carry pathing bits.
            assert!(
                s.get("pf").is_some(),
                "{name}: never-drawn record with no `pf`: {s}"
            );
            // …and nothing a sprite would need, so a renderer that ever did try to
            // draw one would produce nothing rather than something wrong.
            for f in ["pz", "f", "tr", "dg", "a", "ai", "hz"] {
                assert!(
                    s.get(f).is_none(),
                    "{name}: never-drawn record carries draw field `{f}`: {s}"
                );
            }
        }
        eprintln!(
            "{name}: {} statics, {} never-drawn",
            statics.len(),
            nd.len()
        );
    }
}

/// The MULTI half of the draw-predicate row, on real boat data.
///
/// This is the site that prompted the row: the emitter gated on `visible` while
/// the authoritative walk path (`walk.rs`'s `multi_components_at`) folds on
/// `server_keeps || is_origin`, so every component that is authoritative but
/// invisible — including a boat's own origin hull — reached the browser with no
/// pathing bits at all. It also guards the FATAL the review caught: the emit
/// gate must be the UNION (`visible || server_keeps || is_origin`), never
/// `server_keeps || is_origin` alone, or a wrong `server_keeps` would delete a
/// visible wall from the screen.
#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn multi_components_reach_the_browser_when_authoritative_but_invisible() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    let multis = Multis::open(&dir).expect("open multi data");

    // The invariant the emit gate must NOT depend on, asserted directly: if
    // `visible` ever implies anything other than "draw me", the union gate keeps
    // working and a `server_keeps`-only gate would start deleting pixels.
    let mut violations = 0usize;
    let mut authoritative_invisible = 0usize;
    for id in 0u32..0x2000 {
        for c in multis.components(id).into_iter().flatten() {
            if c.visible && !c.server_keeps {
                violations += 1;
            }
            if !c.visible && (c.server_keeps || c.is_origin) {
                authoritative_invisible += 1;
            }
        }
    }
    assert!(
        authoritative_invisible > 100,
        "only {authoritative_invisible} authoritative-but-invisible components — \
         this test would be vacuous"
    );
    eprintln!(
        "visible-but-not-kept: {violations}; authoritative-but-invisible: {authoritative_invisible}"
    );

    // Now the emitter itself, over the same open-water fixture the real-boat
    // walkability test uses.
    let (boat_x, boat_y, boat_z): (i64, i64, i32) = (1459, 1767, -15);
    let mut world = anima_core::World::new();
    world.items.insert(
        1,
        synth_item(1, 0, boat_x as u16, boat_y as u16, boat_z as i8, true),
    );
    let mut lights = Vec::new();
    let e = emit_tiles(
        &world,
        &mut map,
        Some(&multis),
        None,
        &mut None,
        (boat_x, boat_y, boat_z),
        127,
        false,
        &mut lights,
    );
    let statics: Vec<Value> =
        serde_json::from_str(&format!("[{}]", e.statics.trim_end_matches(',')))
            .expect("statics json");
    let comps: Vec<&Value> = statics.iter().filter(|s| s.get("ms").is_some()).collect();
    assert!(!comps.is_empty(), "the boat emitted no components at all");

    // Every component the AUTHORITY would hand the walk math must be on the wire
    // with its pathing bits — drawn or not.
    let nd: Vec<&&Value> = comps.iter().filter(|s| s.get("nd").is_some()).collect();
    for s in &nd {
        assert!(
            s.get("pf").is_some(),
            "never-drawn component with no `pf`: {s}"
        );
        assert!(
            s.get("pz").is_none(),
            "never-drawn component carries a draw field: {s}"
        );
    }
    eprintln!(
        "boat: {} components emitted, {} never-drawn",
        comps.len(),
        nd.len()
    );
}

#[test]
fn container_info_resolves_graphic_and_falls_back() {
    // The container info map titles a window from the container ITEM's graphic,
    // which is why a pouch and a backpack (same gump 0x3C) can be told apart.
    let mut w = World::default();
    const BAG: u32 = 0x4000_0001;
    const BANK: u32 = 0x4000_0002;
    w.items.insert(
        BAG,
        anima_core::world::Item {
            serial: BAG,
            graphic: 0x0E75, // backpack
            amount: 1,
            pos: anima_core::types::Position { x: 0, y: 0, z: 0 },
            container: None,
            layer: 21,
            hue: 0,
            name: String::new(),
            direction: 0,
            is_multi: false,
            ..Default::default()
        },
    );
    w.push_container_open(BAG, 0x003C);
    // A bank box opened purely via 0x24, never seen as an item.
    w.push_container_open(BANK, 0x0048);

    let look = Look {
        map: None,
        anim: None,
        animdata: None,
        tileart: None,
    };
    let info = container_info_json(&w, &look);
    assert_eq!(
        info[&BAG.to_string()]["g"].as_u64(),
        Some(0x0E75),
        "backpack graphic resolved"
    );
    // No map in this test → tiledata name is empty, but the graphic is what
    // distinguishes containers; the name is verified against real data below.
    assert_eq!(info[&BAG.to_string()]["name"].as_str(), Some(""));
    // The bank box has no item entry → g=0 fallback, window still draws from its gump.
    assert_eq!(
        info[&BANK.to_string()]["g"].as_u64(),
        Some(0),
        "absent item → g=0 fallback"
    );
}

#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn map_item_name_reads_tiledata() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let map = MapData::open(&dir).expect("open map data");
    assert_eq!(map.item_name(0x0E75), "backpack");
    assert_eq!(map.item_name(0x0E79), "pouch");
    assert_eq!(map.item_name(0x2006), "corpse");
}

#[test]
#[ignore] // needs ~/dev/uo/uo-resource
fn terrain_window_emits_map_around_britain_bank() {
    let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
    let mut map = MapData::open(&dir).expect("open map data");
    let json = build_terrain_window(&mut map, None, None, None, (1495, 1629, 10), 0);
    let v: serde_json::Value = serde_json::from_str(&json).expect("terrain json");
    assert_eq!(v["map"]["cx"], 1495);
    assert_eq!(v["map"]["cy"], 1629);
    assert!(
        v["map"]["tiles"].as_array().map(|a| a.len()).unwrap_or(0) > 100,
        "land window should be the LAND_RADIUS square"
    );
}

/// The `explode` byte has to survive all the way into the scene, and it has to
/// bring the burst's own frame list with it: the browser spawns ClassicUO's
/// follow-up `FixedEffect(0x36CB)` itself (`MovingEffect::RemoveMe`) but has no
/// `animdata.mul` to animate it from. Losing either half reads to a player as a
/// projectile that lands and does nothing.
#[test]
fn an_exploding_effect_carries_the_burst_the_browser_has_to_draw() {
    let mut w = World::default();
    let base = anima_core::world::Effect {
        seq: 0,
        kind: 0, // Moving
        src_serial: 0xAAAA,
        tgt_serial: 0xBBBB,
        graphic: 0x36E4,
        sx: 100,
        sy: 200,
        sz: 5,
        tx: 110,
        ty: 210,
        tz: 5,
        speed: 7,
        duration: 0,
        hue: 0x480,
        blend: 0,
        explodes: true,
    };
    w.push_effect(base);
    w.push_effect(anima_core::world::Effect {
        explodes: false,
        ..base
    });

    let v = effects_json(&w, None);
    let arr = v.as_slice();
    assert_eq!(arr.len(), 2);

    // The exploding one carries the flag and a usable frame list.
    assert_eq!(arr[0]["explodes"], true);
    assert_eq!(
        arr[0]["exFrames"],
        json!([0x36CB]),
        "no animdata → the bare id"
    );
    assert!(arr[0]["exInterval"].is_number());

    // The ordinary one stays silent rather than shipping a false + dead frames
    // to every effect in the feed.
    assert!(arr[1].get("explodes").is_none());
    assert!(arr[1].get("exFrames").is_none());
}
