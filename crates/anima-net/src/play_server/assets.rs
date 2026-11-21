//! Serving UO client data as web resources.
//!
//! Art, animation frames, gump art, texmaps, sound and music are decoded from the
//! `.mul`/`.uop` files on demand and handed to the browser as PNG/WAV, behind a
//! byte-budgeted cache — the four caches exist because decoding is far more
//! expensive than the memory they cost.

use super::*;

/// A byte-budgeted FIFO cache. PNG sizes vary widely, so an entry-count cap
/// cannot provide a meaningful memory bound. Hits do not reorder entries: the
/// cache is deliberately simple because decoded assets are cheap to refill and
/// the main requirement is a hard upper bound for long sessions.
pub(super) struct ByteCache<K, V> {
    entries: HashMap<K, (V, usize)>,
    order: VecDeque<K>,
    bytes: usize,
    max_bytes: usize,
}

impl<K: Clone + Eq + Hash, V> ByteCache<K, V> {
    pub(super) fn new(max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            max_bytes,
        }
    }

    pub(super) fn get_cloned(&self, key: &K) -> Option<V>
    where
        V: Clone,
    {
        self.entries.get(key).map(|(value, _)| value.clone())
    }

    pub(super) fn insert(&mut self, key: K, value: V, weight: usize) {
        if weight > self.max_bytes {
            return;
        }
        if let Some((_, old_weight)) = self.entries.remove(&key) {
            self.bytes = self.bytes.saturating_sub(old_weight);
            self.order.retain(|queued| queued != &key);
        }
        while self.bytes.saturating_add(weight) > self.max_bytes {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some((_, old_weight)) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(old_weight);
            }
        }
        self.bytes = self.bytes.saturating_add(weight);
        self.order.push_back(key.clone());
        self.entries.insert(key, (value, weight));
    }
}

pub(super) const TILE_CACHE_BYTES: usize = 32 * 1024 * 1024;

pub(super) const ANIM_CACHE_BYTES: usize = 48 * 1024 * 1024;

pub(super) const GUMP_CACHE_BYTES: usize = 32 * 1024 * 1024;

pub(super) const TEXMAP_CACHE_BYTES: usize = 16 * 1024 * 1024;

pub(super) fn respond_png(req: tiny_http::Request, bytes: Vec<u8>) {
    let mut r = Response::from_data(bytes);
    r.add_header(ctype("image/png"));
    r.add_header(Header::from_bytes(&b"Cache-Control"[..], &b"max-age=86400"[..]).unwrap());
    let _ = req.respond(r);
}

/// Like [`respond_png`] but asks the browser to revalidate. For content whose
/// URL does not change when the bytes do — a light shape's `?c=` variant, most
/// of all — heuristic caching hands back yesterday's answer.
pub(super) fn respond_png_nocache(req: tiny_http::Request, bytes: Vec<u8>) {
    let mut r = Response::from_data(bytes);
    r.add_header(ctype("image/png"));
    r.add_header(Header::from_bytes(&b"Cache-Control"[..], &b"no-cache"[..]).unwrap());
    let _ = req.respond(r);
}

/// Like [`respond_png`] but also sends the anim frame's draw-center as `X-Cx`/`X-Cy`
/// headers, so the renderer can place each part at `(screenX - cx, screenY - h - cy)`
/// (ClassicUO positioning) instead of a naïve foot anchor — which is what aligns
/// held items, hair, armor and a rider on a mount.
pub(super) fn respond_png_center(req: tiny_http::Request, bytes: Vec<u8>, cx: i16, cy: i16) {
    let mut r = Response::from_data(bytes);
    r.add_header(ctype("image/png"));
    r.add_header(Header::from_bytes(&b"Cache-Control"[..], &b"max-age=86400"[..]).unwrap());
    r.add_header(Header::from_bytes(&b"X-Cx"[..], cx.to_string().as_bytes()).unwrap());
    r.add_header(Header::from_bytes(&b"X-Cy"[..], cy.to_string().as_bytes()).unwrap());
    let _ = req.respond(r);
}

/// Serve audio bytes with a content type and a long cache (assets never change).
pub(super) fn respond_audio(req: tiny_http::Request, bytes: Vec<u8>, mime: &str) {
    let mut r = Response::from_data(bytes);
    r.add_header(ctype(mime));
    r.add_header(Header::from_bytes(&b"Cache-Control"[..], &b"max-age=86400"[..]).unwrap());
    let _ = req.respond(r);
}

/// Match `/sound/<id>.wav` → sound id.
pub(super) fn parse_sound_url(url: &str) -> Option<u16> {
    url.strip_prefix("/sound/")?
        .strip_suffix(".wav")?
        .parse()
        .ok()
}

pub(super) fn serve_sound(sounds: &Option<Arc<Sounds>>, id: u16, req: tiny_http::Request) {
    match sounds.as_ref().and_then(|s| s.wav(id)) {
        Some(b) => respond_audio(req, b, "audio/wav"),
        None => {
            let _ = req.respond(Response::from_string("no sound").with_status_code(404));
        }
    }
}

/// Match `/music/<id>.mp3` → music id.
pub(super) fn parse_music_url(url: &str) -> Option<u16> {
    url.strip_prefix("/music/")?
        .strip_suffix(".mp3")?
        .parse()
        .ok()
}

pub(super) fn serve_music(music: &Arc<HashMap<u16, PathBuf>>, id: u16, req: tiny_http::Request) {
    let bytes = music.get(&id).and_then(|p| std::fs::read(p).ok());
    match bytes {
        Some(b) => respond_audio(req, b, "audio/mpeg"),
        None => {
            let _ = req.respond(Response::from_string("no music").with_status_code(404));
        }
    }
}

