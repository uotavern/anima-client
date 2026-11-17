use anima_assets::MapData;
use anima_core::{agent::survey_terrain, world::Item, World};
use anima_session::pathing::{MapTerrain, SurveyTerrain, TileScan};
use std::{collections::HashSet, time::Instant};

#[test]
#[ignore = "requires ANIMA_DATA_DIR with licensed UO map assets"]
fn survey_scan_preserves_dynamic_blockers_and_refreshes_between_observations() {
    let dir = std::env::var("ANIMA_DATA_DIR").expect("ANIMA_DATA_DIR");
    let mut map = MapData::open(dir).unwrap();
    let mut world = World::new();
    let blocked = HashSet::new();
    let mut old_us = 0;
    let mut new_us = 0;
    for center in [(1224, 1717), (3753, 2765), (1495, 1628)] {
        world.items.clear();
        for n in 0..200_u32 {
            let mut item = Item {
                serial: n + 1,
                graphic: [0x0e3c, 0x0675, 0x0080, 0x0f0d][n as usize % 4],
                ..Item::default()
            };
            item.pos.x = center.0 - 10 + (n % 21) as u16;
            item.pos.y = center.1 - 10 + (n / 21) as u16;
            world.items.insert(item.serial, item);
        }
        // Warm map blocks before timing either implementation.
        survey_terrain(
            &mut MapTerrain {
                world: &world,
                map: &mut map,
                blocked: &blocked,
                multis: None,
            },
            center,
            0,
            4,
        );
        // Rebuild after removals, moves, door graphics and container changes.
        for revision in 0..20 {
            if let Some(item) = world.items.get_mut(&100) {
                item.pos.x = center.0 + revision % 4;
                item.graphic = if revision % 2 == 0 { 0x0675 } else { 0x0676 };
                item.container = if revision % 3 == 0 { Some(999) } else { None };
            }
            world.items.remove(&(revision as u32 + 1));
            let start = Instant::now();
            let before = survey_terrain(
                &mut MapTerrain {
                    world: &world,
                    map: &mut map,
                    blocked: &blocked,
                    multis: None,
                },
                center,
                0,
                4,
            );
            old_us += start.elapsed().as_micros();
            let start = Instant::now();
            let scan = TileScan::build(&world, &map);
            let after = survey_terrain(
                &mut SurveyTerrain {
                    scan,
                    map: &mut map,
                },
                center,
                0,
                4,
            );
            new_us += start.elapsed().as_micros();
            assert_eq!(before, after, "center={center:?} revision={revision}");
        }
    }
    eprintln!("60 surveys: original={old_us}us scanned={new_us}us");
}
