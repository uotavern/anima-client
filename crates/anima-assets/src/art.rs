//! UO tile art reader: land tiles (44×44 diamond) and static tiles (RLE),
//! decoding ARGB1555 → RGBA8. From `artLegacyMUL.uop`.
//!
//! Land art index = land graphic (0..0x3FFF); static art index = 0x4000 + graphic.

use std::collections::HashMap;
use std::io::{self, Write};
use std::path::Path;

use crate::def::parse_alias_def;
use crate::idxmul::IdxMul;
use crate::uop::UopReader;

const LAND_DIM: usize = 44;

/// A decoded RGBA8 image.
#[derive(Clone)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Image {
    /// Encode as a PNG (for serving to the web renderer).
    pub fn to_png(&self) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, self.width.max(1), self.height.max(1));
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().expect("png header");
            w.write_image_data(&self.rgba).expect("png data");
        }
        out
    }

    /// Any non-transparent pixel?
    pub fn is_empty(&self) -> bool {
        self.rgba.chunks_exact(4).all(|p| p[3] == 0)
    }
}

/// ARGB1555 (UO 16-bit) → RGBA8, **always opaque** — the rule for *land*.
///
/// Land and statics decode the same 16-bit colour but disagree about zero, and
/// getting that backwards is invisible in the obvious places. A static carries
/// its transparency as `0x0000` pixels; a land tile's shape is the diamond and
/// nothing else, so a zero inside the diamond is a genuinely **black pixel**.
/// ClassicUO makes the split explicit — `LoadLand` writes
/// `Color16To32(...) | 0xFF_00_00_00`, forcing alpha on with no test at all,
/// while `LoadArt` guards each run with `if (val != 0)`.
///
/// Treating land's zeros as transparent punches pinholes through the ground.
/// Measured against the real `artLegacyMUL.uop`: **361 of 851 land tiles
/// (42.4%) contain at least one**, 25,877 pixels in total — three to six on an
/// ordinary grass tile (0x0003, 0x0004, 0x0005). At that size they read as
/// dark speckle in the texture rather than as holes, which is why this
/// survives a screenshot.
fn argb1555_land(c: u16) -> [u8; 4] {
    let [r, g, b, _] = argb1555(c);
    [r, g, b, 255]
}

/// ARGB1555 (UO 16-bit) → RGBA8. Color 0 is transparent — the rule for
/// *statics*; land uses [`argb1555_land`], and the difference is load-bearing.
fn argb1555(c: u16) -> [u8; 4] {
    if c == 0 {
        return [0, 0, 0, 0];
    }
    let r = ((c >> 10) & 0x1F) as u8;
    let g = ((c >> 5) & 0x1F) as u8;
    let b = (c & 0x1F) as u8;
    // 5→8 bit expansion (replicate high bits into low).
    [
        (r << 3) | (r >> 2),
        (g << 3) | (g >> 2),
        (b << 3) | (b >> 2),
        255,
    ]
}

fn rd_u16(d: &[u8], p: usize) -> u16 {
    u16::from_le_bytes([d[p], d[p + 1]])
}

/// First static art index: land graphics fill `0..0x4000`, statics follow.
pub const STATIC_ART_BASE: usize = 0x4000;

/// Every art index a graphic can name: the land range plus a full `u16` of
/// statics. Later expansions (Stygian Abyss, High Seas, Time of Legends) put
/// statics well past 0x3FFF, e.g. the Lost Lands Coliseum's 0x4301..0x4DDF,
/// so stopping at `0x8000` silently drops them.
pub const ART_INDEX_COUNT: usize = STATIC_ART_BASE + 0x1_0000;

