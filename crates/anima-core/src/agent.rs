//! The Observation/Action contract — the stable seam between the world and a
//! brain (AI or a human's input) or a renderer.
//!
//! - [`Observation`] is a read-only snapshot the brain consumes; build it with
//!   [`World::observe`].
//! - [`Action`] is a high-level intent the brain emits; a driver
//!   ([`anima-net`]'s `Session`) turns it into packets.
//!
//! Keeping this schema stable lets scripted / RL / LLM brains and the
//! native/WASM backends all plug into the same interface (see DESIGN.md §3).

use crate::gump_layout::GumpElement;
use crate::path::Terrain;
use crate::types::Position;
use crate::world::{
    is_ghost_body, Book, Buff, CharacterProfile, DragCompletion, Effect, HouseDesign, HuePicker,
    JournalEntry, LegacyMenu, LogoutAck, MapView, MultiPlacement, OpenUrlRequest, Party, PopupMenu,
    PromptState, RaceChangePrompt, ShopBuy, ShopSell, SpellbookContent, TargetCursor,
    TextEntryDialog, TipNotice, TrackedMember, TradeState, Weather, World,
};

/// A skill value, in human units (50.0 == GM-half). Derived from [`crate::world::Skill`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SkillView {
    pub id: u16,
    pub value: f32,
    pub base: f32,
    pub cap: f32,
    pub lock: u8,
}

/// A read-only view of our own character.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlayerView {
    pub serial: u32,
    pub name: String,
    pub pos: Position,
    pub direction: u8,
    pub hits: u16,
    pub hits_max: u16,
    pub mana: u16,
    pub mana_max: u16,
    pub stam: u16,
    pub stam_max: u16,
    pub strength: u16,
    pub dexterity: u16,
    pub intelligence: u16,
    pub gold: u32,
    pub weight: u16,
    /// Carry-weight cap ([`crate::world::PlayerStats::weight_max`]) — the
    /// natural companion to `weight` for "can I still pick this up".
    pub weight_max: u16,
    /// Armor rating (AR), [`crate::world::PlayerStats::armor`].
    pub armor: i16,
    /// Current follower/pet count, [`crate::world::PlayerStats::followers`].
    pub followers: u8,
    /// Maximum follower/pet count, [`crate::world::PlayerStats::followers_max`].
    pub followers_max: u8,
    /// Fire resistance, [`crate::world::PlayerStats::fire_resistance`].
    pub fire_resistance: i16,
    /// Cold resistance, [`crate::world::PlayerStats::cold_resistance`].
    pub cold_resistance: i16,
    /// Poison resistance, [`crate::world::PlayerStats::poison_resistance`].
    pub poison_resistance: i16,
    /// Energy resistance, [`crate::world::PlayerStats::energy_resistance`].
    pub energy_resistance: i16,
    /// Current body graphic. ServUO changes this to a race-specific ghost body
    /// on death, which is more stable than treating a transient zero-HP update
    /// as the complete death contract.
    pub body: u16,
    /// Player health-bar poison flag (0x17 / mobile-update flag 0x04).
    pub poisoned: bool,
    /// True for every ghost body recognized by ServUO `Body.IsGhost`.
    pub dead: bool,
    /// Race from 0x11's ML tail ([`crate::world::PlayerStats::race`]):
    /// 1 human, 2 elf, 3 gargoyle. **0 when the shard never sent one** — every
    /// pre-ML server, which is most of them — in which case the body graphic is
    /// the only clue (0x0190/0x0192 human, 0x025D elf, 0x029A gargoyle, plus
    /// the female id after each). Gates [`Action::ToggleFlying`], which ServUO
    /// answers only for a gargoyle.
    pub race: u8,
    /// The AOS combat tail of 0x11 ([`crate::world::AosStatus`]) — the five
    /// resistance caps and the hit/defence/swing/damage/casting modifiers.
    /// Entirely zero on a shard that does not send `type >= 6`, which is every
    /// pre-ML server. Named apart from [`Observation::aos`], which is the
    /// shard's AOS *feature* flag and a different question.
    pub aos_status: crate::world::AosStatus,
    /// Our own condition, the same flags [`MobileStatus`] carries for others:
    /// a Hiding/Stealth brain needs to know it took, a paralysed one that it
    /// cannot act, and a looter that it has gone grey.
    pub hidden: bool,
    pub paralyzed: bool,
    /// -1 when not poisoned, else 0..=3 Lesser..Deadly.
    pub poison_level: i8,
    /// Our own notoriety byte (1 innocent … 3 grey/criminal … 6 murderer).
    pub notoriety: u8,
    pub hue: u16,
    /// Riding: an item on the mount layer (0x19) is worn — a horse or a boat's
    /// helm ([`Action::BoatMove`] needs it).
    pub mounted: bool,
    /// The rest of 0x11 the core already decodes: luck, weapon damage range,
    /// tithing points (Chivalry spends them), the stat cap, and the three stat
    /// locks [`Action::StatLock`] sets (0 up, 1 down, 2 locked).
    pub luck: u16,
    pub damage_min: i16,
    pub damage_max: i16,
    pub tithing_points: u32,
    pub stats_cap: i16,
    pub str_lock: u8,
    pub dex_lock: u8,
    pub int_lock: u8,
    /// 0 normal; ServUO's `SpeedControl` values above (mounted speed, walk-only…).
    pub speed_mode: u8,
}

/// A nearby creature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MobileView {
    pub serial: u32,
    pub name: String,
    pub pos: Position,
    pub body: u16,
    pub notoriety: u8,
    pub hits: u16,
    pub hits_max: u16,
    /// Chebyshev distance from the player.
    pub distance: u32,
    /// What the shard shows about this mobile's condition — the flags any
    /// client draws on its health bar and body. See [`MobileStatus`].
    pub status: MobileStatus,
}

/// A nearby mobile's visible condition, straight from [`crate::world::Mobile`].
///
/// These are the signals a combat brain reads off an opponent: a green bar
/// (poisoned), a frozen body (paralyzed), a raised weapon (war mode). The core
/// has tracked all of them since the renderer needed them; before schema 32
/// the brain saw only hits. Every flag is re-derived from the server's latest
/// update (not sticky), so `false` means "not shown", never "unknown".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MobileStatus {
    /// Green health bar (0x16/0x17 type 1).
    pub poisoned: bool,
    /// 0..=3 Lesser..Deadly while poisoned, -1 otherwise.
    pub poison_level: i8,
    /// Frozen/paralyzed (mobile-update flag 0x01): ServUO sets it for both
    /// the Paralyze spell and a GM freeze.
    pub paralyzed: bool,
    /// War mode (flag 0x40) — the mobile is in a combat stance.
    pub war_mode: bool,
    /// Hidden (flag 0x80), seen only when we are allowed to perceive it.
    pub hidden: bool,
    /// Yellow/blessed health bar (0x16/0x17 type 2) — invulnerable.
    pub yellow_health: bool,
    /// Last movement update carried the running bit.
    pub running: bool,
    /// Facing, 0..7 (0 = north, clockwise).
    pub direction: u8,
    /// Body hue — a paragon, a coloured dragon, a dyed robe on a player.
    pub hue: u16,
    /// Gargoyle flight.
    pub flying: bool,
    /// A bonded pet that died stays in the world as "dead" (0xBF/0x19).
    pub bonded_dead: bool,
    /// Mana and stamina, when the shard sends them for this mobile at all —
    /// party members and pets. **Party values are normalized** by ServUO's
    /// `AttributeNormalizer` (max 25, current scaled), so read them as a
    /// fraction, never as spendable points. Zero max means "not sent".
    pub mana: u16,
    pub mana_max: u16,
    pub stam: u16,
    pub stam_max: u16,
}

/// A nearby item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemView {
    pub serial: u32,
    /// **Not always an ART graphic.** When [`Self::is_multi`] is set, this is
    /// a *multi id* (an index into `multi.idx`/`multi.mul`, resolved via
    /// `anima_assets::Multis`) — an entirely different id space from ordinary
    /// item ART graphics, and small multi ids collide with real, common ART
    /// ids (e.g. multi id `0x0002` is also a real item graphic). A brain that
    /// filters/matches on `graphic` without checking `is_multi` first will
    /// silently corrupt on a multi in view — always check `is_multi` before
    /// treating this as an ART id.
    pub graphic: u16,
    pub amount: u16,
    pub pos: Position,
    pub container: Option<u32>,
    /// Worn layer (0 if not equipped). 0x15 (21) = backpack.
    pub layer: u8,
    pub distance: u32,
    /// Is this a **multi** (a placed boat or house) rather than a normal,
    /// pickable ground item? See [`crate::world::Item::is_multi`]'s doc — this
    /// mirrors it straight through. `anima-net::scene` expands a multi's
    /// components into the rendered/walkable world; this `ItemView` is its
    /// own single ground-level entry (one per placed multi, not per
    /// component), carrying the multi's own position and id.
    pub is_multi: bool,
    /// What any client shows of the item beyond its art. See [`ItemDetail`].
    pub detail: ItemDetail,
}

/// An item's colour, name and flags, straight from [`crate::world::Item`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ItemDetail {
    /// Ore, ingots, leather, boards and cloth are told apart by hue alone.
    pub hue: u16,
    /// The name the shard sent for it (0x98 / a single-click), if any; the
    /// full property list is [`Observation::opl`].
    pub name: String,
    /// ServUO's 0x20: movable, **or** locked down/secured. A clear bit on a
    /// ground item marks world furniture (a forge, an anvil). `None` inside a
    /// container: the container-content packets carry no flags byte, so the
    /// bit is unknown there, not clear.
    pub movable: Option<bool>,
    /// ServUO's 0x80: not `Visible` (only staff are sent these). `None` inside
    /// a container, as for `movable`.
    pub hidden: Option<bool>,
}

