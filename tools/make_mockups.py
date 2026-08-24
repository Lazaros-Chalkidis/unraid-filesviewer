#!/usr/bin/env python3
"""Builds the mockups the guide points at. Kept as a script so a colour or a
label can be changed in one place and every picture follows."""

import os, html

OUT = 'mockups'
BG, SURF, SURF2 = '#1a1a1a', '#242424', '#2e2e2e'
BORDER, BORDER2 = 'rgba(255,255,255,.10)', 'rgba(255,255,255,.18)'
TXT, MID, DIM, MUTED = 'rgba(255,255,255,.85)', 'rgba(255,255,255,.65)', 'rgba(255,255,255,.45)', 'rgba(255,255,255,.30)'
ACCENT, DIR, CREATE, DANGER, EDIT, CODE = '#42a5f5', '#ecc25b', '#5cc46a', '#e06a6a', '#e0823a', '#8ab6ff'
FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"

def esc(t):
    return html.escape(str(t))

def svg(w, h, body, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
            f'viewBox="0 0 {w} {h}" font-family="{FONT}" role="img" aria-label="{esc(title)}">'
            f'<title>{esc(title)}</title>'
            f'<rect width="{w}" height="{h}" rx="6" fill="{BG}"/>{body}</svg>')

def box(x, y, w, h, fill=SURF, stroke=BORDER, r=4):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}"/>'

def text(x, y, t, fill=TXT, size=12, anchor='start', weight='normal'):
    return (f'<text x="{x}" y="{y}" fill="{fill}" font-size="{size}" '
            f'text-anchor="{anchor}" font-weight="{weight}">{esc(t)}</text>')

def btn(x, y, label, w=None, colour=MID, on=True):
    w = w or (len(label) * 6.4 + 18)
    stroke = BORDER if on else 'rgba(255,255,255,.06)'
    fill = colour if on else 'rgba(255,255,255,.18)'
    return (box(x, y, w, 21, SURF2 if on else 'rgba(255,255,255,.02)', stroke, 3)
            + text(x + w / 2, y + 14.5, label.upper(), fill, 9, 'middle', '600')), w

def folder(x, y, c=DIR):
    return (f'<path d="M{x} {y+2}h6l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H{x}a2 2 0 0 1-2-2V{y+4}'
            f'a2 2 0 0 1 2-2z" fill="{c}"/>')

def page(x, y, c=DIM):
    return (f'<path d="M{x} {y}h9l6 6v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V{y+2}a2 2 0 0 1 2-2z" '
            f'fill="none" stroke="{c}" stroke-width="1.4"/>')

def tick(x, y, on):
    s = box(x, y, 12, 12, 'rgba(255,255,255,.06)' if not on else ACCENT, BORDER2, 2)
    if on:
        s += f'<path d="M{x+3} {y+6.4}l2.4 2.4 4-4.6" fill="none" stroke="{BG}" stroke-width="1.8" stroke-linecap="round"/>'
    return s

def note(x, y, t):
    return text(x, y, t, ACCENT, 10.5, weight='600')

def arrow(x1, y1, x2, y2):
    return (f'<path d="M{x1} {y1}L{x2} {y2}" stroke="{ACCENT}" stroke-width="1.6" '
            f'marker-end="url(#a)"/>')

DEFS = (f'<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" '
        f'markerHeight="5" orient="auto"><path d="M0 0l10 5-10 5z" fill="{ACCENT}"/></marker></defs>')


def toolbar(y, edit_on, ticked, x=14, w=752):
    """the button row, greyed or live depending on the two conditions"""
    out = box(x, y, w, 33, SURF, BORDER)
    bx = x + 8
    sel = ticked > 0
    for label, colour, live in [
        ('Create', CREATE, edit_on), ('Rename', EDIT, edit_on and ticked == 1),
        ('Edit', EDIT, edit_on and sel), ('Move', '#b08ae8', edit_on and sel),
        ('Copy', '#56a8e0', edit_on and sel), ('Owner', '#d072b5', edit_on and sel),
        ('Permission', '#a3b0cc', edit_on and sel), ('Upload', '#3bb6a2', edit_on),
    ]:
        s, bw = btn(bx, y + 6, label, colour=colour, on=live)
        out += s
        bx += bw + 6
    s, bw = btn(x + w - 74, y + 6, 'Delete', 66, DANGER, edit_on and sel)
    out += s
    return out