/// Write art entries `0..count` as a legacy `artidx.mul` + `art.mul` pair.
/// `read(index)` supplies an entry's raw bytes, or `None` for an empty slot.
/// Returns the number of entries written with data.
pub fn write_legacy_art(
    count: usize,
    mut read: impl FnMut(usize) -> Option<Vec<u8>>,
    idx: &mut impl Write,
    mul: &mut impl Write,
) -> io::Result<usize> {
    let mut offset = 0u32;
    let mut present = 0usize;
    for i in 0..count {
        match read(i) {
            Some(bytes) => {
                let len = u32::try_from(bytes.len()).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "art entry too large")
                })?;
                idx.write_all(&offset.to_le_bytes())?;
                idx.write_all(&len.to_le_bytes())?;
                idx.write_all(&0u32.to_le_bytes())?;
                mul.write_all(&bytes)?;
                offset = offset.checked_add(len).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "art.mul exceeds 4 GiB")
                })?;
                present += 1;
            }
            None => idx.write_all(&[255; 12])?,
        }
    }
    Ok(present)
}

enum ArtSource {
    Uop(UopReader),
    Mul(IdxMul),
}

pub struct Art {
    source: ArtSource,
    /// `art.def`: missing index → first present group member + hue.
    aliases: HashMap<u32, (Vec<u32>, u16)>,
    avg_cache: HashMap<u16, [u8; 4]>,
}

impl Art {
    pub fn open(resource_dir: impl AsRef<Path>) -> std::io::Result<Art> {
        let dir = resource_dir.as_ref();
        let source = if dir.join("artLegacyMUL.uop").is_file() {
            ArtSource::Uop(UopReader::open(&dir.join("artLegacyMUL.uop"))?)
        } else {
            ArtSource::Mul(IdxMul::open(dir.join("artidx.mul"), dir.join("art.mul"))?)
        };
        Ok(Art {
            source,
            aliases: std::fs::read_to_string(dir.join("art.def"))
                .map(|t| parse_alias_def(&t))
                .unwrap_or_default(),
            avg_cache: HashMap::new(),
        })
    }

    fn raw(&self, index: usize) -> Option<Vec<u8>> {
        match &self.source {
            ArtSource::Uop(u) => u.by_art(index),
            ArtSource::Mul(m) => m.read(index).map(|(b, _)| b),
        }
    }

    /// Bytes for `index`, or the first `art.def` alias that exists.
    /// The `u16` is the def hue (0 when the primary index was present).
    fn resolve(&self, index: usize) -> Option<(Vec<u8>, u16)> {
        if let Some(data) = self.raw(index) {
            return Some((data, 0));
        }
        let (group, hue) = self.aliases.get(&(index as u32))?;
        for &alt in group {
            if let Some(data) = self.raw(alt as usize) {
                return Some((data, *hue));
            }
        }
        None
    }

    fn has(&self, index: usize) -> bool {
        match &self.source {
            ArtSource::Uop(u) => u.has_art(index),
            ArtSource::Mul(m) => m.entry(index).is_some(),
        }
    }

    /// Hue `art.def` wants applied when this index was missing and aliased.
    pub fn def_hue(&self, index: usize) -> u16 {
        if self.has(index) {
            return 0;
        }
        self.aliases
            .get(&(index as u32))
            .map(|(_, h)| *h)
            .unwrap_or(0)
    }

    /// Decode a land tile (graphic 0..0x3FFF) to a 44×44 RGBA image.
    pub fn land(&self, graphic: u16) -> Option<Image> {
        let (data, _) = self.resolve((graphic & 0x3FFF) as usize)?;
        let mut rgba = vec![0u8; LAND_DIM * LAND_DIM * 4];
        let mut p = 0usize;
        let put = |x: usize, y: usize, c: u16, rgba: &mut [u8]| {
            // Opaque, always — see `argb1555_land`. Pixels the loops below never
            // visit stay at the buffer's initial zero, which is what makes the
            // four corners *outside* the diamond transparent.
            let px = argb1555_land(c);
            let o = (y * LAND_DIM + x) * 4;
            rgba[o..o + 4].copy_from_slice(&px);
        };
        // Top half: rows widen 2,4,…,44.
        for i in 0..22 {
            let count = (i + 1) * 2;
            let start = 22 - (i + 1);
            for j in 0..count {
                if p + 2 > data.len() {
                    return Some(Image {
                        width: 44,
                        height: 44,
                        rgba,
                    });
                }
                put(start + j, i, rd_u16(&data, p), &mut rgba);
                p += 2;
            }
        }
        // Bottom half: rows narrow 44,…,2.
        for i in 0..22 {
            let count = (22 - i) * 2;
            let start = i;
            for j in 0..count {
                if p + 2 > data.len() {
                    break;
                }
                put(start + j, 22 + i, rd_u16(&data, p), &mut rgba);
                p += 2;
            }
        }
        Some(Image {
            width: 44,
            height: 44,
            rgba,
        })
    }