/// A server waypoint (0xE5), with distance derived from the current player
/// position. ServUO kind 1 marks a corpse and kind 6 a resurrection healer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaypointView {
    pub serial: u32,
    pub pos: Position,
    pub map: u8,
    pub kind: u16,
    pub ignore_object: bool,
    pub cliloc: u32,
    pub name: String,
    pub distance: u32,
}

/// A perception snapshot for the brain. Nearby lists are sorted by distance.
#[derive(Debug, Clone, Default)]
pub struct Observation {
    pub player: PlayerView,
    pub mobiles: Vec<MobileView>,
    pub items: Vec<ItemView>,
    /// Journal lines since the last observation (see [`World::observe`]).
    pub new_journal: Vec<JournalEntry>,
    /// Set when the server is waiting for us to pick a target (answer with
    /// [`Action::TargetObject`] / [`Action::TargetGround`]).
    pub pending_target: Option<TargetCursor>,
    /// Our skills, sorted by id (values in human units, e.g. 50.0).
    pub skills: Vec<SkillView>,
    /// Open server gumps/dialogs (0xB0/0xDD) — e.g. a craft menu. Answer with
    /// [`Action::GumpResponse`].
    pub gumps: Vec<GumpView>,
    /// An outstanding 0x9A ASCII or 0xC2 Unicode server text prompt (pet rename,
    /// house sign, guild abbreviation, …), if one is pending. Answer with
    /// [`Action::PromptResponse`]/[`Action::PromptCancel`].
    pub prompt: Option<PromptState>,
    /// Active player-to-player secure trade sessions (0x6F), if any — normally
    /// 0 or 1, but see [`crate::world::TradeState`]'s doc for why concurrent
    /// sessions with different opponents are possible. Items on each side are
    /// the [`ItemView`]s whose `container` matches a session's
    /// `my_container`/`their_container`. Answer with
    /// [`Action::TradeAccept`]/[`Action::TradeCancel`]/[`Action::TradeGold`],
    /// each addressed to a specific session via its `my_container`.
    pub trades: Vec<TradeState>,
    /// The player's active buffs/debuffs (0xDF). See [`Buff`].
    pub buffs: Vec<Buff>,
    /// The open vendor BUY window (0x74), if any. See [`ShopBuy`]. Answer with
    /// [`Action::BuyItems`].
    pub shop_buy: Option<ShopBuy>,
    /// The open vendor SELL window (0x9E), if any. See [`ShopSell`]. Answer
    /// with [`Action::SellItems`].
    pub shop_sell: Option<ShopSell>,
    /// The open context (right-click popup) menu (0xBF/0x14), if any. See
    /// [`PopupMenu`]. Answer with [`Action::PopupSelect`].
    pub popup: Option<PopupMenu>,
    /// Open legacy item/question menus (0x7C), sorted by serial. Answer with
    /// [`Action::LegacyMenuSelect`] using index 0 to cancel or a 1-based choice.
    pub legacy_menus: Vec<LegacyMenu>,
    /// Open server hue pickers (0x95), sorted by serial. These cannot be
    /// canceled; answer with [`Action::HuePickerSelect`] and a dyed hue.
    pub hue_pickers: Vec<HuePicker>,
    /// Pending heritage / race-change dialog (0xBF/0x2A), if any. Answer with
    /// [`Action::ChangeRace`] or dismiss with [`Action::ChangeRaceCancel`].
    pub race_change: Option<RaceChangePrompt>,
    /// Recent validated 0xA5 HTTP(S) URL requests, oldest first. These are
    /// informational events only: no navigation happens in the core, and a UI
    /// must obtain explicit user approval before opening one. Dedupe on `seq`.
    pub open_urls: Vec<OpenUrlRequest>,
    /// Open server 0xA6 Tip/Notice windows in arrival order. Navigate a pageable
    /// tip with [`Action::TipNavigate`], or dismiss either kind with
    /// [`Action::TipClose`].
    pub tips: Vec<TipNotice>,
    /// Open legacy 0xAB modal text-entry dialogs in arrival order. Answer an
    /// exact dialog with [`Action::TextEntryResponse`], or silently dismiss it
    /// with [`Action::TextEntryClose`] only when `can_close` is true.
    pub text_entry_dialogs: Vec<TextEntryDialog>,
    /// Open character-profile windows (0xB8), in gump order. Request one with
    /// [`Action::ProfileRequest`]; editable self profiles can be saved/closed
    /// with [`Action::ProfileUpdate`], while [`Action::ProfileClose`] dismisses
    /// a window without changing its original body.
    pub character_profiles: Vec<CharacterProfile>,
    /// Latest server permission reply to [`Action::Logout`]. Consumers must
    /// correlate its monotonic `seq` with the request they issued.
    pub logout_ack: Option<LogoutAck>,
    /// The currently open book (0x93/0xD4 + 0x66), if any. See [`Book`].
    /// Request more pages with [`Action::BookRequest`].
    pub book: Option<Book>,
    /// The player's party (0xBF/0x06). See [`Party`]. An empty `members` means
    /// we're not in a party. Answer a pending invite with
    /// [`Action::PartyAccept`]/[`Action::PartyDecline`].
    pub party: Party,
    /// An on-screen quest arrow (0xBA) pointing at world tile `(x, y)`, or
    /// `None` when hidden.
    pub quest_arrow: Option<(u16, u16)>,
    /// Server waypoints (0xE5), sorted by distance then serial. 0xE6 removes
    /// entries from subsequent observations.
    pub waypoints: Vec<WaypointView>,
    /// Current weather (0x65). See [`Weather`].
    pub weather: Weather,
    /// Current season (0xBC): 0=Spring, 1=Summer, 2=Fall, 3=Winter, 4=Desolation.
    pub season: u8,
    /// Effective darkness a renderer would use (the overall level, lifted by
    /// any personal light — see [`World::effective_light`]); 0 = brightest day,
    /// ~0x1F darkest night.
    pub light: u8,
    /// Whether the player is in war mode (combat stance). Toggle with
    /// [`Action::WarMode`].
    pub war: bool,
    /// The serial we last sent an Attack (0x05) request for — UO's "last
    /// target" for the auto-attack loop ([`Action::AttackLast`]/
    /// [`Action::AutoAttack`]). `None` until the player attacks.
    pub last_attack: Option<u32>,
    /// The server's authoritative current combat opponent (0xAA
    /// ChangeCombatant), distinct from `last_attack` (which is only the last
    /// serial *we* asked to attack — the server can retarget on its own).
    /// `None` when combat has ended.
    pub combatant: Option<u32>,
    /// Corpse→killed-mobile links (0xAF DisplayDeath), each `(corpse_serial,
    /// killed_mobile_serial)`, sorted by corpse serial. Lets a brain confirm
    /// "this is the corpse of what I killed" before looting.
    pub corpse_of: Vec<(u32, u32)>,
    /// A corpse's worn-item layout (0x89 CorpseEquip), each `(corpse_serial,
    /// [(layer, item_serial), …])`, sorted by corpse serial.
    pub corpse_equip: Vec<(u32, Vec<(u8, u32)>)>,
    /// Current facet/map index (0xBF/0x08 MapChange): 0=Felucca, 1=Trammel,
    /// 2=Ilshenar, 3=Malas, 4=Tokuno, 5=TerMur.
    pub map_index: u8,
    /// The open bulletin board ([`World::bulletin_board`]) — its serial, name
    /// and the summary lines received so far — or `None` when none is open.
    pub bulletin_board: Option<crate::world::BulletinBoard>,
    /// The most recently fetched full message body
    /// ([`World::bulletin_message`]), answering
    /// [`Action::BulletinRequestMessage`].
    pub bulletin_message: Option<crate::world::BulletinMessage>,
    /// The server chat system's state ([`World::chat`]): whether it is
    /// enabled, the channels it has advertised, and `current_channel`.
    /// A brain must send [`Action::ChatOpen`] before any of it becomes live.
    ///
    /// **`current_channel` is "the channel the server last named", not always
    /// "the channel you are in".** The advertisement burst that follows
    /// `ChatOpen` is a series of create-conference commands (0x03E8), and each
    /// one overwrites it — so before any join it holds whichever channel was
    /// advertised last. An actual join (0x03F1) sets it too, so it becomes
    /// truthful the moment [`Action::ChatJoin`] succeeds. ClassicUO's
    /// `ChatManager.CurrentChannelName` behaves identically; this is the
    /// protocol's shape, not a decoding slip. Verified live: after `ChatOpen`
    /// against ServUO it read `Looking For Group` — merely the last of the four
    /// channels advertised.
    pub chat: crate::world::ChatState,
    /// Retained server-chat lines ([`World::chat_messages`]), oldest first.
    /// A **seq-stamped ring, not a delta** — the same treatment
    /// [`Observation::recent_damage`] gets, so a consumer keeps the highest
    /// `seq` it has acted on and ignores the rest. `new_journal` is a delta
    /// instead only because `observe` already threads a journal cursor;
    /// adding a second cursor for this would change the signature every caller
    /// uses to buy nothing.
    pub chat_messages: Vec<crate::world::ChatLine>,
    /// Whether the server advertised the AOS expansion during login
    /// ([`World::aos`]) — gates AOS-only mechanics (e.g. weapon special moves
    /// via [`Action::UseAbility`]).
    pub aos: bool,
    /// The weapon special move armed for the next swing ([`World::armed_ability`]),
    /// or 0 for none. A brain that arms a move must read this to know whether it
    /// is still armed: the server never confirms an arm, only revokes one
    /// (0xBF/0x21), so "I sent it, therefore it holds" is wrong after the first
    /// swing.
    pub armed_ability: u8,
    /// Special moves / toggled spells currently active
    /// ([`World::active_spell_icons`], 0xBF/0x25), sorted. **Spell** ids, the
    /// same space [`Action::CastSpell`] takes — not [`Observation::armed_ability`]'s.
    pub active_spell_icons: Vec<u16>,
    /// Object Property Lists (0xD6 MegaCliloc) answering an [`Action::OplRequest`],
    /// each `(serial, [(cliloc id, args), …])`, sorted by serial. Raw — the core
    /// has no Cliloc table, so a brain wanting display text resolves it itself
    /// (mirrors [`GumpView::layout`]'s cliloc-driven `html` elements). Line 0 is
    /// the name; the rest are magic properties, in the order the server sent them.
    pub opl: Vec<(u32, Vec<(u32, String)>)>,
    /// Recent per-hit damage events (0x0B), each `(seq, serial, amount)`, oldest
    /// first, capped to the most recent few — `serial` took `amount` HP. A combat
    /// brain wants this: other mobiles' HP otherwise only arrives as a coarse
    /// scaled percentage (0x17/0x77's damage bar). Dedupe on `seq` across polls
    /// (like the renderer's scene bridge does) — this always carries the full
    /// capped buffer, not just what's new since the last observation.
    pub recent_damage: Vec<(u64, u32, u16)>,
    /// Known spellbook contents (0xBF/0x1B NewSpellbookContent), each `(book
    /// serial, content)`, sorted by serial — only ever populated for a book
    /// that's actually been opened this session (see
    /// [`crate::world::SpellbookContent`]'s doc). A brain deciding whether it
    /// can cast a given spell checks the owning book's `content` bitmask
    /// against `offset` (both carried in [`SpellbookContent`]) rather than
    /// assuming every spell is known.
    pub spellbooks: Vec<(u32, SpellbookContent)>,
    /// Open treasure/decoration map windows (0x90/0xF5 + 0x56), each `(map
    /// item serial, view)`, sorted by serial. See [`MapView`] — a brain can
    /// read a pin's pixel coords against `bounds`/`width`/`height` to derive
    /// the world tile it marks (the inverse of ServUO's own `MapItem.
    /// ConvertToWorld`: `worldX = bounds.width * pinX / width + bounds.min_x`,
    /// same for Y), e.g. to walk to a decoded treasure map's chest (pin index
    /// 0) without a human reading the parchment.
    pub map_gumps: Vec<(u32, MapView)>,
    /// Local walkability around the player — the one part of perception the
    /// core cannot fill on its own, because it lives in the map files
    /// (`anima-assets`) rather than in any packet. [`World::observe`] always
    /// leaves this `None`; a driver that holds map data fills it with
    /// [`survey_terrain`] (`anima-net`'s `Session::observation_with_terrain`).
    ///
    /// Without it a brain can see mobiles and items but not the ground, so it
    /// cannot tell a wall from open floor, route around water, or notice the
    /// door in its way — it can only hand a destination to the driver's
    /// pathfinder and hope. See [`TerrainView`].
    pub terrain: Option<TerrainView>,
    /// [`Observation::opl`] resolved to words — line 0 the name, the rest the
    /// properties ("Spell Damage Increase 10%"). Filled like the journal's
    /// `display` by a driver holding the Cliloc table (`anima_net::localize`);
    /// empty from the core alone.
    pub opl_text: Vec<(u32, Vec<String>)>,
    /// Out-of-view party and guild members (0xF0 replies), which the driver
    /// already polls for. A member in view is in `mobiles` instead.
    pub party_positions: Vec<TrackedMember>,
    pub guild_positions: Vec<TrackedMember>,
    /// Recent graphical effects (0x70/0xC0/0xC7), a `seq`-stamped ring like
    /// [`Observation::recent_damage`]: a moving effect from `src_serial` to
    /// `tgt_serial` is a spell or arrow in flight, and a fixed one on a caster
    /// is a spell being cast. Dedupe on `seq`.
    pub recent_effects: Vec<Effect>,
    /// Recent animations `(seq, serial, action, frames, forward, delay)` (0x6E)
    /// — who is swinging, casting or bowing nearby. Dedupe on `seq`.
    pub recent_anims: Vec<(u64, u32, u16, u16, bool, u8)>,
    /// Recent typed animations `(seq, serial, kind, action, mode)` (0xE2).
    pub recent_typed_anims: Vec<(u64, u32, u16, u16, u8)>,
    /// Recent sounds `(seq, sound, x, y)` (0x54) — hits, misses and spells out
    /// of sight. Dedupe on `seq`.
    pub recent_sounds: Vec<(u64, u16, u16, u16)>,
    /// Why a lift failed, `(seq, reason)` (0x27): 0 CannotLift, 1 OutOfRange,
    /// 2 OutOfSight, 3 BelongsToAnother, 4 AlreadyHolding, 5 other. ServUO
    /// writes no journal line for it, so this is the only way to know.
    pub recent_lift_rejects: Vec<(u64, u8)>,
    /// Drag completions (0x28 end-drag / 0x29 drop accepted).
    pub recent_drag_completions: Vec<DragCompletion>,
    /// The house or boat the server asks us to place (0x99), alongside the
    /// target cursor it raised; answer with [`Action::TargetGround`].
    pub pending_multi_placement: Option<MultiPlacement>,
    /// Authoritative customization session, set/cleared by 0xBF/0x20.
    pub customizing_house: Option<u32>,
    /// Last server designs, sorted by serial. Raw planes remain available to
    /// headless clients even without foundation asset bounds for tile decoding.
    pub house_designs: Vec<(u32, HouseDesign)>,
}

