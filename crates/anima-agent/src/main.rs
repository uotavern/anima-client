//! `anima-agent` — run an autonomous brain on the live server.
//!
//! Usage: `anima-agent [host] [port] [user] [pass] [ticks] [data_dir]`
//! Connects, then each tick: pump the network, observe, let the brain decide,
//! execute the actions, advance any active [`Action::WalkTo`] route. Logs
//! perception + decisions so you can watch it live.

use std::time::Duration;

use anima_agent::{HunterBrain, LlmBrain, WanderBrain};
use anima_assets::{Cliloc, MapData, Speeches};
use anima_core::net::LoginConfig;
use anima_core::{Action, Brain};
use anima_session::{Endpoint, Session};

/// Half-width of the walkability window handed to the brain each tick. A
/// wanderer only ever consults its immediate neighbours, but the window is the
/// brain's whole view of the ground, so keep it wide enough to plan in.
const TERRAIN_RADIUS: u8 = 12;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // `--brain wander|hunter|llm` (or `ANIMA_BRAIN`) picks the contract
    // consumer; remaining args stay host/port/user/pass/ticks/data_dir.
    let mut brain_kind = std::env::var("ANIMA_BRAIN").unwrap_or_else(|_| "wander".into());
    if args.first().map(|s| s.as_str()) == Some("--brain") && args.len() >= 2 {
        args.remove(0);
        brain_kind = args.remove(0);
    }
    let mut a = args.into_iter();
    let host = a.next().unwrap_or_else(|| "127.0.0.1".into());
    let port: u16 = a.next().and_then(|s| s.parse().ok()).unwrap_or(2594);
    let user = a.next().unwrap_or_else(|| "animaagent".into());
    let pass = a.next().unwrap_or_else(|| "animaagent".into());
    let ticks: u32 = a.next().and_then(|s| s.parse().ok()).unwrap_or(40);
    let home = std::env::var("HOME").unwrap_or_default();
    let data_dir = a
        .next()
        .unwrap_or_else(|| format!("{home}/dev/uo/uo-resource"));
    // `MapData` is the pathfinding terrain for `Session::advance_route` (see
    // below) — a brain that never emits `Action::WalkTo` still runs fine
    // without it (`advance_route` is a no-op with no active route); missing
    // game data just means WalkTo silently can't path, like any other missing
    // asset in this codebase.
    let mut map = MapData::open(&data_dir).ok();
    // Without this a brain reads system messages as bare cliloc ids.
    let cliloc = Cliloc::open(&data_dir).ok();
    println!(
        "agent: map data {}",
        if map.is_some() {
            "loaded"
        } else {
            "not loaded (WalkTo actions won't path)"
        }
    );

    let cfg = LoginConfig {
        username: user.clone(),
        password: pass,
        ..Default::default()
    };
    println!("agent: connecting to {host}:{port} as {user} ...");
    let mut s = match Session::connect_and_login(&Endpoint::new(host, port), cfg) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("login failed: {e}");
            std::process::exit(1);
        }
    };
    if let Ok(speech) = Speeches::open(&data_dir) {
        println!("agent: speech.mul loaded ({} keywords)", speech.len());
        s.set_speech(speech);
    }
    let p0 = s.world.player_mobile().cloned().unwrap_or_default();
    println!(
        "agent: in world as {} at ({}, {})",
        p0.name, p0.pos.x, p0.pos.y
    );

    println!("agent: brain {brain_kind}");
    let mut brain: Box<dyn Brain> = match brain_kind.as_str() {
        "hunter" => Box::new(HunterBrain::new()),
        "llm" => {
            let url = std::env::var("ANIMA_LLM_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8088/decide".into());
            println!("agent: LLM POST {url}");
            Box::new(LlmBrain::new(url))
        }
        _ => Box::new(WanderBrain::new()),
    };
    // Settle: pump a moment so the initial perception (status, nearby) lands.
    let _ = s.observe(Duration::from_millis(800));

    for t in 0..ticks {
        // With map data loaded the brain also perceives the ground around it
        // (walls, water, height, doors) instead of discovering obstacles by
        // walking into them — see `Session::observation_with_terrain`.
        let mut obs = match map.as_mut() {
            Some(map) => s.observation_with_terrain(map, TERRAIN_RADIUS),
            None => s.observation(),
        };
        anima_session::localize(&mut obs, cliloc.as_ref());
        let actions = brain.decide(&obs);

        // Log a compact perception + decision line.
        let act_str: Vec<String> = actions
            .iter()
            .map(|a| match a {
                Action::Walk { dir, run } => {
                    format!("walk(d{dir}{})", if *run { ",run" } else { "" })
                }
                Action::WalkTo { x, y } => format!("walkto({x},{y})"),
                Action::Say { text, mode } => format!("{}({text:?})", mode.name()),
                Action::PartySay { text } => format!("party({text:?})"),
                Action::OpenSpellbook { book_type } => format!("openspellbook({book_type})"),
                Action::PickUp { serial, .. } => format!("pickup(0x{serial:08X})"),
                Action::Drop {
                    serial,
                    x,
                    y,
                    z,
                    container,
                } => {
                    format!("drop(0x{serial:08X}→{x},{y},{z}@0x{container:08X})")
                }
                Action::Equip { serial, layer } => format!("equip(0x{serial:08X}@L{layer})"),
                Action::Attack { serial } => format!("attack(0x{serial:08X})"),
                Action::AutoAttack => "autoattack".into(),
                Action::AttackLast => "attacklast".into(),
                Action::Use { serial } => format!("use(0x{serial:08X})"),
                Action::Click { serial } => format!("click(0x{serial:08X})"),
                Action::WarMode { on } => format!("war({on})"),
                Action::CastSpell { spell } => format!("cast({spell})"),
                Action::TargetObject { serial } => format!("target(0x{serial:08X})"),
                Action::TargetGround { x, y, z, graphic } => {
                    format!("targetXY({x},{y},{z},0x{graphic:04X})")
                }
                Action::TargetCancel => "targetcancel".into(),
                Action::BuyItems { vendor, items } => {
                    format!("buy(0x{vendor:08X}×{})", items.len())
                }
                Action::SellItems { vendor, items } => {
                    format!("sell(0x{vendor:08X}×{})", items.len())
                }
                Action::GumpResponse { serial, button, .. } => {
                    format!("gump(0x{serial:08X} btn={button})")
                }
                Action::PopupRequest { serial } => format!("popupreq(0x{serial:08X})"),
                Action::PopupSelect { serial, index } => {
                    format!("popupsel(0x{serial:08X} i={index})")
                }
                Action::LegacyMenuSelect { serial, index } => {
                    format!("menusel(0x{serial:08X} i={index})")
                }
                Action::HuePickerSelect { serial, hue } => {
                    format!("huepick(0x{serial:08X} hue={hue})")
                }
                Action::BookRequest { serial, pages } => {
                    format!("bookreq(0x{serial:08X}×{pages})")
                }
                Action::UseAbility { ability } => format!("ability({ability})"),
                Action::DisarmRequest => "disarm".into(),
                Action::StunRequest => "stun".into(),
                Action::ToggleFlying => "flying".into(),
                Action::BandageTarget { bandage, target } => {
                    format!("bandage(0x{bandage:08X}→0x{target:08X})")
                }
                Action::TargetedSpell { spell, target } => {
                    format!("tspell({spell}→0x{target:08X})")
                }
                Action::TargetedSkill { skill, target } => {
                    format!("tskill({skill}→0x{target:08X})")
                }
                Action::TargetByResource { tool, resource } => {
                    format!("tharvest(0x{tool:08X}/{resource})")
                }
                Action::SkillLock { skill, lock } => format!("skilllock({skill}={lock})"),
                Action::StatLock { stat, lock } => format!("statlock({stat}={lock})"),
                Action::UseSkill { skill } => format!("useskill({skill})"),
                Action::OpenDoor => "opendoor".into(),
                Action::EquipLastWeapon => "lastweapon".into(),
                Action::InvokeVirtue { id } => format!("virtue({id})"),
                Action::EmoteAction { action } => format!("emote({action:?})"),
                Action::CastSpellFromBook { spell, book } => {
                    format!("castbook({spell}@0x{book:08X})")
                }
                Action::AllNames => "allnames".into(),
                Action::ChangeRace { .. } => "racechange".into(),
                Action::ChangeRaceCancel => "racechangecancel".into(),
                Action::OpenUOStore => "uostore".into(),
                Action::OplRequest { serial } => format!("oplreq(0x{serial:08X})"),
                Action::PartyInvite => "partyinvite".into(),
                Action::PartyAccept { leader } => format!("partyaccept(0x{leader:08X})"),
                Action::PartyDecline { leader } => format!("partydecline(0x{leader:08X})"),
                Action::PartyLeave => "partyleave".into(),
                Action::PartyKick { member } => format!("partykick(0x{member:08X})"),
                Action::PartyPrivateMessage { member, text } => {
                    format!("partytell(0x{member:08X} {text:?})")
                }
                Action::PartySetCanLoot { can_loot } => format!("partyloot({can_loot})"),
                Action::StatusRequest { serial } => format!("statusreq(0x{serial:08X})"),
                Action::SkillsRequest => "skillsreq".to_string(),
                Action::NameRequest { serial } => format!("namereq(0x{serial:08X})"),
                Action::ViewRange { range } => format!("viewrange({range})"),
                Action::ObjectHelp { serial } => format!("objhelp(0x{serial:08X})"),
                Action::Language { code } => format!("language({code})"),
                Action::Animate { action } => format!("animate({action})"),
                Action::PublicHouseContent { show } => format!("publichouse({show})"),
                Action::BulletinRequestMessage { message, .. } => {
                    format!("bbmsg(0x{message:08X})")
                }
                Action::BulletinRequestSummary { message, .. } => {
                    format!("bbsum(0x{message:08X})")
                }
                Action::BulletinPost { subject, lines, .. } => {
                    format!("bbpost({subject:?} x{})", lines.len())
                }
                Action::BulletinRemove { message, .. } => format!("bbdel(0x{message:08X})"),
                Action::BoatMove { dir, run } => {
                    format!("boat(d{dir}{})", if *run { ",run" } else { "" })
                }
                Action::BoatStop => "boatstop".into(),
                Action::BookHeaderChange { serial, title, .. } => {
                    format!("bookhdr(0x{serial:08X} {title:?})")
                }
                Action::BookPageWrite {
                    serial,
                    page,
                    lines,
                } => {
                    format!("bookpage(0x{serial:08X} p{page} x{})", lines.len())
                }
                Action::MapToggleEditable { serial } => format!("mapedit(0x{serial:08X})"),
                Action::MapAddPin { serial, x, y } => format!("mappin+(0x{serial:08X} {x},{y})"),
                Action::MapInsertPin { serial, index, .. } => {
                    format!("mappinins(0x{serial:08X} #{index})")
                }
                Action::MapChangePin { serial, index, .. } => {
                    format!("mappinmv(0x{serial:08X} #{index})")
                }
                Action::MapRemovePin { serial, index } => {
                    format!("mappin-(0x{serial:08X} #{index})")
                }
                Action::MapClearPins { serial } => format!("mappinclr(0x{serial:08X})"),
                Action::ChatOpen => "chatopen".into(),
                Action::ChatJoin { channel, .. } => format!("chatjoin({channel:?})"),
                Action::ChatCreate { channel, .. } => format!("chatcreate({channel:?})"),
                Action::ChatLeave => "chatleave".into(),
                Action::ChatSay { text } => format!("chatsay({text:?})"),
                Action::Rename { serial, name } => format!("rename(0x{serial:08X} {name:?})"),
                Action::QuestArrowClick { right_click } => {
                    format!(
                        "questarrow({})",
                        if *right_click { "right" } else { "left" }
                    )
                }
                Action::HelpRequest => "help".into(),
                Action::GuildMenu => "guildmenu".into(),
                Action::QuestMenu => "questmenu".into(),
                Action::PromptResponse { text } => format!("prompt({text:?})"),
                Action::PromptCancel => "promptcancel".into(),
                Action::TipNavigate { seq, next } => {
                    format!("tipnav({seq},{})", if *next { "next" } else { "prev" })
                }
                Action::TipClose { seq } => format!("tipclose({seq})"),
                Action::TextEntryResponse {
                    seq,
                    text,
                    accepted,
                } => format!("textentry({seq},{accepted},{text:?})"),
                Action::TextEntryClose { seq } => format!("textentryclose({seq})"),
                Action::ProfileRequest { serial } => format!("profilereq(0x{serial:08X})"),
                Action::ProfileUpdate { seq, text } => {
                    format!("profileupdate({seq},{text:?})")
                }
                Action::ProfileClose { seq } => format!("profileclose({seq})"),
                Action::Logout => "logout".into(),
                Action::TradeAccept { container, accept } => {
                    format!("tradeaccept(0x{container:08X},{accept})")
                }
                Action::TradeCancel { container } => format!("tradecancel(0x{container:08X})"),
                Action::TradeGold {
                    container,
                    gold,
                    platinum,
                } => {
                    format!("tradegold(0x{container:08X},{gold},{platinum})")
                }
                Action::HouseDesign(cmd) => format!("hdesign({cmd:?})"),
            })
            .collect();
        println!(
            "t{t:02}  pos=({},{})  mobs={} items={}  → {}",
            obs.player.pos.x,
            obs.player.pos.y,
            obs.mobiles.len(),
            obs.items.len(),
            if act_str.is_empty() {
                "(idle)".into()
            } else {
                act_str.join(", ")
            }
        );

        for action in &actions {
            if let Err(e) = s.apply_action(action) {
                eprintln!("agent: action error: {e}");
            }
        }
        if s.observe(Duration::from_millis(450)).is_err() {
            eprintln!("agent: connection closed");
            break;
        }
        // Pump any active `Action::WalkTo` route one step further (paced
        // internally — most ticks this is a no-op). No-op entirely without map
        // data.
        if let Some(m) = map.as_mut() {
            if let Err(e) = s.advance_route(m) {
                eprintln!("agent: route error: {e}");
            }
        }
    }

    let pend = s.world.player_mobile().cloned().unwrap_or_default();
    let dx = pend.pos.x as i32 - p0.pos.x as i32;
    let dy = pend.pos.y as i32 - p0.pos.y as i32;
    println!(
        "agent: done. moved from ({},{}) to ({},{})  (net dx={dx} dy={dy}, confirms={} denies={})",
        p0.pos.x, p0.pos.y, pend.pos.x, pend.pos.y, s.confirms, s.denies
    );
}