/// Parse `Music/Digital/Config.txt` → music id → resolved `.mp3` path. Each line
/// is `<id> <name>[,loop]`; filenames omit the extension and UO is inconsistent
/// about case, so we resolve names case-insensitively against the actual files
/// found under `Music/` (mirrors ClassicUO `SoundsLoader.GetTrueFileName`).
pub(super) fn load_music_map(data_dir: &Path) -> HashMap<u16, PathBuf> {
    let music_dir = data_dir.join("Music");
    // lowercase file stem → actual path, for all .mp3 under Music/ (recursively).
    let mut by_stem: HashMap<String, PathBuf> = HashMap::new();
    let mut stack = vec![music_dir.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p
                .extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x.eq_ignore_ascii_case("mp3"))
            {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    by_stem.insert(stem.to_ascii_lowercase(), p.clone());
                }
            }
        }
    }

    let mut map = HashMap::new();
    let config = music_dir.join("Digital").join("Config.txt");
    let Ok(text) = std::fs::read_to_string(&config) else {
        return map;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Tokens split on space/comma/tab (e.g. "9 britainpos,loop").
        let mut toks = line.split([' ', ',', '\t']).filter(|s| !s.is_empty());
        let Some(id) = toks.next().and_then(|t| t.parse::<u16>().ok()) else {
            continue;
        };
        let Some(name) = toks.next() else { continue };
        // Strip any extension, then resolve case-insensitively to a real file.
        let stem = Path::new(name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(name);
        if let Some(path) = by_stem.get(&stem.to_ascii_lowercase()) {
            map.insert(id, path.clone());
        }
    }
    map
}

/// Match `/anim/<body>/<group>/<dir>/<frame>.png` → (body, group, dir, frame).
pub(super) fn parse_anim_url(url: &str) -> Option<(u16, u8, u8, u16)> {
    let mut p = url.strip_prefix("/anim/")?.split('/');
    let body = p.next()?.parse().ok()?;
    let group = p.next()?.parse().ok()?;
    let dir = p.next()?.parse().ok()?;
    let frame = p.next()?.strip_suffix(".png")?.parse().ok()?;
    Some((body, group, dir, frame))
}

/// Match `/gump/<id>.png` → gump id.
pub(super) fn parse_gump_url(url: &str) -> Option<u32> {
    url.strip_prefix("/gump/")?
        .strip_suffix(".png")?
        .parse()
        .ok()
}

/// Match `/animinfo/<body>/<group>/<dir>` → (body, group, dir).
pub(super) fn parse_animinfo_url(url: &str) -> Option<(u16, u8, u8)> {
    let mut p = url.strip_prefix("/animinfo/")?.split('/');
    Some((
        p.next()?.parse().ok()?,
        p.next()?.parse().ok()?,
        p.next()?.parse().ok()?,
    ))
}

/// Match `/idleanim/<body>` → body. Serves the fidget groups ClassicUO would
/// pick between for that body (see [`anima_assets::anim::Anim::idle_groups`]);
/// the renderer memoizes one lookup per body and owns the idle clock itself.
pub(super) fn parse_idleanim_url(url: &str) -> Option<u16> {
    url.strip_prefix("/idleanim/")?.parse().ok()
}

/// Match `/iteminfo/<graphic>` → graphic. Resolves a worn item's AnimID.
pub(super) fn parse_iteminfo_url(url: &str) -> Option<u16> {
    url.strip_prefix("/iteminfo/")?.parse().ok()
}

/// Match `/tilename/<graphic>` → graphic. Names a MAP STATIC for the renderer's
/// single-click label (see [`tile_name_json`]).
pub(super) fn parse_tilename_url(url: &str) -> Option<u16> {
    url.strip_prefix("/tilename/")?.parse().ok()
}

/// ClassicUO `StringHelper.GetPluralAdjustedString`. A tiledata name can carry
/// its own plural marker — `"slab%s% of bacon"`, `"loa%ves/f%"` — where the
/// `%`-delimited middle is either the plural suffix alone or `plural/singular`.
///
/// 216 of this install's item names use it, and none of those entries has a
/// tiledata quantity above 1, so `plural` is false for every static a click can
/// land on today. It is still a parameter rather than a baked-in `false`: the
/// marker's whole point is that it has two readings, and hiding one of them
/// inside the function would make it lie about what it implements.
pub(super) fn plural_adjusted(name: &str, plural: bool) -> String {
    if !name.contains('%') {
        return name.to_string();
    }
    // C# `Split('%', RemoveEmptyEntries)`.
    let parts: Vec<&str> = name.split('%').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        return name.to_string(); // a lone marker: not a plural form, leave it alone
    }
    let mut out = String::from(parts[0]);
    if let Some((p, sng)) = parts[1].split_once('/') {
        out.push_str(if plural { p } else { sng });
    } else if plural {
        out.push_str(parts[1]);
    }
    if parts.len() == 3 {
        out.push_str(parts[2]);
    }
    out
}

/// The display name of a map static, for the renderer's single-click label.
///
/// Statics have no serial, hence no OPL, so this is the only way the browser can
/// name one — and it is a pure per-graphic lookup, which is why it is a route and
/// not a scene field (a 49×49 window emits thousands of statics; a string on each
/// would dwarf the record).
///
/// Precedence is ClassicUO's, from the `case Static st:` arm of its no-target
/// left-click (`GameSceneInputHandler.cs:649-666`): the plural-adjusted tiledata
/// name FIRST, and cliloc `1020000 + graphic` only when that is empty — with the
/// tiledata name as that call's own default, so the two can never disagree except
/// where tiledata has nothing to say. Not the other way round, even though both
/// tables are loaded here: reversing them would silently prefer cliloc's copy,
/// which for an unnamed graphic reads `"unused"`/`"nodraw"` rather than nothing.
///
/// `null` when neither table has a name (or neither file is loaded) — the
/// renderer floats nothing rather than a fabricated label.
pub(super) fn tile_name_json(
    cliloc: Option<&Cliloc>,
    tiledata: Option<&TileData>,
    graphic: u16,
) -> String {
    let from_tiledata = tiledata
        .map(|t| plural_adjusted(&t.item_name(graphic), false))
        .filter(|n| !n.is_empty());
    let name = from_tiledata.or_else(|| {
        cliloc
            .and_then(|c| c.format(1_020_000 + graphic as u32, ""))
            .filter(|n| !n.is_empty())
    });
    serde_json::json!({ "name": name }).to_string()
}

/// Extract `c=<n>` from a raw URL query string — a light's colour index. 0 (no
/// Extract `c=<n>` from a raw URL query string — a light's colour index. 0 (no
/// colour, plain white) if absent.
/// `?fx=1` on an art URL: hue this graphic the way ClassicUO hues a graphical
/// effect (green channel indexes the ramp) rather than a sprite (red).
pub(super) fn has_fx_query(raw_url: &str) -> bool {
    raw_url
        .split('?')
        .nth(1)
        .is_some_and(|q| q.split('&').any(|kv| kv == "fx=1"))
}