/// A square window of walkability centred on the player, in world tiles.
///
/// `tiles` is row-major over the `(2 * radius + 1)²` square whose top-left
/// corner is `origin`, so tile `(x, y)` is at index
/// `(y - origin.1) * side + (x - origin.0)` — use [`TerrainView::at`] rather
/// than doing that by hand. Tiles clipped by the map edge are present but
/// unwalkable, which keeps the grid rectangular for a consumer that wants to
/// reshape it into a matrix.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TerrainView {
    /// World tile of the top-left corner (the player minus `radius` on both
    /// axes, clamped at the map origin).
    pub origin: (u16, u16),
    /// Half-width. The window is `2 * radius + 1` tiles on a side.
    pub radius: u8,
    /// Row-major walkability, `side * side` entries.
    pub tiles: Vec<TerrainTile>,
}

impl TerrainView {
    /// Side length of the square: `2 * radius + 1`.
    pub fn side(&self) -> u16 {
        u16::from(self.radius) * 2 + 1
    }

    /// The tile at world coordinates `(x, y)`, or `None` outside the window.
    pub fn at(&self, x: u16, y: u16) -> Option<TerrainTile> {
        let (ox, oy) = self.origin;
        let (dx, dy) = (x.checked_sub(ox)?, y.checked_sub(oy)?);
        let side = self.side();
        if dx >= side || dy >= side {
            return None;
        }
        self.tiles
            .get(usize::from(dy) * usize::from(side) + usize::from(dx))
            .copied()
    }
}

/// One tile of a [`TerrainView`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TerrainTile {
    /// Whether the player could stand here — including tiles reachable only by
    /// opening a `door` first, which is what makes a door distinguishable from
    /// a wall at all (route *planning* treats a closed door as passable; see
    /// [`crate::path::Terrain::door_at`]).
    pub walkable: bool,
    /// The Z the player would stand at. Meaningless when `!walkable`.
    pub z: i8,
    /// Serial of a closed door that has to be opened before this tile can
    /// actually be stepped onto — answer with [`Action::Use`]. `None` on an
    /// ordinary tile, walkable or not.
    pub door: Option<u32>,
}

/// Survey walkability in a square around `center` and return it as a
/// [`TerrainView`].
///
/// Every tile is judged as a step taken **from `from_z`** (the player's current
/// Z), not from its own neighbour, because a window has no single "previous
/// tile". That makes the far edge approximate on sharply sloped ground — a
/// staircase two tiles up reads as unreachable even though walking it one step
/// at a time works. It is exact for the ring the player can actually step onto
/// this tick, which is what a brain needs it for; anything longer-range should
/// go through [`crate::path::find_path`], which does resolve Z per step.
pub fn survey_terrain<T: Terrain>(
    terrain: &mut T,
    center: (u16, u16),
    from_z: i8,
    radius: u8,
) -> TerrainView {
    let side = u32::from(radius) * 2 + 1;
    let origin = (
        center.0.saturating_sub(u16::from(radius)),
        center.1.saturating_sub(u16::from(radius)),
    );
    let mut tiles = Vec::with_capacity((side * side) as usize);
    for dy in 0..side {
        for dx in 0..side {
            let (x, y) = (u32::from(origin.0) + dx, u32::from(origin.1) + dy);
            let z = terrain.walkable_step(x, y, i32::from(from_z));
            tiles.push(TerrainTile {
                walkable: z.is_some(),
                z: z.unwrap_or(0).clamp(i8::MIN as i32, i8::MAX as i32) as i8,
                // Only meaningful where the tile is otherwise passable: a wall
                // has no door to open, and `door_at` is the more expensive of
                // the two queries.
                door: z.and_then(|_| terrain.door_at(x, y, i32::from(from_z))),
            });
        }
    }
    TerrainView {
        origin,
        radius,
        tiles,
    }
}

/// A read-only view of an open server gump/dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GumpView {
    pub serial: u32,
    pub gump_id: u32,
    /// The raw UO gump layout string (`{ button … }{ gumppic … }…`), kept as a
    /// fallback for a brain that wants to parse it itself.
    pub layout: String,
    /// `layout` parsed into typed elements (see [`crate::gump_layout`]) — the
    /// normal way a brain reads a gump instead of re-implementing the grammar.
    /// A cliloc-driven [`GumpElement::Html`] is left unresolved (the core has
    /// no Cliloc table); a driver with one (`anima-net`) resolves it.
    pub elements: Vec<GumpElement>,
}

/// A decision-maker that turns perception into intent. Scripted, RL, or LLM
/// brains all implement this; a driver feeds it [`Observation`]s and executes the
/// [`Action`]s it returns. This is the top of the Interface⊥Brain split.
pub trait Brain {
    /// Decide what to do given the current perception. May return zero or more
    /// actions (typically one step + the occasional speech/use).
    fn decide(&mut self, obs: &Observation) -> Vec<Action>;
}

