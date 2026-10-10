# Replay motion investigation and correction

Branch `fix/replay-motion`, based on deployed `8cc6f18`. Public replay renderer
was hash-verified before replacement. No shard binary or recording mutation.

## Root cause

`replayMobile` selected the latest status sample as a movement origin, then
searched forward for a different position. A 200ms heartbeat inside a step
restarted interpolation at the old tile, producing a backward snap. Movement
also used the preceding state's direction and wall-clock gait phase.

Separate cached movement segments now ignore identical-location heartbeat
samples. Each adjacent arrival uses a bounded 200ms run / 400ms walk interval,
clamped to its prior arrival. Travel faces the arriving direction, and gait
phase is derived from distance covered with the same cadence as the live client.
Round/phase transitions, death, paralysis and non-adjacent jumps do not glide.
Binary search makes seeking deterministic; HP/mana/stamina still use recorded
status samples. Older recordings benefit without rerecording.

## Record / replay validation

1. Existing `d5936caf35e4424eaf9ff5ac51f492a9`: 7 unchanged-position sample
   discontinuities (>0.05 tile), maximum 0.68366 tile, become 0.
2. Fresh dedicated unranked punch probe, unit `arena-motion-review-20261006`,
   captured `55f1f274a9074cd8acad806065bf7c21`: 6 discontinuities, maximum
   0.90130 tile, become 0. Original match and replay data preserved.
3. Chrome: existing replay seeks at 9.7/9.8 seconds; new replay played at normal
   speed, rewound and replayed at 0.5x and 2x; pause, labels, spell effects and
   potion timer retained. Renderer replay clock drives motion at each speed.
4. `node web/test/run.js replay`: 23 tests / 84 assertions pass, including actual
   heartbeat regression geometry, destination facing, teleport/round guard,
   paralysis, deterministic seek and existing replay behavior.
5. `node scripts/check-web-globals.mjs`: all 21 shared-scope scripts compile.

Reproduce the numerical checks with `scripts/check-replay-motion.cjs FILE...`.
Raw comparison results are in `2026-10-06-replay-motion-results.jsonl`.

## Deployment

Changed only `/opt/uoarena/replay-client/web/js/15-replay.js` and its query version
in `web/index.html` (`replay-motion-16`). Backups with `.before-motion-20261006`
suffixes remain adjacent. No game service restart. This fixes interpolation
jitter; it does not invent movement in genuinely sparse or teleported records.