/// `?fly=1` on an `/idleanim` request: the body is a gargoyle in flight, which
/// ClassicUO gives its own pair of idle groups.
pub(super) fn has_fly_query(raw_url: &str) -> bool {
    raw_url
        .split('?')
        .nth(1)
        .is_some_and(|q| q.split('&').any(|kv| kv == "fly=1"))
}

pub(super) fn parse_color_query(raw_url: &str) -> u16 {
    let Some(q) = raw_url.split('?').nth(1) else {
        return 0;
    };
    for kv in q.split('&') {
        if let Some(v) = kv.strip_prefix("c=") {
            return v.parse().unwrap_or(0);
        }
    }
    0
}

/// Extract `hue=<n>` from a raw URL query string (`...?hue=123`). 0 if absent.
pub(super) fn parse_hue_query(raw_url: &str) -> u16 {
    let Some(q) = raw_url.split('?').nth(1) else {
        return 0;
    };
    for kv in q.split('&') {
        if let Some(v) = kv.strip_prefix("hue=") {
            return v.parse().unwrap_or(0);
        }
    }
    0
}

/// JSON palette used by the ordinary dye picker. ServUO clips picker responses
/// to hues 2..=1001; ClassicUO exposes exactly those 1000 colors across five
/// 200-cell graduations. Ramp 24 is the same representative swatch used by the
/// existing `/hue/<id>.json` endpoint.
pub(super) fn dyed_palette_json(hues: Option<&Hues>) -> String {
    let colors: Vec<String> = (2u16..=1001)
        .map(|hue| {
            let c = hues.map(|h| h.color(hue, 24)).unwrap_or([0, 0, 0, 0]);
            format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
        })
        .collect();
    serde_json::json!({ "start": 2, "colors": colors }).to_string()
}

#[allow(clippy::too_many_arguments)]
pub(super) fn serve_anim(
    anim: &Option<Arc<Anim>>,
    hues: &Option<Arc<Hues>>,
    cache: &AnimCache,
    body: u16,
    group: u8,
    dir: u8,
    frame: u16,
    hue: u16,
    req: tiny_http::Request,
) {
    let key = (body, group, dir, frame, hue);
    if let Some((b, cx, cy)) = cache.lock().unwrap().get_cloned(&key) {
        return respond_png_center(req, b, cx, cy);
    }
    // Decode outside the cache lock so concurrent requests don't serialize.
    // Apply the hue (skin/clothes/hair/equipment recolor) before PNG-encoding.
    let out = anim
        .as_ref()
        .and_then(|a| a.frame(body, group, dir, frame as usize))
        .map(|(mut i, cx, cy)| {
            if hue != 0 {
                if let Some(h) = hues.as_ref() {
                    anima_assets::apply_hue(&mut i, h, hue);
                }
            }
            (i.to_png(), cx, cy)
        });
    match out {
        Some((b, cx, cy)) => {
            let weight = b.len();
            cache
                .lock()
                .unwrap()
                .insert(key, (b.clone(), cx, cy), weight);
            respond_png_center(req, b, cx, cy);
        }
        None => {
            let _ = req.respond(Response::from_string("no anim").with_status_code(404));
        }
    }
}

pub(super) fn serve_gump(
    gumps: &Option<Arc<Gumps>>,
    hues: &Option<Arc<Hues>>,
    cache: &GumpCache,
    id: u32,
    hue: u16,
    req: tiny_http::Request,
) {
    let key = (id, hue);
    if let Some(b) = cache.lock().unwrap().get_cloned(&key) {
        return respond_png(req, b);
    }
    let bytes = gumps
        .as_ref()
        .and_then(|g| {
            let img = g.get(id as usize);
            let paint = if hue != 0 {
                hue
            } else {
                g.def_hue(id as usize)
            };
            img.map(|i| (i, paint))
        })
        .map(|(mut i, paint)| {
            if paint != 0 {
                if let Some(h) = hues.as_ref() {
                    anima_assets::apply_hue(&mut i, h, paint);
                }
            }
            i.to_png()
        });
    match bytes {
        Some(b) => {
            let weight = b.len();
            cache.lock().unwrap().insert(key, b.clone(), weight);
            respond_png(req, b);
        }
        None => {
            let _ = req.respond(Response::from_string("no gump").with_status_code(404));
        }
    }
}

/// Match `/texmap/<id>.png` → texmap id.
/// Match `/light/<id>.png` → light-shape id.
pub(super) fn parse_light_url(url: &str) -> Option<u32> {
    url.strip_prefix("/light/")?
        .strip_suffix(".png")?
        .parse()
        .ok()
}

/// Serve one `light.mul` shape as a white PNG whose alpha is the intensity.
/// Native responses are uncached. The renderer retains a bounded set of decoded
/// shape/colour variants and retries failed loads.
pub(super) fn serve_light(
    lights: &Option<Arc<Lights>>,
    id: u32,
    color: u16,
    req: tiny_http::Request,
) {
    match lights
        .as_ref()
        .and_then(|l| {
            if color != 0 {
                l.light_colored(id, color)
            } else {
                l.light(id)
            }
        })
        .map(|i| i.to_png())
    {
        // `no-cache` (revalidate, not "never store"): the bytes are a pure
        // function of the data files, but a browser left to its own heuristics
        // will hold a `?c=` variant across a server change and hand back a
        // stale one — which cost an hour here, twice, once on /abilities.json
        // and once on a light that stayed white after the colour ramp landed.
        // A hundred small images revalidated once per page load is cheap.
        Some(b) => respond_png_nocache(req, b),
        None => {
            let _ = req.respond(Response::from_string("no light").with_status_code(404));
        }
    }
}

pub(super) fn parse_texmap_url(url: &str) -> Option<u16> {
    url.strip_prefix("/texmap/")?
        .strip_suffix(".png")?
        .parse()
        .ok()
}

pub(super) fn serve_texmap(
    texmaps: &Option<Arc<Texmaps>>,
    cache: &TexmapCache,
    id: u16,
    req: tiny_http::Request,
) {
    if let Some(b) = cache.lock().unwrap().get_cloned(&id) {
        return respond_png(req, b);
    }
    let bytes = texmaps
        .as_ref()
        .and_then(|t| t.texmap(id))
        .map(|i| i.to_png());
    match bytes {
        Some(b) => {
            let weight = b.len();
            cache.lock().unwrap().insert(id, b.clone(), weight);
            respond_png(req, b);
        }
        None => {
            let _ = req.respond(Response::from_string("no texmap").with_status_code(404));
        }
    }
}

