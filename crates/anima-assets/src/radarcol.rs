//! Radar/world-map color table reader (`radarcol.mul`).
//!
//! The canonical UO radar color palette used by the in-game world map. Layout:
//! indices `0..0x4000` are LAND colors (by land graphic & 0x3FFF); indices
//! `0x4000+` are STATIC colors (by static graphic + 0x4000). Each entry is a
//! little-endian u16 ARGB1555 (bit15 = alpha, then 5/5/5 RGB), expanded to RGB8.
//! Std-only / no deps (keeps it WASM-clean).

use std::path::Path;

/// The radar color table from `radarcol.mul`.
pub struct RadarCol {
    /// One ARGB1555 entry per index (land 0..0x4000, statics 0x4000+).
    colors: Vec<u16>,
}

impl RadarCol {
    /// Open `radarcol.mul` from a UO data directory.
    pub fn open(resource_dir: impl AsRef<Path>) -> std::io::Result<RadarCol> {
        let bytes = std::fs::read(resource_dir.as_ref().join("radarcol.mul"))?;
        let colors = bytes
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        Ok(RadarCol { colors })
    }

    /// Radar color for a land graphic (index `graphic & 0x3FFF`).
    pub fn land_color(&self, graphic: u16) -> [u8; 3] {
        self.rgb(crate::art::land_art_index(graphic))
    }

    /// Radar color for a static graphic (index `0x4000 + graphic`). Out-of-range
    /// → black `[0, 0, 0]`.
    pub fn static_color(&self, graphic: u16) -> [u8; 3] {
        self.rgb(crate::art::static_art_index(graphic))
    }

    /// ARGB1555 (LE u16) at `idx` → RGB8 (standard 5→8 expansion); OOB → black.
    fn rgb(&self, idx: usize) -> [u8; 3] {
        let Some(&c) = self.colors.get(idx) else {
            return [0, 0, 0];
        };
        let r = ((c >> 10) & 0x1F) as u8;
        let g = ((c >> 5) & 0x1F) as u8;
        let b = (c & 0x1F) as u8;
        [
            (r << 3) | (r >> 2),
            (g << 3) | (g >> 2),
            (b << 3) | (b >> 2),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_argb1555_and_oob() {
        // 0x7FFF = all 5-bit channels max → white; index past the table → black.
        let rc = RadarCol {
            colors: vec![0x7FFF],
        };
        assert_eq!(rc.land_color(0), [255, 255, 255]);
        assert_eq!(rc.static_color(0), [0, 0, 0]); // index 0x4000 is OOB here
    }

    #[test]
    #[ignore] // needs ~/dev/uo/uo-resource/radarcol.mul
    fn reads_real_radarcol() {
        let dir = format!("{}/dev/uo/uo-resource", std::env::var("HOME").unwrap());
        let rc = RadarCol::open(&dir).expect("open radarcol");
        // Land index 0 decodes to *some* color; a wildly OOB static is black.
        println!(
            "land(0)={:?} static(0xFFFF)={:?}",
            rc.land_color(0),
            rc.static_color(0xFFFF)
        );
        assert_eq!(rc.static_color(0xFFFF), [0, 0, 0]);
    }
}
