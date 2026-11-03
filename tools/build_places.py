#!/usr/bin/env python3
"""Build Jalan's free place-search index from Overture Maps (https://overturemaps.org).

Overture publishes an open places dataset (CDLA Permissive 2.0) with millions of
businesses. This script pulls only the places inside Malaysia, then writes them as
small static JSON "shards" that Jalan downloads on demand while you type:

  places/index.json        which shards exist and how many places each holds
  places/s/<prefix>.json   places whose name has a word starting with <prefix>

Each shard is kept small (a few hundred KB at most), so a search downloads one or
two small files instead of a database. No server, account or key is needed: the
files are published with the website on GitHub Pages.

Usage:
  python tools/build_places.py OUT_DIR
Env (optional):
  OVERTURE_RELEASE  a release name such as 2026-10-22.0 (default: newest)
  OVERTURE_SRC      a local parquet path/glob instead of Overture's S3 (for testing)
  SHARD_LIMIT       max places in a shard before it is split (default 2500)
"""
import json, os, re, shutil, sys, time, unicodedata, urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict

import duckdb

BBOX = (99.6, 0.8, 119.3, 7.4)          # Malaysia (lon/lat), same box the app uses
LIMIT = int(os.environ.get('SHARD_LIMIT', '2500'))
STOP_AT = 8000                          # words in more places than this are too common to search on
S3 = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com'


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


# --- the same normalisation the app uses (normQ in index.html) -------------
def norm(t):
    t = unicodedata.normalize('NFKD', str(t or '').lower())
    t = ''.join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"['’`.]", '', t)
    return re.sub(r'[^a-z0-9]+', ' ', t).strip()


def tokens(name):
    ws = norm(name).split()
    out = {w for w in ws if len(w) >= 2}
    if 2 <= len(ws):                    # "MR. D.I.Y." -> also "mrdiy", "7-Eleven" -> "7eleven"
        c = ''.join(ws[:3])
        if 3 <= len(c) <= 15:
            out.add(c)
    return out


# --- find the newest Overture release that has places -----------------------
def releases():
    x = urllib.request.urlopen(S3 + '/?list-type=2&prefix=release/&delimiter=/', timeout=60).read()
    ns = {'s': 'http://s3.amazonaws.com/doc/2006-03-01/'}
    pre = [e.text for e in ET.fromstring(x).findall('s:CommonPrefixes/s:Prefix', ns)]
    return sorted((p.split('/')[1] for p in pre if re.match(r'release/\d{4}-\d{2}-\d{2}', p)), reverse=True)


def open_source(con):
    if os.environ.get('OVERTURE_SRC'):
        return 'local', f"read_parquet('{os.environ['OVERTURE_SRC']}')"
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    cands = [os.environ['OVERTURE_RELEASE']] if os.environ.get('OVERTURE_RELEASE') else releases()[:4]
    for rel in cands:
        src = f"read_parquet('s3://overturemaps-us-west-2/release/{rel}/theme=places/type=place/*', hive_partitioning=1)"
        try:
            con.execute(f'DESCRIBE SELECT * FROM {src}').fetchall()
            return rel, src
        except Exception as e:  # newest folder may still be uploading
            log('release', rel, 'not usable:', str(e)[:200])
    raise SystemExit('No usable Overture release found')