/// Match `/art/land/<g>.png` or `/art/static/<g>.png` → (is_static, graphic).
pub(super) fn parse_art_url(url: &str) -> Option<(bool, u16)> {
    let rest = url.strip_prefix("/art/")?;
    let (kind, file) = rest.split_once('/')?;
    let g: u16 = file.strip_suffix(".png")?.parse().ok()?;
    match kind {
        "land" => Some((false, g)),
        "static" => Some((true, g)),
        _ => None,
    }
}

// Four asset handles plus four "which pixels" parameters. Grouping the latter
// into a struct would only move the same four values one line up at the single
// call site, so the lint is allowed rather than worked around.
#[allow(clippy::too_many_arguments)]
pub(super) fn serve_art(
    art: &Option<Arc<Mutex<Art>>>,
    hues: &Option<Arc<Hues>>,
    cache: &TileCache,
    is_static: bool,
    g: u16,
    hue: u16,
    // `?fx=1`: index the hue ramp by GREEN rather than red, which is what
    // ClassicUO's `EFFECT_HUED` shader branch does for graphical-effect art
    // (`IsometricWorld.fx:161-164` vs `:119`). Part of the cache key, since the
    // same graphic and hue give different pixels under the two rules.
    effect: bool,
    req: tiny_http::Request,
) {
    let key = (is_static, g, hue, effect);
    if let Some(b) = cache.lock().unwrap().get_cloned(&key) {
        return respond_png(req, b);
    }
    // Hold the Art lock only for the raw decode, not the PNG encode. A nonzero hue
    // (graphical effects pass `?hue=`) recolors the tile like /anim and /gump do.
    // `art.def` supplies a fallback hue when the requested index was missing.
    let bytes = art
        .as_ref()
        .and_then(|a| {
            let guard = a.lock().unwrap();
            let img = if is_static {
                guard.static_tile(g)
            } else {
                guard.land(g)
            };
            let idx = if is_static {
                anima_assets::art::static_art_index(g)
            } else {
                anima_assets::art::land_art_index(g)
            };
            let paint = if hue != 0 { hue } else { guard.def_hue(idx) };
            img.map(|i| (i, paint))
        })
        .map(|(mut i, paint)| {
            if paint != 0 {
                if let Some(h) = hues.as_ref() {
                    anima_assets::apply_hue_channel(&mut i, h, paint, effect);
                }
            }
            i.to_png()
        });
    match bytes {
        Some(b) => {
            let weight = b.len();
            cache.lock().unwrap().insert(key, b.clone(), weight);
            respond_png(req, b);
        }
        None => {
            let _ = req.respond(Response::from_string("no art").with_status_code(404));
        }
    }
}

/// Points of interest (towns, banks, shops, dungeons, moongates, shrines, …) for
/// the world map, parsed from ServUO's UOAM-style `Data/Common.map` (embedded at
/// build time). Each non-header line is `[+|-]<category>: <x> <y> <z> [name]`,
/// where the category may contain spaces (e.g. `weapons guild`). Returns a JSON
/// array string `[{"x":..,"y":..,"cat":"..","name":".."}, …]` built once at startup.
pub(super) fn parse_pois() -> String {
    const RAW: &str = include_str!("../../data/Common.map");
    let mut out: Vec<serde_json::Value> = Vec::new();
    for line in RAW.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Header is a bare count (e.g. "3"); every POI line has a "category:" head.
        let Some(colon) = line.find(':') else {
            continue;
        };
        let cat = line[..colon]
            .trim_start_matches(['+', '-'])
            .trim()
            .to_ascii_lowercase();
        if cat.is_empty() {
            continue;
        }
        let mut rest = line[colon + 1..].split_whitespace();
        let (Some(xs), Some(ys), Some(_zs)) = (rest.next(), rest.next(), rest.next()) else {
            continue;
        };
        let (Ok(x), Ok(y)) = (xs.parse::<i32>(), ys.parse::<i32>()) else {
            continue;
        };
        let name = rest.collect::<Vec<_>>().join(" ");
        out.push(serde_json::json!({ "x": x, "y": y, "cat": cat, "name": name }));
    }
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
}

/// Build the `/regions.json` body: every guarded rect tagged for facet `cur`,
/// as `[{"x":..,"y":..,"w":..,"h":..}, …]`. `facet` is omitted per-rect since
/// the whole array is already filtered to one.
pub(super) fn regions_json(rects: &[GuardRect], cur: u8) -> String {
    let mut out = String::from("[");
    let mut first = true;
    for r in rects.iter().filter(|r| r.facet == cur) {
        if !first {
            out.push(',');
        }
        first = false;
        out.push_str(&format!(
            "{{\"x\":{},\"y\":{},\"w\":{},\"h\":{}}}",
            r.x, r.y, r.w, r.h
        ));
    }
    out.push(']');
    out
}

/// Cached `GET /housecatalog` body. `pois`/`guard_rects` above are read
/// eagerly at `bind()` because every session wants a world map; the house
/// designer is opt-in and comparatively rare, so this only reads+parses the
/// eight `customhouse` catalog files ([`CustomHouseCatalog`]'s doc) on the
/// FIRST request — `OnceLock` makes every worker thread after that (and every
/// later request) just clone the cached `Arc<String>` instead of re-parsing.
pub(super) struct HouseCatalogCache {
    data_dir: PathBuf,
    once: OnceLock<Arc<String>>,
}

impl HouseCatalogCache {
    pub(super) fn new(data_dir: PathBuf) -> Self {
        HouseCatalogCache {
            data_dir,
            once: OnceLock::new(),
        }
    }

    pub(super) fn get(&self) -> Arc<String> {
        self.once
            .get_or_init(|| Arc::new(house_catalog_json(&self.data_dir)))
            .clone()
    }
}