    /// Average opaque color of a land tile, `[r, g, b, 255]` (cached).
    /// Falls back to mid-gray when the tile can't be decoded.
    pub fn land_avg_color(&mut self, graphic: u16) -> [u8; 4] {
        if let Some(c) = self.avg_cache.get(&graphic) {
            return *c;
        }
        let color = self
            .land(graphic)
            .map(|img| average_opaque(&img.rgba))
            .unwrap_or([90, 90, 90, 255]);
        self.avg_cache.insert(graphic, color);
        color
    }

    /// Decode a static tile (graphic, art index 0x4000+graphic) to RGBA.
    pub fn static_tile(&self, graphic: u16) -> Option<Image> {
        let (data, _) = self.resolve(STATIC_ART_BASE + graphic as usize)?;
        if data.len() < 8 {
            return None;
        }
        // Header: u32 flags/unknown, then width u16, height u16.
        let width = rd_u16(&data, 4) as usize;
        let height = rd_u16(&data, 6) as usize;
        if width == 0 || height == 0 || width > 1024 || height > 1024 {
            return None;
        }
        let lookup_start = 8;
        let data_start = lookup_start + height * 2;
        if data_start > data.len() {
            return None;
        }
        let mut rgba = vec![0u8; width * height * 4];
        for y in 0..height {
            let off = rd_u16(&data, lookup_start + y * 2) as usize;
            let mut pos = data_start + off * 2;
            let mut x = 0usize;
            loop {
                if pos + 4 > data.len() {
                    break;
                }
                let x_offset = rd_u16(&data, pos) as usize;
                let x_run = rd_u16(&data, pos + 2) as usize;
                pos += 4;
                if x_offset == 0 && x_run == 0 {
                    break; // end of scanline
                }
                x += x_offset;
                for _ in 0..x_run {
                    if pos + 2 > data.len() || x >= width {
                        break;
                    }
                    let c = rd_u16(&data, pos);
                    pos += 2;
                    if y < height && x < width {
                        let o = (y * width + x) * 4;
                        rgba[o..o + 4].copy_from_slice(&argb1555(c | 0x8000));
                    }
                    x += 1;
                }
            }
        }
        Some(Image {
            width: width as u32,
            height: height as u32,
            rgba,
        })
    }
}