def head(y, edit_on, x=14, w=752):
    """title strip with the eye / pencil and the layout switch"""
    out = box(x, y, w, 40, SURF, BORDER)
    out += page(x + 12, y + 10, MID)
    out += text(x + 38, y + 19, 'FILES VIEWER', TXT, 12, weight='700')
    out += text(x + 38, y + 31, 'Contents  12 items', MUTED, 9.5)
    ix = x + w - 84
    for i, glyph in enumerate(['layout', 'mode', 'cog']):
        on = (glyph == 'mode' and edit_on)
        out += box(ix + i * 26, y + 10, 21, 21, SURF2, ACCENT if on else BORDER, 3)
        c = ACCENT if on else MID
        if glyph == 'layout':
            out += (f'<rect x="{ix+i*26+5}" y="{y+15}" width="11" height="11" rx="1.5" fill="none" stroke="{c}" stroke-width="1.4"/>'
                    f'<path d="M{ix+i*26+9} {y+15}v11" stroke="{c}" stroke-width="1.4"/>')
        elif glyph == 'mode':
            if edit_on:
                out += f'<path d="M{ix+i*26+6} {y+25}l7-7 2.4 2.4-7 7-2.8.4z" fill="none" stroke="{c}" stroke-width="1.4" stroke-linejoin="round"/>'
            else:
                out += (f'<path d="M{ix+i*26+4.5} {y+20.5}c2.6-3.4 8.4-3.4 11 0-2.6 3.4-8.4 3.4-11 0z" fill="none" stroke="{c}" stroke-width="1.4"/>'
                        f'<circle cx="{ix+i*26+10}" cy="{y+20.5}" r="1.8" fill="{c}"/>')
        else:
            out += f'<circle cx="{ix+i*26+10.5}" cy="{y+20.5}" r="4.5" fill="none" stroke="{c}" stroke-width="1.4"/>'
    return out


def rows(y, items, edit_on, ticks=(), x=14, w=752, cols=True):
    """the folder table, with or without the tick column"""
    out = box(x, y, w, 26 + len(items) * 26, SURF, BORDER)
    hx = x + 12
    out += text(hx, y + 17, 'Name', MUTED, 10)
    if edit_on:
        out += tick(x + w - 300, y + 8, False)
    if cols:
        for label, off, anch in [('Type', 272, 'start'), ('Size', 186, 'end'),
                                 ('Modified', 176, 'start'), ('Owner', 62, 'start')]:
            out += text(x + w - off, y + 17, label, MUTED, 10, anch)
    out += f'<path d="M{x} {y+26}h{w}" stroke="{BORDER}"/>'
    for i, (name, is_dir, meta) in enumerate(items):
        ry = y + 26 + i * 26
        out += folder(hx, ry + 6) if is_dir else page(hx, ry + 5)
        out += text(hx + 26, ry + 17, name, TXT if is_dir else MID, 11.5)
        if edit_on:
            out += tick(x + w - 300, ry + 7, i in ticks)
        if cols:
            out += text(x + w - 272, ry + 17, 'Folder' if is_dir else meta[0], DIM, 10.5)
            out += text(x + w - 186, ry + 17, '' if is_dir else meta[1], DIM, 10.5, 'end')
            out += text(x + w - 176, ry + 17, meta[2], DIM, 10.5)
            out += text(x + w - 62, ry + 17, meta[3], DIM, 10.5)
        if i < len(items) - 1:
            out += f'<path d="M{x+8} {ry+26}h{w-16}" stroke="{BORDER}" opacity=".5"/>'
    return out


FILES = [
    ('appdata', True, ('Folder', '', '2026.08.04 06:11', 'nobody')),
    ('notes.txt', False, ('Text', '2 KB', '2026.07.08 13:30', 'root')),
    ('poster.jpg', False, ('Image', '340 KB', '2026.07.08 13:31', 'root')),
]

os.makedirs(OUT, exist_ok=True)
made = []

# 1. where it lives in Tools
b = DEFS
b += box(14, 14, 752, 26, SURF2, BORDER, 3)
b += text(26, 31, 'Viewers Suite', TXT, 12, weight='600')
b += (f'<path d="M{14+740} {22}h0" />')
b += box(14, 46, 752, 78, SURF, BORDER)
for i, (label, hi) in enumerate([('Disk Viewer', False), ('Files Viewer', True),
                                 ('Logs Viewer', False), ('Stream Viewer', False)]):
    cx = 90 + i * 150
    b += page(cx - 9, 62, ACCENT if hi else MID)
    b += text(cx, 106, label, ACCENT if hi else MID, 10.5, 'middle')
b += arrow(420, 150, 248, 116)
b += note(432, 154, 'Tools > Viewers Suite > Files Viewer')
made.append(('01-where-it-lives.svg', svg(780, 172, b, 'The Viewers Suite section on the Tools page')))

# 2. the eye and the pencil
b = DEFS + head(14, False)
b += head(70, True)
b += note(28, 130, 'Preview only. Nothing you click changes a file.')
b += note(28, 148, 'Editing on. The buttons come alive once you tick something.')
b += arrow(430, 124, 712, 40)
b += arrow(470, 146, 712, 98)
made.append(('02-preview-and-editing.svg', svg(780, 162, b, 'The eye icon switches between preview and editing')))

# 3. the three states of the buttons
b = DEFS
b += toolbar(14, False, 0)
b += note(22, 64, 'Preview only: everything is grey')
b += toolbar(76, True, 0)
b += note(22, 126, 'Editing on, nothing ticked: still grey, they need to know which file')
b += toolbar(138, True, 2)
b += note(22, 188, 'Editing on, two files ticked: live')
made.append(('03-what-wakes-the-buttons.svg', svg(780, 200, b, 'Buttons need editing switched on and a file ticked')))