/// Shape [`CustomHouseCatalog`] into the flat JSON `GET /housecatalog` serves.
/// Only `comment` (the style's display name) and `graphics` (its placeable
/// tile ids) survive per entry — every other column (feature masks, per-side
/// piece ids, …) only matters to how `graphics` was already assembled by
/// `anima_assets::customhouse`'s parser, so the UI never needs them. Walls,
/// misc fixtures, and roofs keep their real "category, several styles per
/// category" grouping (mirrors the in-game designer's flip-page-of-styles
/// gump); floors, doors, stairs, and teleporters are flat lists, matching
/// `CustomHouseCatalog`'s own shape (see that module's doc). A missing/
/// unreadable data directory degrades to an empty catalog (logged, not
/// fatal) — same soft-failure stance `CustomHouseCatalog::open` itself takes
/// for any one missing file.
pub(super) fn house_catalog_json(data_dir: &Path) -> String {
    let catalog = CustomHouseCatalog::open(data_dir).unwrap_or_else(|e| {
        eprintln!("play: house catalog not loaded ({e})");
        CustomHouseCatalog::default()
    });
    fn categories_json<T>(
        cats: &[anima_assets::CustomHouseCategory<T>],
        f: impl Fn(&T) -> (&str, &[u16]),
    ) -> serde_json::Value {
        let arr: Vec<serde_json::Value> = cats
            .iter()
            .map(|c| {
                let items: Vec<serde_json::Value> = c
                    .items
                    .iter()
                    .map(|it| {
                        let (comment, graphics) = f(it);
                        serde_json::json!({ "comment": comment, "graphics": graphics })
                    })
                    .collect();
                serde_json::json!({ "category": c.category, "items": items })
            })
            .collect();
        serde_json::Value::Array(arr)
    }
    fn flat_json<T>(items: &[T], f: impl Fn(&T) -> (&str, &[u16])) -> serde_json::Value {
        serde_json::Value::Array(
            items
                .iter()
                .map(|it| {
                    let (comment, graphics) = f(it);
                    serde_json::json!({ "comment": comment, "graphics": graphics })
                })
                .collect(),
        )
    }
    let body = serde_json::json!({
        "walls": categories_json(&catalog.walls, |w| (w.comment.as_str(), w.graphics.as_slice())),
        "floors": flat_json(&catalog.floors, |x| (x.comment.as_str(), x.graphics.as_slice())),
        "doors": flat_json(&catalog.doors, |x| (x.comment.as_str(), x.graphics.as_slice())),
        "misc": categories_json(&catalog.misc, |m| (m.comment.as_str(), m.graphics.as_slice())),
        "stairs": catalog.stairs.iter().map(|stair| serde_json::json!({
            "comment":stair.comment, "graphics":stair.graphics,
            "multis":[stair.multi_north,stair.multi_east,stair.multi_south,stair.multi_west],
        })).collect::<Vec<_>>(),
        "teleporters": flat_json(&catalog.teleporters, |x| (x.comment.as_str(), x.graphics.as_slice())),
        "roofs": categories_json(&catalog.roofs, |r| (r.comment.as_str(), r.graphics.as_slice())),
    });
    serde_json::to_string(&body).unwrap_or_else(|_| "{}".into())
}

#[cfg(test)]
mod art_url_tests {
    use super::parse_art_url;

    #[test]
    fn static_art_url_keeps_ids_past_0x3fff() {
        // The replay pack bug dropped statics >= 16384; the route must not.
        assert_eq!(parse_art_url("/art/static/16384.png"), Some((true, 0x4000)));
        assert_eq!(parse_art_url("/art/static/65535.png"), Some((true, 0xFFFF)));
        assert_eq!(parse_art_url("/art/land/16387.png"), Some((false, 0x4003)));
        assert_eq!(parse_art_url("/art/static/65536.png"), None);
    }
}

#[cfg(test)]
mod hue_palette_tests {
    use super::*;

    #[test]
    fn missing_assets_still_emit_complete_dyed_hue_range() {
        let value: serde_json::Value = serde_json::from_str(&dyed_palette_json(None)).unwrap();
        assert_eq!(value["start"], 2);
        let colors = value["colors"].as_array().unwrap();
        assert_eq!(colors.len(), 1000);
        assert_eq!(colors.first().unwrap(), "#000000"); // hue 2
        assert_eq!(colors.last().unwrap(), "#000000"); // hue 1001
    }

