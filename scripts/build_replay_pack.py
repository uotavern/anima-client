#!/usr/bin/env python3
"""Bundle recent replays' immutable UO effect art and appearance metadata.
Run beside the asset service after updating game data; unknown assets fall back
normally. No accounts, replay speech or match data are included in the pack.
"""
import argparse
import base64
import json
import gzip
import urllib.request
from pathlib import Path


def build(assets, feed, limit, metadata_only=False):
    def get(base, path):
        with urllib.request.urlopen(base + '/' + path, timeout=20) as response:
            data = response.read()
            return gzip.decompress(data) if response.headers.get('Content-Encoding') == 'gzip' else data

    metadata, images, effects = {}, {}, set()
    def meta(path):
        if path not in metadata:
            metadata[path] = json.loads(get(assets, path))
        return metadata[path]

    records = json.loads(get(feed, 'duel/replays/'))['replays'][:limit]
    for record in records:
        if not record.get('complete') or record.get('visualVersion') != 1:
            continue
        rows = [json.loads(line) for line in get(feed, 'duel/replays/' + record['id'] + '.jsonl').splitlines()]
        for row in rows:
            if row['type'] in ('header', 'loadout'):
                for player in row['players']:
                    body = player['body']
                    meta(f"replay-look.json?body={body}&hue={player['hue']}")
                    for item in player.get('equipment', []):
                        meta(f"replay-look.json?body={body}&g={item['graphic']}&hue={item['hue']}")
            if row['type'] == 'world':
                for item in row['items']:
                    meta(f"replay-art.json?g={item['g']}")
            if row['type'] != 'visual':
                continue
            packet = base64.b64decode(row['packet'])
            if packet[0] not in (0x70, 0xc0, 0xc7):
                continue
            kind, graphic = packet[1], int.from_bytes(packet[10:12], 'big')
            hue = int.from_bytes(packet[28:32], 'big') & 65535 if len(packet) >= 36 else 0
            if graphic:
                meta(f'replay-art.json?g={graphic}')
            if kind == 1:
                effects.update(f'gump/{g}.png?v=lightning-2' for g in range(20000, 20010))
            elif graphic:
                for g in meta(f'replay-art.json?g={graphic}')['frames']:
                    effects.add(f'art/static/{g}.png' + (f'?hue={hue}&fx=1' if hue else ''))
            if packet[27]:
                for g in meta('replay-art.json?g=14027')['frames']:
                    effects.add(f'art/static/{g}.png' + (f'?hue={hue}&fx=1' if hue else ''))
    meta('replay-art.json?g=14027')
    if len(effects) > 1024 or len(metadata) > 4096:
        raise ValueError('Asset pack exceeds limits')
    for path in ([] if metadata_only else sorted(effects)):
        data = get(assets, path)
        if not data.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValueError('Invalid PNG: ' + path)
        images[path] = 'data:image/png;base64,' + base64.b64encode(data).decode()
    return {'schema': 1, 'json': metadata, 'images': images}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', default='http://127.0.0.1:8096')
    parser.add_argument('--feed', default='http://127.0.0.1:8095')
    parser.add_argument('--limit', type=int, default=30)
    parser.add_argument('--output', required=True)
    parser.add_argument('--metadata-only', action='store_true')
    args = parser.parse_args()
    pack = build(args.assets.rstrip('/'), args.feed.rstrip('/'), args.limit, args.metadata_only)
    payload = json.dumps(pack, separators=(',', ':'))
    if len(payload) > 4 * 1024 * 1024:
        raise ValueError('Asset pack is too large')
    output = Path(args.output)
    staging = output.with_suffix('.tmp')
    staging.write_text(payload)
    staging.replace(output)
    print(f"Packed {len(pack['images'])} images and {len(pack['json'])} metadata entries in {len(payload)} bytes")
