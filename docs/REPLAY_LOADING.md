# Replay loading

The viewer starts terrain loading alongside appearance metadata and warms only
its first second of combat. Playback prefetches ten seconds ahead. If an effect
needed at the next timestamp is missing, the replay clock waits; seek also waits
before marking those effects as spawned. This preserves short projectile effects
without downloading every effect before showing the arena.

Optional metadata bundle (no private data or match dialogue):

```sh
python3 scripts/build_replay_pack.py --metadata-only \
  --output /opt/uoarena/replay-client/web/combat-metadata.json
```

Run beside the loopback asset/feed services after changing UO resources or to
include newer appearances. The default reads the latest 30 complete recordings.
Missing bundle entries use normal endpoints. A missing bundle has a four-second
budget and does not prevent playback. The viewer exposes `data-replay-load-ms`
on the body for readiness timing; this does not measure every terrain/mobile
texture becoming visible. Cold cache and slow connections can still buffer.

Focused regression gate: `node web/test/run.js replay texture-cache`.