/// The UO direction (0..7) that heads from the player toward a `(dx, dy)` offset
/// (each component reduced to its sign). Returns `None` for a zero offset.
pub fn dir_toward(dx: i32, dy: i32) -> Option<u8> {
    use crate::net::movement::direction_delta;
    let sx = dx.signum();
    let sy = dy.signum();
    if (sx, sy) == (0, 0) {
        return None;
    }
    (0u8..8).find(|&d| direction_delta(d) == (sx, sy))
}

/// How a line of speech is delivered. The wire values are the `MessageType`
/// byte both ClassicUO (`Game/Data/MessageType.cs`) and ServUO
/// (`Server/Network/PacketHandlers.cs`) agree on, and the receive side already
/// styles every one of them — only the send side was ever fixed to `Say`.
///
/// Guild and alliance chat go out as ordinary speech with this type set, which
/// is why they need no separate action; the server routes them by type.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SpeechMode {
    /// Normal speech, heard by everyone nearby.
    #[default]
    Say,
    /// Reduced range (`MessageType.Whisper`).
    Whisper,
    /// Extended range (`MessageType.Yell`).
    Yell,
    /// Rendered as an emote by the receiving client (`MessageType.Emote`).
    Emote,
    /// Guild channel (`MessageType.Guild`).
    Guild,
    /// Alliance channel (`MessageType.Alliance`).
    Alliance,
}

impl SpeechMode {
    /// The `MessageType` byte to put in `0x03`/`0xAD`.
    pub fn wire(self) -> u8 {
        match self {
            SpeechMode::Say => 0,
            SpeechMode::Emote => 2,
            SpeechMode::Whisper => 8,
            SpeechMode::Yell => 9,
            SpeechMode::Guild => 13,
            SpeechMode::Alliance => 14,
        }
    }

    /// Stable lowercase name used by the JSON contract and the web client.
    pub fn name(self) -> &'static str {
        match self {
            SpeechMode::Say => "say",
            SpeechMode::Whisper => "whisper",
            SpeechMode::Yell => "yell",
            SpeechMode::Emote => "emote",
            SpeechMode::Guild => "guild",
            SpeechMode::Alliance => "alliance",
        }
    }

    /// Inverse of [`SpeechMode::name`]; `None` for anything unrecognized so a
    /// caller can reject rather than silently speak in the clear.
    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "say" => SpeechMode::Say,
            "whisper" => SpeechMode::Whisper,
            "yell" => SpeechMode::Yell,
            "emote" => SpeechMode::Emote,
            "guild" => SpeechMode::Guild,
            "alliance" => SpeechMode::Alliance,
            _ => return None,
        })
    }
}