    #[test]
    fn abilities_json_lists_every_move_even_without_data_files() {
        let value: serde_json::Value =
            serde_json::from_str(&abilities_json(None, None, &[3908, 5048])).unwrap();
        let abilities = value["abilities"].as_array().unwrap();
        assert_eq!(abilities.len(), 32);
        assert_eq!(abilities[0]["id"], 1);
        assert_eq!(abilities[31]["id"], 32);
        // No cliloc → null text, not a fabricated name. The renderer already
        // carries ClassicUO's English names and falls back to them.
        assert!(abilities[0]["name"].is_null());
        // No tiledata → no item names at all, rather than empty strings that
        // would render as blank rows under an ability.
        assert_eq!(value["items"].as_object().unwrap().len(), 0);
        // Racial blocks are keyed by the 0x11 race byte and keep ClassicUO's
        // counts: 4 human, 6 elf, 5 gargoyle.
        let racial = value["racial"].as_object().unwrap();
        assert_eq!(racial["1"].as_array().unwrap().len(), 4);
        assert_eq!(racial["2"].as_array().unwrap().len(), 6);
        assert_eq!(racial["3"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn static_filters_split_trees_from_vegetation_by_impassability() {
        // With no tiledata nothing is impassable, so ClassicUO's rule files
        // *every* tree seed as vegetation and leaves the tree table empty —
        // which is exactly the degenerate case worth pinning, because it is
        // what a renderer would silently get if the data files went missing.
        let v: serde_json::Value = serde_json::from_str(&static_filters_json(None)).unwrap();
        assert!(v["trees"].as_object().unwrap().is_empty());
        let veg = v["vegetation"].as_array().unwrap();
        assert_eq!(veg.len(), VEGETATION_TILES.len() + TREE_TILES.len());
        // Cave is a plain range with one hole at 0x0550.
        let cave: Vec<u64> = v["cave"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_u64().unwrap())
            .collect();
        assert_eq!(cave.len(), 0x0553 - 0x053B); // 25 ids minus the hole
        assert!(!cave.contains(&0x0550));
        assert!(cave.contains(&0x053B) && cave.contains(&0x0553));
    }

    #[test]
    fn plural_marker_is_resolved_the_way_classicuo_resolves_it() {
        // Every shape the real tiledata actually contains, by graphic:
        // three-part (0x0976 "slab%s% of bacon"), `plural/singular` (0x0F13
        // "rub%ies/y%") and a lone unmatched marker (0x0F83).
        assert_eq!(plural_adjusted("slab%s% of bacon", false), "slab of bacon");
        assert_eq!(plural_adjusted("slab%s% of bacon", true), "slabs of bacon");
        assert_eq!(plural_adjusted("rub%ies/y%", false), "ruby");
        assert_eq!(plural_adjusted("rub%ies/y%", true), "rubies");
        // No marker at all — the overwhelming majority, including every static a
        // harvest click lands on ("tree", "cave floor").
        assert_eq!(plural_adjusted("tree", false), "tree");
        // A marker with nothing to pair it with is left EXACTLY as it is, `%`
        // and all: ClassicUO returns the string untouched when the split yields
        // fewer than two parts, and inventing a trim here would be a silent
        // divergence rather than a fix.
        assert_eq!(
            plural_adjusted("Executioner's Cap%", false),
            "Executioner's Cap%"
        );
        assert_eq!(plural_adjusted("", false), "");
    }

    #[test]
    fn tile_name_is_null_rather_than_empty_without_data_files() {
        // With neither table loaded there is no name to give, and the renderer
        // must float NOTHING rather than an empty label — so this has to be a
        // JSON null, not `""`.
        let v: serde_json::Value = serde_json::from_str(&tile_name_json(None, None, 3274)).unwrap();
        assert!(v["name"].is_null());
    }

    #[test]
    fn tilename_url_takes_only_a_graphic() {
        assert_eq!(parse_tilename_url("/tilename/3274"), Some(3274));
        assert_eq!(parse_tilename_url("/tilename/"), None);
        assert_eq!(parse_tilename_url("/tilename/-1"), None);
        assert_eq!(parse_tilename_url("/tilename/70000"), None); // past u16
        assert_eq!(parse_tilename_url("/iteminfo/3274"), None);
    }

    #[test]
    fn graphics_query_survives_junk() {
        assert_eq!(parse_graphics_query("/abilities.json"), Vec::<u16>::new());
        assert_eq!(
            parse_graphics_query("/abilities.json?g=3908,5048,3935"),
            vec![3908, 5048, 3935]
        );
        // A bad entry is dropped, not fatal — the ability text still matters.
        assert_eq!(
            parse_graphics_query("/abilities.json?g=1,,zz,70000,7"),
            vec![1, 7]
        );
    }

    #[test]
    #[ignore] // needs ~/dev/uo/uo-resource/hues.mul
    fn real_hues_mul_produces_visible_varied_picker_colors() {
        let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
        let hues = Hues::open(dir).expect("open real hues.mul");
        let value: serde_json::Value =
            serde_json::from_str(&dyed_palette_json(Some(&hues))).unwrap();
        let colors = value["colors"].as_array().unwrap();
        assert_eq!(colors.len(), 1000);
        assert!(colors.iter().any(|color| color != "#000000"));
        let unique: std::collections::HashSet<_> = colors.iter().collect();
        assert!(unique.len() > 100, "picker palette should have many colors");
    }
}

#[cfg(test)]
mod resource_limit_tests {
    use super::{read_text_limited, ByteCache};
    use std::io::Cursor;

    #[test]
    fn byte_cache_evicts_oldest_entries_to_stay_within_budget() {
        let mut cache = ByteCache::new(6);
        cache.insert(1, vec![1; 3], 3);
        cache.insert(2, vec![2; 3], 3);
        assert_eq!(cache.bytes, 6);

        cache.insert(3, vec![3; 4], 4);
        assert!(cache.get_cloned(&1).is_none());
        assert!(cache.get_cloned(&2).is_none());
        assert_eq!(cache.get_cloned(&3), Some(vec![3; 4]));
        assert_eq!(cache.bytes, 4);
    }

    #[test]
    fn byte_cache_replacement_and_oversized_values_keep_accounting_exact() {
        let mut cache = ByteCache::new(5);
        cache.insert("same", vec![1; 4], 4);
        cache.insert("same", vec![2; 2], 2);
        assert_eq!(cache.bytes, 2);
        assert_eq!(cache.order.len(), 1);

        cache.insert("too-large", vec![0; 6], 6);
        assert!(cache.get_cloned(&"too-large").is_none());
        assert_eq!(cache.bytes, 2);
    }

    #[test]
    fn body_reader_accepts_limit_and_rejects_limit_plus_one() {
        let mut exact = Cursor::new(b"1234".to_vec());
        assert_eq!(
            read_text_limited(&mut exact, 4).unwrap(),
            Some("1234".to_string())
        );

        let mut too_large = Cursor::new(b"12345".to_vec());
        assert_eq!(read_text_limited(&mut too_large, 4).unwrap(), None);
    }

    #[test]
    fn body_reader_rejects_invalid_utf8() {
        let mut invalid = Cursor::new(vec![0xFF]);
        assert!(read_text_limited(&mut invalid, 4).is_err());
    }
}

/// Ability id → cliloc for its NAME. ClassicUO's combat book tooltips the
/// primary/secondary icons with `1028838 + (ability - 1)` and the index entries
/// with the description below.
const ABILITY_NAME_CLILOC: u32 = 1028838;

/// Ability id → cliloc for its DESCRIPTION (`1061693 + (ability - 1)` in
/// ClassicUO's `CombatBookGump`).
const ABILITY_DESC_CLILOC: u32 = 1061693;

/// How many weapon special moves exist. ClassicUO stops at 32
/// (`Constants.MAX_ABILITIES_COUNT`, ending at Disrobe); ServUO's
/// `WeaponAbility.m_Abilities` has a 33rd, Cold Wind. We serve ClassicUO's 32 —
/// the extra one is an SA-era move no weapon in the client's table grants.
const ABILITY_COUNT: u32 = 32;

/// Racial abilities, per race, as ClassicUO's `RacialAbilitiesBookGump` lays
/// them out: `(first tooltip cliloc, count)` for human, elf and gargoyle. Its
/// icons run alongside at `0x5DD0`, `0x5DD4` and `0x5DDA`, and the renderer
/// carries the names, so cliloc only has to supply the descriptions.
const RACIAL_CLILOC: [(u32, u32); 3] = [(1112198, 4), (1112202, 6), (1112208, 5)];

/// The combat book's static half: every weapon special move's name and
/// description, straight out of cliloc, plus the tile name of each graphic the
/// caller asked about (`?g=3908,5048,…` — the weapons its own table says grant
/// each move).
///
/// Built on request rather than at startup because it is asked for once, when
/// the book is first opened, and the graphic list is the caller's.
pub(super) fn abilities_json(
    cliloc: Option<&Cliloc>,
    tiledata: Option<&TileData>,
    graphics: &[u16],
) -> String {
    let abilities: Vec<serde_json::Value> = (1..=ABILITY_COUNT)
        .map(|id| {
            let off = id - 1;
            serde_json::json!({
                "id": id,
                "name": cliloc.and_then(|c| c.format(ABILITY_NAME_CLILOC + off, "")),
                "desc": cliloc.and_then(|c| c.format(ABILITY_DESC_CLILOC + off, "")),
            })
        })
        .collect();
    let mut items = serde_json::Map::new();
    for &g in graphics {
        let name = tiledata.map(|t| t.item_name(g)).unwrap_or_default();
        if !name.is_empty() {
            items.insert(g.to_string(), serde_json::Value::String(name));
        }
    }
    // Racial abilities ride along in the same answer: both books are opened
    // rarely, both want cliloc text and nothing else, and one fetch beats two.
    let racial: serde_json::Map<String, serde_json::Value> = RACIAL_CLILOC
        .iter()
        .enumerate()
        .map(|(i, &(first, count))| {
            let descs: Vec<serde_json::Value> = (0..count)
                .map(|k| serde_json::json!(cliloc.and_then(|c| c.format(first + k, ""))))
                .collect();
            ((i + 1).to_string(), serde_json::Value::Array(descs))
        })
        .collect();
    serde_json::json!({ "abilities": abilities, "items": items, "racial": racial }).to_string()
}

/// Extract `g=<n>,<n>,…` from a raw URL query string. Unparsable entries are
/// dropped rather than failing the request — a client asking about a graphic
/// this data set has never heard of should still get its ability text.
pub(super) fn parse_graphics_query(raw_url: &str) -> Vec<u16> {
    let Some(q) = raw_url.split('?').nth(1) else {
        return Vec::new();
    };
    for kv in q.split('&') {
        if let Some(v) = kv.strip_prefix("g=") {
            return v.split(',').filter_map(|s| s.parse().ok()).collect();
        }
    }
    Vec::new()
}

/// ClassicUO's `StaticFilters` cave list: `0x053B..=0x0553` except `0x0550`.
const CAVE_TILES: std::ops::RangeInclusive<u16> = 0x053B..=0x0553;

/// ClassicUO's vegetation seed list (`StaticFilters.Load`, `vegetation.txt`).
const VEGETATION_TILES: &[u16] = &[
    0x0D45, 0x0D46, 0x0D47, 0x0D48, 0x0D49, 0x0D4A, 0x0D4B, 0x0D4C, 0x0D4D, 0x0D4E, 0x0D4F, 0x0D50,
    0x0D51, 0x0D52, 0x0D53, 0x0D54, 0x0D5C, 0x0D5D, 0x0D5E, 0x0D5F, 0x0D60, 0x0D61, 0x0D62, 0x0D63,
    0x0D64, 0x0D65, 0x0D66, 0x0D67, 0x0D68, 0x0D69, 0x0D6D, 0x0D73, 0x0D74, 0x0D75, 0x0D76, 0x0D77,
    0x0D78, 0x0D79, 0x0D7A, 0x0D7B, 0x0D7C, 0x0D7D, 0x0D7E, 0x0D7F, 0x0D80, 0x0D83, 0x0D87, 0x0D88,
    0x0D89, 0x0D8A, 0x0D8B, 0x0D8C, 0x0D8D, 0x0D8E, 0x0D8F, 0x0D90, 0x0D91, 0x0D93, 0x12B6, 0x12B7,
    0x12BC, 0x12BD, 0x12BE, 0x12BF, 0x12C0, 0x12C1, 0x12C2, 0x12C3, 0x12C4, 0x12C5, 0x12C6, 0x12C7,
    0x0CB9, 0x0CBC, 0x0CBD, 0x0CBE, 0x0CBF, 0x0CC0, 0x0CC1, 0x0CC3, 0x0CC5, 0x0CC6, 0x0CC7, 0x0CF3,
    0x0CF4, 0x0CF5, 0x0CF6, 0x0CF7, 0x0D04, 0x0D06, 0x0D07, 0x0D08, 0x0D09, 0x0D0A, 0x0D0B, 0x0D0C,
    0x0D0D, 0x0D0E, 0x0D0F, 0x0D10, 0x0D11, 0x0D12, 0x0D13, 0x0D14, 0x0D15, 0x0D16, 0x0D17, 0x0D18,
    0x0D19, 0x0D28, 0x0D29, 0x0D2A, 0x0D2B, 0x0D2D, 0x0D34, 0x0D36, 0x0DAE, 0x0DAF, 0x0DBA, 0x0DBB,
    0x0DBC, 0x0DBD, 0x0DBE, 0x0DC1, 0x0DC2, 0x0DC3, 0x0C83, 0x0C84, 0x0C85, 0x0C86, 0x0C87, 0x0C88,
    0x0C89, 0x0C8A, 0x0C8B, 0x0C8C, 0x0C8D, 0x0C8E, 0x0C93, 0x0C94, 0x0C98, 0x0C9F, 0x0CA0, 0x0CA1,
    0x0CA2, 0x0CA3, 0x0CA4, 0x0CA7, 0x0CAC, 0x0CAD, 0x0CAE, 0x0CAF, 0x0CB0, 0x0CB1, 0x0CB2, 0x0CB3,
    0x0CB4, 0x0CB5, 0x0CB6, 0x0C45, 0x0C46, 0x0C49, 0x0C47, 0x0C48, 0x0C4A, 0x0C4B, 0x0C4C, 0x0C4D,
    0x0C4E, 0x0C37, 0x0C38, 0x0CBA, 0x0D2F, 0x0D32, 0x0D33, 0x0D3F, 0x0D40, 0x0CE9,
];

/// ClassicUO's tree seed list, and the ones it marks "hatched" (flag 0 in
/// `tree.txt`; every other entry gets 1).
const TREE_TILES: &[u16] = &[
    0x0C95, 0x0C96, 0x0C99, 0x0C9B, 0x0C9C, 0x0C9D, 0x0C9E, 0x0CA6, 0x0CA8, 0x0CAA, 0x0CAB, 0x0CC9,
    0x0CCA, 0x0CCB, 0x0CCC, 0x0CCD, 0x0CD0, 0x0CD3, 0x0CD6, 0x0CD8, 0x0CDA, 0x0CDD, 0x0CE0, 0x0CE3,
    0x0CE6, 0x0CF8, 0x0CFB, 0x0CFE, 0x0D01, 0x0D37, 0x0D38, 0x0D41, 0x0D42, 0x0D43, 0x0D44, 0x0D57,
    0x0D58, 0x0D59, 0x0D5A, 0x0D5B, 0x0D6E, 0x0D6F, 0x0D70, 0x0D71, 0x0D72, 0x0D84, 0x0D85, 0x0D86,
    0x0D94, 0x0D98, 0x0D9C, 0x0DA0, 0x0DA4, 0x0DA8, 0x12B6, 0x12B7, 0x12B8, 0x12B9, 0x12BA, 0x12BB,
    0x12BC, 0x12BD,
];
const TREE_HATCHED: &[u16] = &[
    0x0C9E, 0x0CA8, 0x0CAA, 0x0CAB, 0x0CC9, 0x0CF8, 0x0CFB, 0x0CFE, 0x0D01, 0x12B6, 0x12B7, 0x12B8,
    0x12B9, 0x12BA, 0x12BB,
];

/// ClassicUO's static-tile classification, resolved against real tiledata.
///
/// Its `StaticFilters.Load` writes three text files the first time it runs and
/// reads them back; the interesting part is not the files but the rule it
/// applies while writing them: **a "tree" that is not `IsImpassable` is filed as
/// vegetation instead**, and a vegetation seed that *is* impassable is dropped
/// altogether. So the split depends on tiledata, which is why this is resolved
/// here rather than hardcoded in the renderer — the browser has no tiledata.
///
/// Rocks and the spell fields are ranges rather than tables (`IsRock`,
/// `IsFireField` and friends), so they stay in the renderer as the formulas
/// they are.
pub(super) fn static_filters_json(tiledata: Option<&TileData>) -> String {
    let impassable = |g: u16| {
        tiledata.is_some_and(|t| t.item_flags(g) & anima_assets::tiledata::flags::IMPASSABLE != 0)
    };
    let cave: Vec<u16> = CAVE_TILES.filter(|&g| g != 0x0550).collect();
    let mut vegetation: Vec<u16> = VEGETATION_TILES
        .iter()
        .copied()
        .filter(|&g| !impassable(g))
        .collect();
    let mut trees = serde_json::Map::new();
    for &g in TREE_TILES {
        if impassable(g) {
            let hatched = u8::from(!TREE_HATCHED.contains(&g));
            trees.insert(g.to_string(), serde_json::json!(hatched));
        } else {
            // Not impassable → ClassicUO files it as vegetation, not a tree.
            vegetation.push(g);
        }
    }
    serde_json::json!({ "cave": cave, "vegetation": vegetation, "trees": trees }).to_string()
}

/// `/font/ascii/{font}/{ch}.png` or `/font/uni/{font}/{ch}.png`.
pub(super) fn parse_font_glyph_url(url: &str) -> Option<(bool, usize, u32)> {
    let rest = url.strip_prefix("/font/")?;
    let (kind, rest) = rest.split_once('/')?;
    let uni = match kind {
        "ascii" => false,
        "uni" => true,
        _ => return None,
    };
    let (font, rest) = rest.split_once('/')?;
    let ch = rest.strip_suffix(".png")?;
    let font = font.parse().ok()?;
    let ch = if let Some(hex) = ch.strip_prefix("0x").or_else(|| ch.strip_prefix("0X")) {
        u32::from_str_radix(hex, 16).ok()?
    } else {
        ch.parse().ok()?
    };
    Some((uni, font, ch))
}

pub(super) fn serve_font_glyph(
    fonts: &Option<Arc<Fonts>>,
    uni: bool,
    font: usize,
    ch: u32,
    req: tiny_http::Request,
) {
    let Some(fonts) = fonts else {
        let _ = req.respond(Response::from_string("no fonts").with_status_code(404));
        return;
    };
    let img = if uni {
        fonts.unicode_glyph(font, ch)
    } else {
        fonts.ascii_glyph(font, ch as u8).cloned()
    };
    match img {
        Some(img) => respond_png(req, img.to_png()),
        None => {
            let _ = req.respond(Response::from_string("no glyph").with_status_code(404));
        }
    }
}

pub(super) fn serve_font_text(fonts: &Option<Arc<Fonts>>, raw_url: &str, req: tiny_http::Request) {
    let Some(fonts) = fonts else {
        let _ = req.respond(Response::from_string("no fonts").with_status_code(404));
        return;
    };
    let q = raw_url.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut font = 0usize;
    let mut uni = true;
    let mut text = String::new();
    for pair in q.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "font" => font = v.parse().unwrap_or(0),
            "uni" => uni = v != "0",
            "t" => {
                text = urlencoding_decode(v);
            }
            _ => {}
        }
    }
    match fonts.render_text(font, uni, &text) {
        Some(img) => respond_png(req, img.to_png()),
        None => {
            let _ = req.respond(Response::from_string("empty").with_status_code(404));
        }
    }
}

fn urlencoding_decode(s: &str) -> String {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) =
                u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `/tileart/stack/{graphic}/{amount}`
pub(super) fn parse_tileart_stack_url(url: &str) -> Option<(u16, u32)> {
    let rest = url.strip_prefix("/tileart/stack/")?;
    let (g, amount) = rest.split_once('/')?;
    Some((g.parse().ok()?, amount.parse().ok()?))
}

#[cfg(test)]
mod housing_catalog_tests {
    use super::*;

    #[test]
    fn stair_catalog_keeps_multi_ids_distinct_from_preview_art() {
        let dir = std::env::temp_dir().join(format!("anima-stair-catalog-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("stairs.txt"), "0\t1848\t1849\t1852\t1851\t1850\t1856\t1854\t1862\t1861\t7600\t7601\t7602\t7603\t0\tDark Wood\n").unwrap();
        let value: serde_json::Value = serde_json::from_str(&house_catalog_json(&dir)).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
        assert_eq!(
            value["stairs"][0]["multis"],
            serde_json::json!([7600, 7601, 7602, 7603])
        );
        assert_eq!(value["stairs"][0]["graphics"][0], 1856);
        assert_eq!(value["stairs"][0]["graphics"][4], 1848);
    }
}