fn average_opaque(rgba: &[u8]) -> [u8; 4] {
    let (mut r, mut g, mut b, mut n) = (0u64, 0u64, 0u64, 0u64);
    for px in rgba.chunks_exact(4) {
        if px[3] != 0 {
            r += px[0] as u64;
            g += px[1] as u64;
            b += px[2] as u64;
            n += 1;
        }
    }
    if n == 0 {
        return [90, 90, 90, 255];
    }
    [(r / n) as u8, (g / n) as u8, (b / n) as u8, 255]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn land_diamond_is_opaque_and_only_its_corners_are_not() {
        // A synthetic 44x44 land tile is 1012 pixels of colour, and this one is
        // ALL zeros — the worst case for the bug this pins. Every pixel inside
        // the diamond must come out opaque black; only the four corners outside
        // it stay transparent. Reading zero as transparency instead puts holes
        // through the ground (see `argb1555_land`).
        let mut rgba = vec![0u8; 44 * 44 * 4];
        let put = |x: usize, y: usize, c: u16, rgba: &mut [u8]| {
            let px = argb1555_land(c);
            let o = (y * 44 + x) * 4;
            rgba[o..o + 4].copy_from_slice(&px);
        };
        let mut inside = 0usize;
        for i in 0..22usize {
            let (count, start) = ((i + 1) * 2, 22 - (i + 1));
            for j in 0..count {
                put(start + j, i, 0, &mut rgba);
                inside += 1;
            }
        }
        for i in 0..22usize {
            let (count, start) = ((22 - i) * 2, i);
            for j in 0..count {
                put(start + j, 22 + i, 0, &mut rgba);
                inside += 1;
            }
        }
        assert_eq!(inside, 1012, "the diamond covers 1012 of 1936 pixels");
        let opaque = rgba.chunks_exact(4).filter(|p| p[3] == 255).count();
        assert_eq!(
            opaque, inside,
            "every pixel inside the diamond must be opaque"
        );
        // And the colour really is black, not some accidental fill.
        assert_eq!(&rgba[(22 * 44 + 22) * 4..][..4], &[0, 0, 0, 255]);
    }

    /// One-pixel static: header, one lookup offset, a run of one colour, end.
    fn one_pixel_static(colour: u16) -> Vec<u8> {
        let mut d = vec![0u8; 4];
        for v in [1u16, 1, 0, 0, 1, colour, 0, 0] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d
    }

    #[test]
    fn legacy_art_pack_keeps_statics_past_0x3fff() {
        // The replay asset server returned 404 for every static >= 16384 because
        // the arena pack stopped at art index 0x8000. Statics up to 0xFFFF must
        // survive a pack and decode from the resulting MUL pair.
        let wanted = [0u16, 16383, 16384, 17153, 19935, 0xFFFF];
        let mut idx = Vec::new();
        let mut mul = Vec::new();
        let present = write_legacy_art(
            ART_INDEX_COUNT,
            |i| {
                let g = i.checked_sub(STATIC_ART_BASE)?;
                wanted
                    .contains(&(g as u16))
                    .then(|| one_pixel_static(0x7C00))
            },
            &mut idx,
            &mut mul,
        )
        .unwrap();
        assert_eq!(present, wanted.len());
        assert_eq!(idx.len(), ART_INDEX_COUNT * 12);

        let dir = std::env::temp_dir().join(format!("anima_art_pack_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("artidx.mul"), &idx).unwrap();
        std::fs::write(dir.join("art.mul"), &mul).unwrap();
        let art = Art::open(&dir).unwrap();
        for g in wanted {
            let img = art
                .static_tile(g)
                .unwrap_or_else(|| panic!("static {g} missing"));
            assert_eq!((img.width, img.height), (1, 1));
            assert_eq!(img.rgba[3], 255, "static {g} pixel should be opaque");
        }
        assert!(art.static_tile(16385).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn static_zero_stays_transparent() {
        // The other half of the split: statics DO carry transparency as zero.
        assert_eq!(argb1555(0), [0, 0, 0, 0]);
        assert_eq!(argb1555_land(0), [0, 0, 0, 255]);
        // Non-zero colours are identical either way.
        assert_eq!(argb1555(0x7FFF), argb1555_land(0x7FFF));
    }

    #[test]
    #[ignore] // needs ~/dev/uo/uo-resource
    fn land_avg_is_greenish_for_grass() {
        let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
        let mut art = Art::open(&dir).expect("open art");
        for g in [0x0003u16, 0x0006, 0x00A8] {
            println!("land 0x{:04X}: avg={:?}", g, art.land_avg_color(g));
        }
        // Grass (0x0003/0x0006): green channel should dominate red and blue.
        let c = art.land_avg_color(0x0006);
        assert_ne!(
            c,
            [90, 90, 90, 255],
            "land 0x0006 should decode, not fall back"
        );
        assert!(c[1] >= c[0] && c[1] >= c[2], "expected greenish, got {c:?}");

        // Land tile encodes to a valid PNG (signature check).
        let png = art.land(0x0003).unwrap().to_png();
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);

        // Static decode works on real data: scan a range, expect several
        // non-empty sprites with sane dimensions.
        let mut decoded = 0;
        for g in 0u16..400 {
            if let Some(img) = art.static_tile(g) {
                if !img.is_empty() && img.width <= 256 && img.height <= 256 {
                    decoded += 1;
                }
            }
        }
        println!("static tiles decoded non-empty in 0..400: {decoded}");
        assert!(
            decoded > 20,
            "expected many decodable statics, got {decoded}"
        );
    }
}