/// A high-level intent emitted by the brain. The driver executes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Step one tile in UO direction 0..7 (running optional).
    Walk { dir: u8, run: bool },
    /// Auto-walk (click-to-walk): pathfind to world tile `(x, y)` and drive the
    /// player there step-by-step. A new `WalkTo` or any manual [`Action::Walk`]
    /// cancels an active route. The driver owns the route + pacing — the
    /// play-server paces it in its own loop; the headless `anima-net::Session`
    /// does the same non-blockingly via `Session::advance_route` (call it once
    /// per tick; `Session::navigate_to` remains for a blocking one-shot walk).
    WalkTo { x: u16, y: u16 },
    /// Speak in-game. `mode` picks the delivery — see [`SpeechMode`].
    Say { text: String, mode: SpeechMode },
    /// Send a message to the player's party (all members).
    PartySay { text: String },
    /// Begin attacking a target. The driver remembers `serial` as the "last
    /// target" (see [`crate::World::last_attack`]) for the auto-attack loop.
    Attack { serial: u32 },
    /// Auto-attack the best target (UO "last target" combat loop): the current
    /// last target if it's still a live in-view hostile, otherwise the nearest
    /// in-view hostile mobile. The driver picks the serial from the world.
    AutoAttack,
    /// Re-attack the current "last target" ([`crate::World::last_attack`]); a no-op
    /// if nothing has been attacked yet.
    AttackLast,
    /// Double-click ("use") an item or mobile.
    Use { serial: u32 },
    /// Single-click (request the name/label).
    Click { serial: u32 },
    /// Lift `amount` from a stack/item.
    PickUp { serial: u32, amount: u16 },
    /// Drop a held item at `(x, y, z)` into `container` (0xFFFFFFFF = ground).
    Drop {
        serial: u32,
        x: u16,
        y: u16,
        z: i16,
        container: u32,
    },
    /// Equip a held item onto the player at `layer` (UO 0x13 EquipRequest).
    Equip { serial: u32, layer: u8 },
    /// Toggle war mode.
    WarMode { on: bool },
    /// Cast a Magery spell by its spell id (1..64). If the spell needs a target,
    /// the server replies with a target cursor (answer via `TargetObject`/`TargetGround`).
    CastSpell { spell: u16 },
    /// Answer a pending target cursor by selecting an object/mobile.
    TargetObject { serial: u32 },
    /// Answer a pending target cursor by selecting a ground location.
    TargetGround {
        x: u16,
        y: u16,
        z: i16,
        graphic: u16,
    },
    /// Cancel a pending target cursor (Esc): the server stops waiting for a target
    /// (the spell/skill awaiting one is aborted) instead of hanging.
    TargetCancel,
    /// Buy `items` (each `(item serial, amount)`) from a vendor mobile (UO 0x3B).
    BuyItems { vendor: u32, items: Vec<(u32, u16)> },
    /// Sell `items` (each `(item serial, amount)`) to a vendor mobile (UO 0x9F).
    SellItems { vendor: u32, items: Vec<(u32, u16)> },
    /// Answer a server gump/dialog (0xB0/0xDD) with packet 0xB1 GumpResponse.
    /// `button` is the clicked reply button id (0 = close/cancel); `switches` are
    /// the ids of all checked checkboxes/selected radios; `entries` are
    /// `(textEntryId, value)` for each text field. The driver also closes the gump
    /// locally once the response is sent.
    GumpResponse {
        serial: u32,
        gump_id: u32,
        button: u32,
        switches: Vec<u32>,
        entries: Vec<(u16, String)>,
    },
    /// Request the right-click context (popup) menu for an entity (0xBF/0x13).
    /// The server answers with 0xBF/0x14, stored in `World::popup`.
    PopupRequest { serial: u32 },
    /// Choose entry `index` from the open context menu for `serial` (0xBF/0x15).
    PopupSelect { serial: u32, index: u16 },
    /// Answer a legacy item/question menu (0x7C) with packet 0x7D. `index` is
    /// 1-based; zero cancels. The driver derives the menu id and item graphic/hue
    /// from the current menu, preventing callers from forging stale entry data.
    LegacyMenuSelect { serial: u32, index: u16 },
    /// Choose a color in a server hue picker (0x95). The outgoing builder
    /// mirrors ServUO's normalization to the ordinary dyed range `2..=1001`.
    /// A stale serial is a no-op; server-owned hue pickers have no cancel reply.
    HuePickerSelect { serial: u32, hue: u16 },
    /// Request the content of all `pages` of the open book `serial` (outgoing 0x66).
    /// The server replies with 0x66 BookData, filling `World::book`.
    BookRequest { serial: u32, pages: u16 },
    /// Arm a weapon special move (UO 0xD7 UseCombatAbility). `ability` is the
    /// `Ability` enum id (the specific move, 1..=32); `0` disarms. The driver fills
    /// the player's serial. Which moves a weapon offers depends on its graphic
    /// (see ClassicUO `Abilities.cs` weapon→ability table).
    UseAbility { ability: u8 },
    /// Arm the pre-AOS Disarm special (UO 0xBF/0x09). The Wrestling-era
    /// predecessor of [`Action::UseAbility`], for shards where
    /// [`Observation::aos`] is false — on an AOS shard ServUO's handler returns
    /// immediately and nothing happens. Needs both hands free and Arms Lore +
    /// Wrestling ≥ 80; the server answers in the journal, not with a packet.
    DisarmRequest,
    /// Arm the pre-AOS Stun special (UO 0xBF/0x0A). The Stun half of the pair
    /// described on [`Action::DisarmRequest`]; gated on Anatomy + Wrestling ≥ 80.
    StunRequest,
    /// Toggle a gargoyle's flight (UO 0xBF/0x32) — the only racial ability that
    /// is used rather than merely possessed. ServUO's `PlayerMobile.ToggleFlying`
    /// returns immediately for any other race, so this is a no-op unless
    /// [`Observation::race`] is 3; on a shard that predates Stygian Abyss no
    /// character can be one.
    ToggleFlying,
    /// Apply bandage item `bandage` to mobile `target` in one packet (UO
    /// 0xBF/0x2C), skipping the double-click → 0x6C target-cursor round-trip.
    /// `target` 0 means the player themselves — the same "the driver fills in
    /// the obvious serial" sentinel [`Action::PartyAccept`] uses, and healing
    /// yourself is the case that most wants the shortcut. Rate-limited by the
    /// server's `NextActionTime`, so a brain should pace it rather than retry
    /// on silence.
    BandageTarget { bandage: u32, target: u32 },
    /// Cast spell `spell` at mobile/item `target` in one packet (UO 0xBF/0x2D),
    /// skipping the cast → 0x6C cursor → reply round-trip. `spell` is 1-based,
    /// the same id [`Action::CastSpell`] takes (ServUO subtracts 1 on the wire).
    /// `target` 0 means the player themselves — the [`Action::BandageTarget`]
    /// sentinel. A shard without the Enhanced-Client handlers drops this
    /// silently; ServUO registers it.
    TargetedSpell { spell: u16, target: u32 },
    /// Use skill `skill` on `target` in one packet (UO 0xBF/0x2E). `skill` is
    /// 0-based, the same id [`Action::UseSkill`] takes. `target` 0 = self.
    /// ServUO's handler `UseSkill`s and, if a cursor opened, immediately
    /// `Invoke`s it on `target` — Anatomy on a nearby mobile, Animal Taming
    /// on a creature, without the player ever seeing the cursor.
    TargetedSkill { skill: u16, target: u32 },
    /// Harvest with `tool` for `resource` (UO 0xBF/0x30 TargetByResourceMacro).
    /// ServUO's `HarvestSystem.TargetByResource`: 0 = ore, 1 = sand, 2 = wood,
    /// 3 = grave, 4 = red mushrooms. The tool must be a harvest tool the
    /// player is holding or carrying; the server picks a valid tile in range.
    TargetByResource { tool: u32, resource: u16 },
    /// Change a skill's lock state (UO 0x3A SkillStatusChangeRequest). `lock` is
    /// 0 = up (raise on gain), 1 = down (lower on gain), 2 = locked. The driver
    /// optimistically updates the world's skill lock so the UI reflects it at once.
    SkillLock { skill: u16, lock: u8 },
    /// Change a stat's training lock (UO 0xBF/0x1A StatLockStateRequest).
    /// `stat` is 0 = Strength, 1 = Dexterity, 2 = Intelligence; `lock` uses the
    /// same values as [`Action::SkillLock`] (0 up, 1 down, 2 locked). The
    /// driver optimistically updates the world's lock, as the skill twin does.
    StatLock { stat: u8, lock: u8 },
    /// Invoke an active skill by id (UO 0x12 ActionRequest, type 0x24 "use skill").
    /// Works for active skills (Hiding, Meditation, Anatomy, Animal Lore, …);
    /// passive skills are a no-op server-side.
    UseSkill { skill: u16 },
    /// Open the door the player is facing (UO 0x12 type 0x58). ClassicUO
    /// `GameActions.OpenDoor` / `PlayerMobile.TryOpenDoors` — no serial on the
    /// wire; ServUO looks at facing. Distinct from [`Action::Use`] on a door,
    /// which double-clicks a specific serial.
    OpenDoor,
    /// Open a spellbook from the pack by book type (UO 0x12 type 0x43).
    /// 1 = Magery, 101 = Necromancy, 201 = Chivalry, 401 = Bushido,
    /// 501 = Ninjitsu, 601 = Spellweaving. Double-clicking the book already
    /// works; this is the hotkey path, and the only one when the book is not
    /// visible in an open container.
    OpenSpellbook { book_type: u16 },
    /// Re-equip the weapon most recently worn (UO 0xD7 sub 0x1E). ServUO's
    /// `EquipLastWeaponRequest` swaps it back onto the one-hand layer.
    EquipLastWeapon,
    /// Invoke a virtue by 1-based id (UO 0x12 type 0xF4): Honor=1, Sacrifice=2,
    /// Valor=3, Compassion=4, Honesty=5, Humility=6, Justice=7, Spirituality=8.
    /// ServUO subtracts 1. A T2A shard without the virtue system drops it.
    InvokeVirtue { id: u8 },
    /// Play a named emote (UO 0x12 type 0xC7): `"bow"`, `"salute"`, … ClassicUO
    /// `GameActions.EmoteAction`. The server animates the player; unknown verbs
    /// are ignored.
    EmoteAction { action: String },
    /// Cast `spell` (1-based, same id as [`Action::CastSpell`]) from spellbook
    /// `book` (UO 0x12 type 0x27). ServUO looks the book up and casts from it;
    /// [`Action::CastSpell`] is the macro path with no book.
    CastSpellFromBook { spell: u16, book: u32 },
    /// Single-click every in-view mobile (except ourselves) and every corpse,
    /// ClassicUO `GameActions.AllNames`. Names arrive as overhead text. The
    /// driver caps the burst so it cannot flood the link.
    AllNames,
    /// Confirm a pending heritage / race-change dialog (0xBF/0x2A). The five
    /// fields are the same `u16`s ClassicUO `Send_ChangeRaceRequest` writes
    /// (skin hue, hair item id, hair hue, beard item id, beard hue). Female
    /// and elf bodies send beard 0 / hue 0. The driver clears
    /// [`Observation::race_change`] locally.
    ChangeRace {
        skin_hue: u16,
        hair_style: u16,
        hair_hue: u16,
        beard_style: u16,
        beard_hue: u16,
    },
    /// Dismiss the heritage dialog without changing appearance (0xBF/0x2A with
    /// no payload — ServUO `HeritageTransform` size 5 answers cliloc 1073645).
    ChangeRaceCancel,
    /// Open the Ultima Store (0xFA). ServUO `UltimaStore.UOStoreRequest`; a
    /// shard without the store registered ignores it.
    OpenUOStore,
    /// Request an entity's Object Property List / tooltip (UO 0xD6 MegaClilocRequest).
    /// The server replies with a 0xD6 MegaCliloc stored in `World::opl`. Sent on
    /// hover so the client can show the item/mobile's full properties.
    OplRequest { serial: u32 },
    /// Invite a player to the party (0xBF/0x06/0x01). The server opens a target
    /// cursor; the player to invite is chosen via the normal target flow.
    PartyInvite,
    /// Accept a pending party invitation from `leader` (0xBF/0x06/0x08).
    PartyAccept { leader: u32 },
    /// Decline a pending party invitation from `leader` (0xBF/0x06/0x09).
    PartyDecline { leader: u32 },
    /// Leave the current party (0xBF/0x06/0x02); the driver fills our own serial.
    PartyLeave,
    /// Remove `member` from the party (0xBF/0x06/0x02) — the same packet as
    /// [`Action::PartyLeave`], naming someone else. **Leader-only**, enforced
    /// by the server: ServUO's `PartyCommands.OnRemove` ignores the request
    /// unless we are the leader (or the member is ourselves), silently. A brain
    /// that wants certainty should re-read `Observation::party` afterwards
    /// rather than assume the kick took.
    PartyKick { member: u32 },
    /// Send `text` to one party member only (0xBF/0x06/0x03), rather than
    /// [`Action::PartySay`]'s to-all. Trimmed and clamped to 128 characters,
    /// because ServUO drops anything longer or empty instead of truncating it.
    PartyPrivateMessage { member: u32, text: String },
    /// Allow or forbid the rest of the party looting our corpse
    /// (0xBF/0x06/0x06). Server-side per-member state that is **never sent
    /// back** — ServUO answers with a journal line only (cliloc 1005447 /
    /// 1005448), so nothing in [`Observation`] reflects it and a consumer that
    /// cares must track what it last asked for.
    PartySetCanLoot { can_loot: bool },
    /// Ask the server for `serial`'s attributes (0x34 MobileQuery type 0x04).
    /// `serial` 0 means ourselves (the same sentinel
    /// [`Action::BandageTarget`] uses).
    ///
    /// For ourselves this is the ordinary status refresh. For **another party
    /// member** it is a *resync*, not the only source: ServUO pushes a
    /// member's mana/stam changes on its own (`Party.OnManaChanged`/
    /// `OnStamChanged` → 0xA2/0xA3), but **only while that member is in update
    /// range and visible**. Miss that window — you were out of range, they
    /// just came back into view, you joined mid-session — and your copy stays
    /// at whatever you last saw, with nothing scheduled to correct it. This
    /// asks; `Party.OnStatsQuery` answers with 0x2D `MobileAttributesN`.
    ///
    /// **What comes back is a percentage, not points.** Every party-facing
    /// variant (`MobileAttributesN`, `MobileManaN`, `MobileStamN`) runs
    /// through ServUO's `AttributeNormalizer`, which writes max as a fixed 25
    /// and current as `cur * 25 / max`. Measured live: a member whose real
    /// mana was 7/10 reached the leader as 17/25. So a brain can compare
    /// members' *fractions* but must never read another player's mana as an
    /// absolute number, and must not compare it against a spell's mana cost.
    /// Our own vitals are exempt — those arrive un-normalized.
    StatusRequest { serial: u32 },
    /// Re-fetch our full skill list (0x34 type 5). The driver asks once at
    /// login; ServUO pushes single-skill updates after that, so this is a
    /// resync, e.g. after a GM changed skills behind our back.
    SkillsRequest,
    /// Ask for a mobile's name (0x98); the reply lands in `mobiles[].name`.
    NameRequest { serial: u32 },
    /// Set the draw range, 5..=24 tiles (0xC8): what the server sends us —
    /// mobiles and items — beyond the default 18.
    ViewRange { range: u8 },
    /// The "?" help cursor on an object (0xB6); see
    /// [`crate::net::outgoing::build_object_help_request`].
    ObjectHelp { serial: u32 },
    /// Set our language code, e.g. `ENU` or `KOR` (0xBF/0x0B).
    Language { code: String },
    /// Play an emote animation by raw action id (0xBF/0x0E) — ServUO accepts
    /// only its short list (bow 32, salute 33, …). The named pair is
    /// [`Action::EmoteAction`].
    Animate { action: u32 },
    /// Whether to be shown public houses' contents (0xFB).
    PublicHouseContent { show: bool },
    /// Ask an open bulletin board for a message's full body (0x71 sub 3).
    /// The reply fills [`Observation::bulletin_message`]; a summary line alone
    /// carries no text.
    BulletinRequestMessage { board: u32, message: u32 },
    /// Ask for one message's summary line again (0x71 sub 4) — how a newly
    /// posted thread's header is fetched without reopening the board.
    BulletinRequestSummary { board: u32, message: u32 },
    /// Post a thread, or a reply when `reply_to` names an existing message
    /// (0x71 sub 5).
    ///
    /// ServUO refuses an empty subject or an empty body outright, and
    /// rate-limits both new threads and replies (`ThreadCreateTime` /
    /// `ThreadReplyTime`) with a journal line rather than a packet. It also
    /// requires us to be in range of the board. Confirm by re-reading
    /// [`Observation::bulletin_board`] rather than assuming.
    BulletinPost {
        board: u32,
        reply_to: u32,
        subject: String,
        lines: Vec<String>,
    },
    /// Delete message `message` from `board` (0x71 sub 6). ServUO silently
    /// ignores this unless we posted it or are a GameMaster.
    BulletinRemove { board: u32, message: u32 },
    /// Steer the boat we are piloting in absolute direction `dir` (0..7),
    /// walking or running (0xBF/0x33). The driver fills our own serial —
    /// ServUO looks the *player* up and reaches the ship through `mob.Mount`.
    ///
    /// **Requires piloting first**, and nothing says so if you are not: the
    /// handler returns unless the player is mounted on a `BaseBoat`, which
    /// happens when the tiller man (or a High Seas ship wheel) is
    /// double-clicked. `Observation::player.mounted` becomes true when it
    /// takes, because the pilot lock equips a virtual mount item.
    ///
    /// The other boat-control path is tiller-man speech ("forward", "stop"):
    /// `Action::Say` with those words matches `speech.mul` and goes out as
    /// encoded 0xAD so ServUO fills `e.Keywords`.
    BoatMove { dir: u8, run: bool },
    /// Stop the boat we are piloting (0xBF/0x33 with speed 0).
    ///
    /// Spelled as its own action because the speed byte has no "3": ServUO
    /// treats every unrecognised speed as a stop, so an out-of-range value is
    /// indistinguishable from this and a caller should not have to know that.
    BoatStop,
    /// Rewrite an open book's title and author (0xD4).
    ///
    /// Silent all-or-nothing on the server: ServUO discards the whole packet
    /// if the title exceeds 60 UTF-8 bytes or the author 30, and refuses the
    /// edit entirely unless the book is writable, within one tile, and
    /// accessible — never saying so. Both strings are clamped by the builder;
    /// confirm the rest by re-reading [`Observation::book`].
    BookHeaderChange {
        serial: u32,
        title: String,
        author: String,
    },
    /// Replace the text of one page (0x66). `page` is **1-based**.
    ///
    /// Clamped to 8 lines of at most 79 characters, because ServUO drops the
    /// entire packet — not just the offending line — on `lineCount > 8` or a
    /// line whose length reaches 80. Newlines inside a line are stripped: the
    /// wire list is NUL-terminated, so an embedded break would desynchronize
    /// it.
    BookPageWrite {
        serial: u32,
        page: u16,
        lines: Vec<String>,
    },
    /// Turn map item `serial` between view and edit mode (0x56 command 6).
    ///
    /// **Required before any other map-pin action.** ServUO gates every pin
    /// mutator on `ValidateEdit` = `m_Editable && Validate(from)`, and
    /// `m_Editable` starts false, so edits sent to a map in view mode are
    /// discarded with no reply. The server answers this one with its own
    /// 0x56 command 7 carrying the resulting state — which may still be "not
    /// editable" if the map is out of reach, protected, or someone else's.
    MapToggleEditable { serial: u32 },
    /// Append a pin to map `serial` at `(x, y)` in the map's own pixel space
    /// ([`crate::world::MapView::width`]/`height`), not world coordinates.
    /// ServUO clamps out-of-range coordinates onto the edge and caps a map at
    /// 50 pins.
    MapAddPin { serial: u32, x: u16, y: u16 },
    /// Insert a pin at `index`. An out-of-range index appends rather than
    /// failing (ServUO `InsertPin`).
    MapInsertPin {
        serial: u32,
        index: u8,
        x: u16,
        y: u16,
    },
    /// Move the pin at `index` to `(x, y)`. An out-of-range index is ignored.
    MapChangePin {
        serial: u32,
        index: u8,
        x: u16,
        y: u16,
    },
    /// Remove the pin at `index`. **Index 0 is refused server-side**
    /// (`RemovePin` guards on `index > 0`), which is what protects the chest
    /// pin on a decoded treasure map.
    MapRemovePin { serial: u32, index: u8 },
    /// Remove every pin — including index 0, unlike [`Action::MapRemovePin`];
    /// "clear" is genuinely not "remove each in turn" here.
    ///
    /// On a *treasure* map the effect is undone by the next display:
    /// `TreasureMap.DisplayTo` re-adds the chest pin whenever the list is
    /// empty, so the map will not stay pinless. Ordinary maps do stay cleared.
    MapClearPins { serial: u32 },
    /// Register with the server's chat system (0xB5). **Required first**:
    /// ServUO's `ChatAction` looks the sender up with `ChatUser.GetChatUser`
    /// and returns silently when there is none, so every other chat action is
    /// a no-op until this has been sent. The driver fills our own name.
    ChatOpen,
    /// Join chat channel `channel` (0xB3 action 0x62). `password` may be empty.
    ///
    /// Note the password cannot actually arrive on a ServUO: ClassicUO's
    /// `WriteUnicodeBE` NUL-terminates the name, and ServUO reads the whole
    /// parameter with `ReadUnicodeString()`, which stops there. The channel
    /// name still resolves — its quote parser falls back to "everything after
    /// the opening quote" — so joining works and only password-protected
    /// channels are unreachable. We send ClassicUO's bytes rather than guess at
    /// a fix, since a shard that expects the standard client's stream is the
    /// thing being talked to.
    ChatJoin { channel: String, password: String },
    /// Create channel `channel` and join it (0xB3 action 0x63).
    ///
    /// `password` is carried for wire parity but ServUO cannot use it: its
    /// `CreateChannel` passes the whole parameter through as the channel
    /// *name*, so a non-empty password yields a channel called
    /// `channel{password}`. Leave it empty against ServUO.
    ChatCreate { channel: String, password: String },
    /// Leave the current chat channel (0xB3 action 0x43). Conference-gated
    /// server-side: with no channel joined the server says so in the journal.
    ChatLeave,
    /// Say `text` in the current chat channel (0xB3 action 0x61) — distinct
    /// from [`Action::Say`] (local speech) and [`Action::PartySay`]. Also
    /// conference-gated.
    ChatSay { text: String },
    /// Rename the mobile `serial` (0x75). Shards accept this only for a
    /// creature we control — a pet — and ignore it otherwise. There is no
    /// acknowledgement packet, so confirm by re-reading the mobile's name
    /// rather than assuming it took. `name` is truncated to 30 ASCII bytes,
    /// the fixed field the packet carries.
    Rename { serial: u32, name: String },
    /// Click the server's on-screen quest arrow (0xBF/0x07); `right_click`
    /// picks the button. The arrow itself is server-owned state (0xBA sets and
    /// clears it, surfaced as [`Observation::quest_arrow`]) — this reports the
    /// click, which is usually what makes the server take it away. A no-op
    /// when no arrow is outstanding.
    QuestArrowClick { right_click: bool },
    /// Open the shard's help / GM-page menu (0x9B). The reply is an ordinary
    /// server gump, answered with [`Action::GumpResponse`] like any other —
    /// which is what makes this worth having for a brain: it is the entry
    /// point to paging a GM when something is stuck.
    HelpRequest,
    /// Ask the server to open the guild menu (0xD7/0x28); the driver fills our
    /// own serial. Answered with an ordinary gump.
    GuildMenu,
    /// Ask the server to open the quest menu (0xD7/0x32); the driver fills our
    /// own serial. Answered with an ordinary gump.
    QuestMenu,
    /// Answer a pending 0x9A ASCII or 0xC2 Unicode server text prompt (pet rename,
    /// house sign, guild abbreviation, …) with typed `text`. The driver selects
    /// the prompt kind's matching packet/text encoding and echoes the
    /// prompt's `sender_serial`/`prompt_id` from [`crate::world::World::prompt`]
    /// (cleared once answered); a no-op if nothing is pending.
    PromptResponse { text: String },
    /// Cancel a pending server text prompt (Esc): the server aborts whatever
    /// needed the response instead of leaving it dangling; a no-op if nothing is
    /// pending.
    PromptCancel,
    /// Ask the server for the previous/next page of a pageable 0xA6 Tip window.
    /// `seq` identifies the exact open client window; stale or notice-only
    /// windows are a no-op. The driver sends fixed 0xA7 then closes that window.
    TipNavigate { seq: u64, next: bool },
    /// Dismiss exactly one 0xA6 Tip/Notice window locally without sending a
    /// packet, matching ClassicUO's close/right-click behavior.
    TipClose { seq: u64 },
    /// Answer an exact 0xAB text-entry dialog. `accepted=false` is the explicit
    /// Cancel button and still sends the current text, matching ClassicUO.
    /// The driver derives all callback fields and input constraints from the
    /// live dialog; a stale `seq` is a no-op.
    TextEntryResponse {
        seq: u64,
        text: String,
        accepted: bool,
    },
    /// Silently close an exact 0xAB dialog without a packet. This only succeeds
    /// when the server's `can_close` flag permits ClassicUO's right-click close.
    TextEntryClose { seq: u64 },
    /// Request the character profile of `serial` (0xB8 type 0). The server
    /// performs player/range/visibility checks and returns an open profile.
    ProfileRequest { serial: u32 },
    /// Save and close an exact editable self profile (0xB8 type 1). Callback
    /// serial/edit permission/original text come from the live `seq`; stale or
    /// read-only profiles are inert. An unchanged body closes without a packet,
    /// matching ClassicUO's dispose-time change detection.
    ProfileUpdate { seq: u64, text: String },
    /// Close an exact profile locally without changing its original body.
    ProfileClose { seq: u64 },
    /// End the current game session. When the 0xA9 capability flag is present,
    /// send 0xD1 and keep the connection open until a fresh
    /// [`Observation::logout_ack`] explicitly allows it. Otherwise the driver
    /// follows ClassicUO's immediate-disconnect fallback without sending 0xD1.
    Logout,
    /// Toggle our side's accept checkbox on a secure trade (0x6F action 2).
    /// `container` selects which session (its `my_container`, from
    /// [`crate::world::World::trades`] — multiple can be open at once with
    /// different opponents); a no-op if no session has that container (the
    /// brain raced the session away). Both sides accepting completes the
    /// trade server-side.
    TradeAccept { container: u32, accept: bool },
    /// Cancel a secure trade (0x6F action 1): items on both sides return to
    /// their owners. `container` selects which session; the driver clears
    /// just that session locally; a no-op if no session has that container.
    TradeCancel { container: u32 },
    /// Set the virtual gold/platinum amount we're offering on a secure trade
    /// (0x6F action 3 UpdateGold). `container` selects which session; a no-op
    /// if no session has that container. Only takes effect on a server/client
    /// pair that negotiated the AOS/TOL "account gold" feature (see
    /// [`crate::world::TradeState`]'s doc).
    TradeGold {
        container: u32,
        gold: u32,
        platinum: u32,
    },
    /// A custom-house designer edit (0xD7). Coordinates are FOUNDATION-RELATIVE —
    /// see anima_core::net::outgoing's house-design builders. A dedicated nested
    /// enum rather than 13 flat variants here, kept on the ordinary `Action`
    /// contract (not a play-server-local side channel) for contract
    /// completeness: an AI player must be able to build a house too.
    HouseDesign(HouseDesignAction),
}