# 4. picking files
b = DEFS + head(14, True) + toolbar(60, True, 2) + rows(101, FILES, True, ticks=(1, 2))
b += note(26, 218, 'Tick a row to pick it. The box in the header takes the lot.')
made.append(('04-picking-files.svg', svg(780, 232, b, 'Ticking rows selects what the buttons act on')))

# 5. one pane or two
b = DEFS
b += box(14, 14, 366, 150, SURF, BORDER)
b += text(26, 32, 'One pane', MUTED, 10)
b += rows(42, [(n, d, m) for n, d, m in FILES], False, x=22, w=350, cols=False)
b += box(400, 14, 366, 150, SURF, BORDER)
b += text(412, 32, 'Two panes', MUTED, 10)
b += rows(42, [(n, d, m) for n, d, m in FILES], False, x=408, w=120, cols=False)
b += box(536, 42, 222, 104, SURF2, BORDER)
b += text(647, 96, 'preview', DIM, 10.5, 'middle')
b += note(26, 182, 'The layout icon at the top right slides the folder list in and out.')
made.append(('05-one-pane-or-two.svg', svg(780, 196, b, 'The single pane and the split view')))

# 6. the recycle bin
b = DEFS
b += box(14, 14, 752, 112, SURF, BORDER)
b += text(28, 34, 'Recycle Bin', TXT, 12, weight='600')
b += text(28, 52, 'this share', MUTED, 10)
for i, (name, when) in enumerate([('notes.txt', '2 hours ago  ·  1 item  ·  2 KB'),
                                  ('old-poster.jpg', 'yesterday  ·  1 item  ·  340 KB')]):
    ry = 62 + i * 30
    b += box(26, ry, 728, 26, SURF2, BORDER, 3)
    b += page(38, ry + 5, DIM)
    b += text(64, ry + 17, name, TXT, 11.5)
    b += text(180, ry + 17, when, DIM, 10)
    s1, w1 = btn(600, ry + 2.5, 'Restore', 68, ACCENT)
    s2, _ = btn(676, ry + 2.5, 'Delete', 66, DANGER)
    b += s1 + s2
b += note(26, 146, 'Off by default, and it only catches deletes made here.')
made.append(('06-recycle-bin.svg', svg(780, 160, b, 'The recycle bin, with restore and permanent delete')))

# 7. favourites
b = DEFS
b += box(14, 14, 752, 32, SURF, BORDER)
b += text(28, 34, 'Path:  mnt / cache / appdata', MID, 11)
star = 'M700 20l3 6.1 6.7 1-4.9 4.7 1.2 6.6-6-3.1-6 3.1 1.2-6.6-4.9-4.7 6.7-1z'
b += f'<path d="{star}" fill="{ACCENT}" stroke="{ACCENT}" stroke-width="1.4" stroke-linejoin="round"/>'
b += box(14, 54, 250, 86, SURF2, BORDER2)
b += text(28, 74, 'Add appdata', ACCENT, 11)
b += f'<path d="M22 82h234" stroke="{BORDER}"/>'
for i, (n, d) in enumerate([('Media', True), ('isos', True), ('notes.txt', False)]):
    ry = 88 + i * 18
    b += (folder(28, ry - 8) if d else page(28, ry - 9))
    b += text(52, ry, n, TXT, 11)
b += arrow(560, 84, 694, 38)
b += note(300, 100, 'The star pins whatever the path bar points at.')
made.append(('07-favourites.svg', svg(780, 154, b, 'Pinning a folder with the star, and the favourites menu')))

# 8. folder sizes
b = DEFS
b += box(14, 14, 752, 128, SURF, BORDER)
b += text(28, 34, 'Space usage', TXT, 12, weight='600')
b += text(112, 34, '·  cache', MUTED, 11)
for i, (n, size, pct) in enumerate([('appdata', '50.0 GB', 1.0), ('system', '3.1 GB', 0.062),
                                    ('domains', '1.2 GB', 0.024)]):
    ry = 48 + i * 30
    b += box(26, ry, 728, 26, SURF2, BORDER, 3)
    b += f'<rect x="26" y="{ry}" width="{int(728*pct)}" height="26" rx="3" fill="{ACCENT}" opacity=".16"/>'
    b += folder(38, ry + 6)
    b += text(64, ry + 17, n, TXT, 11.5)
    b += text(660, ry + 17, size, MID, 11, 'end')
    b += text(742, ry + 17, f'{int(pct*100)}%', DIM, 10, 'end')
b += note(26, 162, 'Reads every file underneath, so it is off until you turn it on.')
made.append(('08-folder-sizes.svg', svg(780, 176, b, 'Space usage, ranking what a folder holds')))

for name, body in made:
    with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
        f.write(body)
    print(f'  {name:32s} {len(body):6d} bytes')
