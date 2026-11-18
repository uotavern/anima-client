//! Build legacy art (every land and static index) and the lightning gump subset
//! for the arena replay renderer from installed UO files.
//! Assets remain local deployment data; never commit the generated files.
use anima_assets::art::{write_legacy_art, ART_INDEX_COUNT};
use anima_assets::uop::UopReader;
use std::{
    fs::{self, File},
    io::{self, BufWriter, Write},
    path::PathBuf,
};
fn main() -> io::Result<()> {
    let mut args = std::env::args().skip(1);
    let source = PathBuf::from(args.next().expect("source UO directory"));
    let out = PathBuf::from(args.next().expect("output directory"));
    fs::create_dir_all(&out)?;
    let art = UopReader::open(&source.join("artLegacyMUL.uop"))?;
    let mut idx = BufWriter::new(File::create(out.join("artidx.mul"))?);
    let mut mul = BufWriter::new(File::create(out.join("art.mul"))?);
    // All of land plus every u16 static: arena scenery such as the Lost Lands
    // Coliseum uses statics past 0x3FFF, which a 0x8000 cut silently dropped.
    let present = write_legacy_art(ART_INDEX_COUNT, |i| art.by_art(i), &mut idx, &mut mul)?;
    idx.flush()?;
    mul.flush()?;
    let gumps = UopReader::open(&source.join("gumpartLegacyMUL.uop"))?;
    let mut idx = File::create(out.join("gumpidx.mul"))?;
    let mut mul = File::create(out.join("gumpart.mul"))?;
    let mut offset = 0u32;
    for i in 0..20010 {
        if (20000..20010).contains(&i) {
            if let Some((bytes, w, h)) = gumps.by_gump(i) {
                idx.write_all(&offset.to_le_bytes())?;
                idx.write_all(&(bytes.len() as u32).to_le_bytes())?;
                idx.write_all(&(w | (h << 16)).to_le_bytes())?;
                mul.write_all(&bytes)?;
                offset += bytes.len() as u32;
                continue;
            }
        }
        idx.write_all(&[255; 12])?;
    }
    println!(
        "{present} art entries and lightning gumps extracted to {}",
        out.display()
    );
    Ok(())
}