# --- read Malaysia's places, coping with small schema changes between releases ---
def read_places(con, src):
    cols = {r[0]: str(r[1]) for r in con.execute(f'DESCRIBE SELECT * FROM {src}').fetchall()}
    has = lambda c, f=None: c in cols and (f is None or f in cols[c])
    cat = ('basic_category' if has('basic_category') else
           'taxonomy.primary' if has('taxonomy', 'primary') else
           'categories.primary' if has('categories', 'primary') else 'NULL')
    addr = has('addresses')
    sel = [
        'names.primary AS name', 'bbox.xmin AS lon', 'bbox.ymin AS lat', f'{cat} AS cat',
        'addresses[1].locality AS loc' if addr else 'NULL AS loc',
        'addresses[1].region AS reg' if addr else 'NULL AS reg',
        'brand.names.primary AS brand' if has('brand', 'names') else 'NULL AS brand',
    ]
    where = [f'bbox.xmin BETWEEN {BBOX[0]} AND {BBOX[2]}', f'bbox.ymin BETWEEN {BBOX[1]} AND {BBOX[3]}',
             'names.primary IS NOT NULL']
    if has('confidence'):
        where.append('confidence >= 0.4')
    if has('operating_status'):
        where.append("coalesce(operating_status, 'open') <> 'permanently_closed'")
    if addr:  # drop Singapore, Brunei, Thailand and Indonesia places that fall inside the box
        where.append("(addresses IS NULL OR len(addresses) = 0 OR addresses[1].country IS NULL OR addresses[1].country = 'MY')")
    q = f"SELECT {', '.join(sel)} FROM {src} WHERE {' AND '.join(where)}"
    log('query:', q)
    return con.execute(q).fetchall()


def build(out):
    con = duckdb.connect()
    rel, src = open_source(con)
    log('using Overture release', rel)
    rows = read_places(con, src)
    log(f'{len(rows):,} places in Malaysia')

    recs, by_tok, seen = [], defaultdict(list), set()
    for name, lon, lat, cat, loc, reg, brand in rows:
        if lon is None or lat is None:
            continue
        name = str(name).strip()[:80]
        key = (norm(name), round(lon, 4), round(lat, 4))
        if not key[0] or key in seen:
            continue
        seen.add(key)
        area = ', '.join(dict.fromkeys(x for x in (loc, reg) if x))[:60]
        i = len(recs)
        recs.append([name, round(lon * 1e5), round(lat * 1e5), (cat or '')[:40], area])
        for t in tokens(name) | (tokens(brand) if brand and norm(brand) not in norm(name) else set()):
            by_tok[t].append(i)
    log(f'{len(recs):,} unique places, {len(by_tok):,} distinct words')

    stop = sorted(t for t, ids in by_tok.items() if len(ids) > STOP_AT)
    for t in stop:
        del by_tok[t]
    log('too common to index:', ', '.join(stop[:60]), '…' if len(stop) > 60 else '')

    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(os.path.join(out, 's'))
    shards = {}

    def write(key, ids):
        ids = sorted(set(ids))
        with open(os.path.join(out, 's', key + '.json'), 'w', encoding='utf-8') as f:
            json.dump([recs[i] for i in ids], f, ensure_ascii=False, separators=(',', ':'))
        shards[key] = len(ids)

    # split a prefix into longer prefixes until every shard is small enough
    def emit(prefix, toks):
        ids = set()
        for t in toks:
            ids.update(by_tok[t])
        if len(ids) <= LIMIT or len(prefix) >= 10:
            write(prefix, ids)
            return
        groups = defaultdict(list)
        for t in toks:
            if t == prefix:
                write(prefix + '_', by_tok[t])   # the exact word on its own
            else:
                groups[t[len(prefix)]].append(t)
        for c, g in sorted(groups.items()):
            emit(prefix + c, g)

    first = defaultdict(list)
    for t in by_tok:
        first[t[0]].append(t)
    for c, g in sorted(first.items()):
        emit(c, g)

    meta = {'v': rel, 'built': time.strftime('%Y-%m-%d'), 'n': len(recs), 'stop': stop, 's': shards}
    with open(os.path.join(out, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, separators=(',', ':'))
    size = sum(os.path.getsize(os.path.join(out, 's', k + '.json')) for k in shards)
    big = max(shards.items(), key=lambda x: x[1]) if shards else ('-', 0)
    log(f'{len(shards):,} shards, {size / 1e6:.1f} MB total, largest {big[0]} ({big[1]} places)')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    build(sys.argv[1])
