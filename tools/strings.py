#!/usr/bin/env python3
# ============================================================================
# FILES VIEWER
# Copyright (C) 2026 Lazaros Chalkidis
# License: GPLv3
# =========================================================================

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'source')
LANG = os.path.join(ROOT, 'languages')

STRIP = re.compile(r"&amp;|[?{}|&~!\[\]()/:*^.\"']|<.+?/?>")
RESERVED = re.compile(r'^(null|yes|no|true|false|on|off|none)$', re.I)

CALL = re.compile(r"(?<![A-Za-z0-9_])(?:_|T|tf)\('((?:[^'\\]|\\.)*)'")

def key_of(text):
    k = STRIP.sub('', text)
    return re.sub(r'  +', ' ', k).strip()

def calls(text):
    return [m.group(1).replace("\\'", "'") for m in CALL.finditer(text)]

def collect():
    page, js = {}, {}
    for name in sorted(os.listdir(SRC)):
        if not name.endswith('.page'):
            continue
        body = open(os.path.join(SRC, name), encoding='utf-8').read()
        scripts = re.findall(r'<script[^>]*>(.*?)</script>', body, re.S)
        rest = re.sub(r'<script[^>]*>.*?</script>', '', body, flags=re.S)
        for t in calls(rest):
            page.setdefault(key_of(t), t)
        for sc in scripts:
            for t in calls(sc):
                js.setdefault(key_of(t), t)
    for name in sorted(os.listdir(os.path.join(SRC, 'js'))):
        if not name.endswith('.js'):
            continue
        body = open(os.path.join(SRC, 'js', name), encoding='utf-8').read()
        for t in calls(body):
            js.setdefault(key_of(t), t)
    return page, js

def check(keys, is_js):
    for k in keys:
        if '=' in k or '#' in k or ';' in k:
            print(f'  WARN unusable key for the ini parser: {k}')
        if is_js and RESERVED.match(k):
            print(f'  WARN a bare reserved word never matches in javascript: {k}')

def read_lang(path):
    out, order = {}, []
    if not os.path.exists(path):
        return out, order
    for line in open(path, encoding='utf-8'):
        line = line.rstrip('\n')
        if '=' not in line or line.startswith('#') or line.startswith(':'):
            continue
        k, v = line.split('=', 1)
        out[k] = v
        order.append(k)
    return out, order

def sync(path, keys, write):
    have, order = read_lang(path)
    missing = [k for k in keys if k not in have]
    stale = [k for k in order if k not in keys]
    label = os.path.relpath(path, ROOT)
    print(f'{label}: {len(keys)} keys, {len(missing)} missing, {len(stale)} stale, '
          f'{sum(1 for k in keys if have.get(k))} translated')
    for k in stale:
        print(f'  stale: {k}')
    if not write:
        return
    lines = []
    for k in order:
        if k in keys:
            lines.append(f'{k}={have[k]}')
    for k in missing:
        lines.append(f'{k}=')
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')

def main():
    write = '--write' in sys.argv
    page, js = collect()
    print(f'page strings: {len(page)}   javascript strings: {len(js)}')
    check(page, False)
    check(js, True)
    if '--keys' in sys.argv:
        for k in page: print('P', k)
        for k in js: print('J', k)
    if not os.path.isdir(LANG):
        return
    for loc in sorted(os.listdir(LANG)):
        d = os.path.join(LANG, loc)
        if not os.path.isdir(d):
            continue
        sync(os.path.join(d, 'filesviewer.txt'), list(page), write)
        sync(os.path.join(d, 'javascript.filesviewer.txt'), list(js), write)

if __name__ == '__main__':
    main()