/// One custom-house designer edit (UO 0xD7 `HouseFoundation` designer
/// sub-commands). Coordinates are FOUNDATION-RELATIVE, not absolute world
/// tiles — see `anima_core::net::outgoing`'s `build_house_design_*` builders,
/// which each variant here maps onto 1:1 (the driver fills in the player's
/// own serial, same as [`Action::PartyLeave`]/[`Action::Logout`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HouseDesignAction {
    AddItem {
        graphic: u16,
        x: i32,
        y: i32,
    },
    DeleteItem {
        graphic: u16,
        x: i32,
        y: i32,
        z: i32,
    },
    AddStair {
        graphic: u16,
        x: i32,
        y: i32,
    },
    AddRoof {
        graphic: u16,
        x: i32,
        y: i32,
        z: i32,
    },
    DeleteRoof {
        graphic: u16,
        x: i32,
        y: i32,
        z: i32,
    },
    GoToFloor(u8),
    Commit,
    Close,
    Clear,
    Revert,
    Backup,
    Restore,
    Sync,
}

fn chebyshev(a: Position, b: Position) -> u32 {
    (a.x.abs_diff(b.x)).max(a.y.abs_diff(b.y)) as u32
}

impl World {
    /// Build an [`Observation`]. `journal_cursor` is an absolute journal index;
    /// it advances past the retained tail so trimming bounded history does not
    /// replay entries. A lagging consumer receives every retained line.
    /// Where an item really is: its own position on the ground, or that of the
    /// ground container or mobile at the top of its container chain. A contained
    /// item's `pos` is a spot inside the container *window*, so a distance from
    /// it was meaningless (and sorted pack contents among ground items).
    fn root_position(&self, it: &crate::world::Item) -> Position {
        let mut cur = it;
        for _ in 0..16 {
            match cur.container {
                None => return cur.pos,
                Some(c) => {
                    if let Some(parent) = self.items.get(&c) {
                        cur = parent;
                    } else if let Some(m) = self.mobiles.get(&c) {
                        return m.pos;
                    } else {
                        return cur.pos;
                    }
                }
            }
        }
        cur.pos
    }

