//! Build a legacy art/gump subset for a pre-AOS arena renderer from installed UO files.
//! Assets remain local deployment data; never commit the generated files.
use anima_assets::uop::UopReader;
use std::{
    fs::{self, File},
    io::{self, Write},
    path::PathBuf,
};
fn main() -> io::Result<()> {
    let mut args = std::env::args().skip(1);
    let source = PathBuf::from(args.next().expect("source UO directory"));
    let out = PathBuf::from(args.next().expect("output directory"));
    fs::create_dir_all(&out)?;
    let art = UopReader::open(&source.join("artLegacyMUL.uop"))?;
    let mut idx = File::create(out.join("artidx.mul"))?;
    let mut mul = File::create(out.join("art.mul"))?;
    let mut offset = 0u32;
    for i in 0..0x8000 {
        if let Some(bytes) = art.by_art(i) {
            idx.write_all(&offset.to_le_bytes())?;
            idx.write_all(&(bytes.len() as u32).to_le_bytes())?;
            idx.write_all(&0u32.to_le_bytes())?;
            mul.write_all(&bytes)?;
            offset += bytes.len() as u32;
        } else {
            idx.write_all(&[255; 12])?;
        }
    }
    let gumps = UopReader::open(&source.join("gumpartLegacyMUL.uop"))?;
    let mut idx = File::create(out.join("gumpidx.mul"))?;
    let mut mul = File::create(out.join("gumpart.mul"))?;
    let mut offset = 0u32;
    for i in 0..20010 {
        if (20000..20010).contains(&i) {
            if let Some((bytes, w, h)) = gumps.by_gump(i) {
                idx.write_all(&offset.to_le_bytes())?;
                idx.write_all(&(bytes.len() as u32).to_le_bytes())?;
                idx.write_all(&((w << 16) | h).to_le_bytes())?;
                mul.write_all(&bytes)?;
                offset += bytes.len() as u32;
                continue;
            }
        }
        idx.write_all(&[255; 12])?;
    }
    println!(
        "Pre-AOS art and lightning gumps extracted to {}",
        out.display()
    );
    Ok(())
}