    pub fn observe(&self, journal_cursor: &mut usize) -> Observation {
        let pm = self.player_mobile().cloned().unwrap_or_default();
        let player = PlayerView {
            serial: pm.serial,
            name: pm.name.clone(),
            pos: pm.pos,
            direction: pm.direction,
            hits: pm.hits,
            hits_max: pm.hits_max,
            mana: pm.mana,
            mana_max: pm.mana_max,
            stam: pm.stam,
            stam_max: pm.stam_max,
            strength: self.player_stats.strength,
            dexterity: self.player_stats.dexterity,
            intelligence: self.player_stats.intelligence,
            gold: self.player_stats.gold,
            weight: self.player_stats.weight,
            weight_max: self.player_stats.weight_max,
            race: self.player_stats.race,
            aos_status: self.player_stats.aos,
            armor: self.player_stats.armor,
            followers: self.player_stats.followers,
            followers_max: self.player_stats.followers_max,
            fire_resistance: self.player_stats.fire_resistance,
            cold_resistance: self.player_stats.cold_resistance,
            poison_resistance: self.player_stats.poison_resistance,
            energy_resistance: self.player_stats.energy_resistance,
            body: pm.body,
            poisoned: pm.poisoned,
            dead: is_ghost_body(pm.body),
            hidden: pm.hidden,
            paralyzed: pm.paralyzed,
            poison_level: pm.poison_level,
            notoriety: pm.notoriety,
            hue: pm.hue,
            mounted: self
                .items
                .values()
                .any(|it| it.layer == 0x19 && it.container == Some(pm.serial) && pm.serial != 0),
            luck: self.player_stats.luck,
            damage_min: self.player_stats.damage_min,
            damage_max: self.player_stats.damage_max,
            tithing_points: self.player_stats.tithing_points,
            stats_cap: self.player_stats.stats_cap,
            str_lock: self.player_stats.str_lock,
            dex_lock: self.player_stats.dex_lock,
            int_lock: self.player_stats.int_lock,
            speed_mode: self.player_stats.speed_mode,
        };

        let mut mobiles: Vec<MobileView> = self
            .mobiles
            .values()
            .filter(|m| Some(m.serial) != self.player.map(|s| s.0))
            .map(|m| MobileView {
                serial: m.serial,
                name: m.name.clone(),
                pos: m.pos,
                body: m.body,
                notoriety: m.notoriety,
                hits: m.hits,
                hits_max: m.hits_max,
                distance: chebyshev(player.pos, m.pos),
                status: MobileStatus {
                    poisoned: m.poisoned,
                    poison_level: m.poison_level,
                    paralyzed: m.paralyzed,
                    war_mode: m.war_mode,
                    hidden: m.hidden,
                    yellow_health: m.yellow_health,
                    running: m.running,
                    direction: m.direction & 7,
                    hue: m.hue,
                    flying: m.flying,
                    bonded_dead: m.is_dead,
                    mana: m.mana,
                    mana_max: m.mana_max,
                    stam: m.stam,
                    stam_max: m.stam_max,
                },
            })
            .collect();
        mobiles.sort_by_key(|m| m.distance);

        let mut items: Vec<ItemView> = self
            .items
            .values()
            .map(|it| ItemView {
                serial: it.serial,
                graphic: it.graphic,
                amount: it.amount,
                pos: it.pos,
                container: it.container,
                layer: it.layer,
                distance: chebyshev(player.pos, self.root_position(it)),
                is_multi: it.is_multi,
                detail: ItemDetail {
                    hue: it.hue,
                    name: it.name.clone(),
                    movable: it.container.is_none().then(|| it.flag_movable()),
                    hidden: it.container.is_none().then(|| it.flag_hidden()),
                },
            })
            .collect();
        items.sort_by_key(|it| it.distance);

        let mut waypoints: Vec<WaypointView> = self
            .waypoints
            .values()
            .map(|waypoint| WaypointView {
                serial: waypoint.serial,
                pos: waypoint.pos,
                map: waypoint.map,
                kind: waypoint.kind,
                ignore_object: waypoint.ignore_object,
                cliloc: waypoint.cliloc,
                name: waypoint.name.clone(),
                distance: chebyshev(player.pos, waypoint.pos),
            })
            .collect();
        waypoints.sort_by_key(|waypoint| (waypoint.distance, waypoint.serial));

        let journal_end = self.journal_offset.saturating_add(self.journal.len());
        let start = journal_cursor
            .saturating_sub(self.journal_offset)
            .min(self.journal.len());
        let new_journal = self.journal[start..].to_vec();
        *journal_cursor = journal_end;

        let mut skills: Vec<SkillView> = self
            .skills
            .values()
            .map(|s| SkillView {
                id: s.id,
                value: s.value as f32 / 10.0,
                base: s.base as f32 / 10.0,
                cap: s.cap as f32 / 10.0,
                lock: s.lock,
            })
            .collect();
        skills.sort_by_key(|s| s.id);

        let gumps = self
            .gumps
            .iter()
            .map(|g| GumpView {
                serial: g.serial,
                gump_id: g.gump_id,
                layout: g.layout.clone(),
                elements: crate::gump_layout::parse(&g.layout, &g.text).elements,
            })
            .collect();

        // HashMap iteration order isn't stable — sort so a brain sees a
        // deterministic order run to run (like `skills`, sorted by id).
        let mut corpse_of: Vec<(u32, u32)> = self.corpse_of.iter().map(|(&c, &k)| (c, k)).collect();
        corpse_of.sort_by_key(|&(c, _)| c);
        let mut corpse_equip: Vec<(u32, Vec<(u8, u32)>)> = self
            .corpse_equip
            .iter()
            .map(|(&c, v)| (c, v.clone()))
            .collect();
        corpse_equip.sort_by_key(|&(c, _)| c);

        let mut opl: Vec<(u32, Vec<(u32, String)>)> =
            self.opl.iter().map(|(&s, v)| (s, v.clone())).collect();
        opl.sort_by_key(|&(s, _)| s);

        // HashMap iteration order isn't stable — sorted by serial, like `opl`.
        let mut spellbooks: Vec<(u32, SpellbookContent)> =
            self.spellbooks.iter().map(|(&s, sb)| (s, *sb)).collect();
        spellbooks.sort_by_key(|&(s, _)| s);

        // HashMap iteration order isn't stable — sorted by serial, like `opl`/`spellbooks`.
        let mut map_gumps: Vec<(u32, MapView)> = self
            .map_gumps
            .iter()
            .map(|(&s, mv)| (s, mv.clone()))
            .collect();
        map_gumps.sort_by_key(|&(s, _)| s);

        let mut legacy_menus = self.legacy_menus.clone();
        legacy_menus.sort_by_key(|menu| menu.serial);
        let mut hue_pickers = self.hue_pickers.clone();
        hue_pickers.sort_by_key(|picker| picker.serial);

        Observation {
            player,
            mobiles,
            items,
            bulletin_board: self.bulletin_board.clone(),
            bulletin_message: self.bulletin_message.clone(),
            chat: self.chat.clone(),
            chat_messages: self.chat_messages.clone(),
            new_journal,
            pending_target: self.pending_target,
            skills,
            gumps,
            prompt: self.prompt,
            trades: self.trades.clone(),
            buffs: self.buffs.clone(),
            shop_buy: self.shop_buy.clone(),
            shop_sell: self.shop_sell.clone(),
            popup: self.popup.clone(),
            legacy_menus,
            hue_pickers,
            race_change: self.race_change,
            open_urls: self.recent_open_urls.clone(),
            tips: self.tips.clone(),
            text_entry_dialogs: self.text_entry_dialogs.clone(),
            character_profiles: self.character_profiles.clone(),
            logout_ack: self.logout_ack,
            book: self.book.clone(),
            party: self.party.clone(),
            quest_arrow: self.quest_arrow,
            waypoints,
            weather: self.weather,
            season: self.season,
            light: self.effective_light(),
            war: self.war,
            last_attack: self.last_attack,
            combatant: self.combatant,
            corpse_of,
            corpse_equip,
            map_index: self.map_index,
            aos: self.aos,
            armed_ability: self.armed_ability,
            // Sorted, not in arrival order: an observation is a snapshot a brain
            // may diff against the last one, and two identical sets must compare
            // equal regardless of the order the toggles arrived in.
            active_spell_icons: {
                let mut icons = self.active_spell_icons.clone();
                icons.sort_unstable();
                icons
            },
            opl,
            recent_damage: self.recent_damage.clone(),
            spellbooks,
            map_gumps,
            // The core has no map files by design (DESIGN.md D3) — a driver
            // that does calls `survey_terrain` and fills this in.
            terrain: None,
            opl_text: Vec::new(),
            party_positions: self.party_positions.clone(),
            guild_positions: self.guild_positions.clone(),
            recent_effects: self.recent_effects.clone(),
            recent_anims: self.recent_anims.clone(),
            recent_typed_anims: self.recent_typed_anims.clone(),
            recent_sounds: self.recent_sounds.clone(),
            recent_lift_rejects: self.recent_lift_rejects.clone(),
            recent_drag_completions: self.recent_drag_completions.clone(),
            pending_multi_placement: self.pending_multi_placement,
            customizing_house: self.customizing_house,
            house_designs: {
                let mut designs: Vec<_> = self
                    .house_designs
                    .iter()
                    .map(|(&s, d)| (s, d.clone()))
                    .collect();
                designs.sort_by_key(|(serial, _)| *serial);
                designs
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::login::LoginResult;

    /// A flat grid with a wall column, a raised ledge, and one closed door —
    /// enough to prove the survey distinguishes all three.
    struct Grid {
        wall_x: u32,
        ledge: std::collections::HashSet<(u32, u32)>,
        door: Option<(u32, u32)>,
    }
    impl Terrain for Grid {
        fn walkable_step(&mut self, x: u32, y: u32, _from_z: i32) -> Option<i32> {
            if x == self.wall_x {
                return None;
            }
            Some(if self.ledge.contains(&(x, y)) { 12 } else { 0 })
        }
        fn door_at(&mut self, x: u32, y: u32, _current_z: i32) -> Option<u32> {
            (self.door == Some((x, y))).then_some(0x4001)
        }
    }

    #[test]
    fn survey_terrain_reports_walls_heights_and_doors() {
        let mut g = Grid {
            wall_x: 102,
            ledge: [(99, 100)].into_iter().collect(),
            door: Some((100, 101)),
        };
        let view = survey_terrain(&mut g, (100, 100), 0, 2);

        assert_eq!(view.origin, (98, 98));
        assert_eq!(view.side(), 5);
        assert_eq!(view.tiles.len(), 25);

        // The wall column is the one thing a brain could not previously see.
        let wall = view.at(102, 100).expect("inside the window");
        assert!(!wall.walkable);
        assert_eq!(wall.door, None, "a wall is not a door");

        // A raised tile is walkable but at a different Z.
        assert_eq!(
            view.at(99, 100),
            Some(TerrainTile {
                walkable: true,
                z: 12,
                door: None
            })
        );

        // A door reads as walkable *and* names the serial to `Use` first —
        // that distinction is the whole reason `door` exists.
        let door = view.at(100, 101).expect("inside the window");
        assert!(door.walkable);
        assert_eq!(door.door, Some(0x4001));

        assert_eq!(view.at(200, 200), None, "outside the window");
    }

    #[test]
    fn survey_terrain_stays_rectangular_at_the_map_origin() {
        // A player near (0,0) must not produce a wrapped or short grid.
        let mut g = Grid {
            wall_x: u32::MAX,
            ledge: Default::default(),
            door: None,
        };
        let view = survey_terrain(&mut g, (1, 0), 0, 3);
        assert_eq!(view.origin, (0, 0), "clamped, not wrapped");
        assert_eq!(view.tiles.len(), 49);
    }

    #[test]
    fn observe_sorts_by_distance_and_advances_journal() {
        let mut w = World::new();
        w.enter_world(&LoginResult {
            serial: 0x311,
            x: 100,
            y: 100,
            z: 0,
            direction: 0,
            body: 0x190,
            aos: false,
            character_list_flags: 0,
        });
        // Two mobiles at different distances.
        let far = w.mobile_mut(0xAA);
        far.pos = Position {
            x: 110,
            y: 100,
            z: 0,
        };
        let near = w.mobile_mut(0xBB);
        near.pos = Position {
            x: 102,
            y: 100,
            z: 0,
        };

        w.journal.push(JournalEntry {
            serial: 0,
            name: "System".into(),
            text: "hello".into(),
            msg_type: 0,
            hue: 0,
            cliloc: 0,
            ..Default::default()
        });

        let mut cursor = 0;
        let obs = w.observe(&mut cursor);
        assert_eq!(obs.mobiles.len(), 2);
        assert_eq!(obs.mobiles[0].serial, 0xBB); // nearest first
        assert_eq!(obs.mobiles[0].distance, 2);
        assert_eq!(obs.new_journal.len(), 1);

        let player_mobile = w.mobile_mut(0x311);
        player_mobile.body = 0x192;
        player_mobile.poisoned = true;
        let survival = w.observe(&mut cursor);
        assert_eq!(survival.player.body, 0x192);
        assert!(survival.player.poisoned);
        assert!(survival.player.dead);

        // A second observe with the advanced cursor sees no repeat lines.
        let obs2 = w.observe(&mut cursor);
        assert!(obs2.new_journal.is_empty());
    }

    #[test]
    fn observe_carries_a_mobiles_visible_condition() {
        let mut w = World::new();
        w.enter_world(&LoginResult {
            serial: 0x311,
            x: 100,
            y: 100,
            z: 0,
            direction: 0,
            body: 0x190,
            aos: false,
            character_list_flags: 0,
        });
        let m = w.mobile_mut(0xAA);
        m.pos = Position {
            x: 103,
            y: 100,
            z: 0,
        };
        m.poisoned = true;
        m.poison_level = 1;
        m.paralyzed = true;
        m.war_mode = true;
        m.direction = 0x86; // running bit above the facing
        let obs = w.observe(&mut 0);
        let s = obs.mobiles[0].status;
        assert!(s.poisoned && s.paralyzed && s.war_mode);
        assert_eq!(s.poison_level, 1);
        assert!(!s.hidden && !s.yellow_health);
        assert_eq!(s.direction, 6);
    }

    #[test]
    fn a_contained_item_is_as_far_as_whatever_holds_it() {
        let mut w = World::new();
        w.enter_world(&LoginResult {
            serial: 0x311,
            x: 100,
            y: 100,
            z: 0,
            direction: 0,
            body: 0x190,
            aos: false,
            character_list_flags: 0,
        });
        let chest = w.items.entry(0x4000_0001).or_default();
        chest.serial = 0x4000_0001;
        chest.pos = Position {
            x: 106,
            y: 100,
            z: 0,
        };
        let gem = w.items.entry(0x4000_0002).or_default();
        gem.serial = 0x4000_0002;
        gem.container = Some(0x4000_0001);
        gem.pos = Position { x: 44, y: 65, z: 0 }; // a spot in the chest's window, not the world
        let obs = w.observe(&mut 0);
        let gem = obs.items.iter().find(|i| i.serial == 0x4000_0002).unwrap();
        assert_eq!(gem.distance, 6);
    }

    #[test]
    fn observe_sorts_waypoints_by_distance_then_serial() {
        use crate::world::Waypoint;

        let mut w = World::new();
        w.enter_world(&LoginResult {
            serial: 0x311,
            x: 100,
            y: 100,
            z: 0,
            direction: 0,
            body: 0x190,
            aos: false,
            character_list_flags: 0,
        });
        for (serial, x, name) in [
            (0x30, 105, "same-distance-higher-serial"),
            (0x10, 102, "nearest"),
            (0x20, 105, "same-distance-lower-serial"),
        ] {
            w.set_waypoint(Waypoint {
                serial,
                pos: Position { x, y: 100, z: -5 },
                map: 0,
                kind: 6,
                ignore_object: false,
                cliloc: 1_060_000 + serial,
                name: name.into(),
            });
        }

        let obs = w.observe(&mut 0);
        assert_eq!(
            obs.waypoints
                .iter()
                .map(|waypoint| (waypoint.serial, waypoint.distance))
                .collect::<Vec<_>>(),
            vec![(0x10, 2), (0x20, 5), (0x30, 5)]
        );
        assert_eq!(obs.waypoints[0].name, "nearest");
        assert_eq!(obs.waypoints[0].pos.z, -5);
    }
}
