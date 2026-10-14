#!/usr/bin/env python3
"""Build NokNok's SVG assets. Requires fonttools==4.60.2; no network access."""
from pathlib import Path
from html import escape
import json

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / 'assets'
OUT.mkdir(exist_ok=True)
INK, HONEY, PAPER = '#252823', '#D89945', '#F7F3EA'
SLOGAN = 'Knock, knock. Agents talk.'
FONTS = {}

# An n-shaped doorframe, ajar door leaf, and exactly two rounded knock ticks.
FRAME = ('M44 324Q32 324 32 312V154C32 94 84 52 150 52'
         'C216 52 268 94 268 154V312Q268 324 256 324H224'
         'Q212 324 212 312V153C212 116 185 104 150 104'
         'C115 104 92 116 92 153V312Q92 324 80 324Z')
DOOR = ('M111 135C105 133 101 137 101 143V313'
        'C101 319 105 322 112 319L180 300Q187 298 187 290'
        'V167Q187 159 180 157Z')
# Optical variant for 16–32 px: wider gap, no knob, slightly stronger knock ticks.
SMALL_DOOR = ('M121 138C115 136 111 140 111 146V309'
              'C111 315 115 318 122 315L174 300Q181 298 181 290'
              'V167Q181 159 174 157Z')
KNOB_HOLE = 'M176 229A11 11 0 1 0 154 229A11 11 0 1 0 176 229Z'


def mark(first=INK, second=HONEY, small=False):
    door = SMALL_DOOR if small else DOOR + KNOB_HOLE
    content = (f'<path fill="{first}" d="{FRAME}"/>'
               f'<path fill="{second}" fill-rule="evenodd" d="{door}"/>')
    # In monochrome the knob is a true transparent cutout, not a painted white dot.
    if first != second and not small:
        content += f'<circle cx="165" cy="229" r="11" fill="{first}"/>'
    content += (f'<path fill="none" stroke="{second}" '
                f'stroke-width="{25 if small else 21}" stroke-linecap="round" '
                'd="M259 65L280 31M286 94L316 74"/>')
    return content


def at(content, x, y, scale=1):
    return f'<g transform="translate({x} {y}) scale({scale})">{content}</g>'


def wordmark(color=INK):
    # Original geometric lettering; deliberately independent of an installed font.
    n = ('M0 89V9Q0 0 9 0H17Q25 0 28 9C37 2 45 -2 55 -2'
         'C80 -2 94 17 94 46V89Q94 96 87 96H72Q65 96 65 89'
         'V49C65 35 59 28 48 28C36 28 29 36 29 49V89'
         'Q29 96 22 96H7Q0 96 0 89Z')
    o = ('M49 0C20 0 0 20 0 48C0 76 20 96 49 96'
         'C78 96 98 76 98 48C98 20 78 0 49 0Z'
         'M49 29C61 29 69 37 69 48C69 60 61 67 49 67'
         'C37 67 29 60 29 48C29 37 37 29 49 29Z')
    k = ('M0 89V-38Q0 -47 9 -47H21Q30 -47 30 -38V32'
         'L59 3Q62 0 67 0H96Q102 0 98 6L57 46L102 89'
         'Q108 96 99 96H75Q71 96 67 92L40 63L30 73V89'
         'Q30 96 23 96H7Q0 96 0 89Z')
    return f'<g fill="{color}" fill-rule="evenodd">' + ''.join(
        at(f'<path d="{p}"/>', x, 0) for p, x in
        [(n, 0), (o, 108), (k, 220), (n, 338), (o, 446), (k, 558)]) + '</g>'


def outlined(text, x, baseline, size, color=INK, weight=400, tracking=0):
    if weight not in FONTS:
        FONTS[weight] = instantiateVariableFont(
            TTFont(HERE / 'fonts' / 'Manrope.ttf'), {'wght': weight})
    font = FONTS[weight]
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    scale = size / font['head'].unitsPerEm
    paths = []
    cursor = x
    for char in text:
        name = cmap[ord(char)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, cursor, baseline)))
        commands = pen.getCommands()
        if commands:
            paths.append(f'<path d="{commands}"/>')
        cursor += glyphs[name].width * scale + tracking
    return f'<g fill="{color}" aria-label="{escape(text)}">' + ''.join(paths) + '</g>'


def rect(w, h, color, radius=0, x=0, y=0):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{color}"/>'


def svg(name, width, height, title, content, desc=''):
    text = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
            f'viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">\n'
            f'<title id="title">{escape(title)}</title>\n'
            f'<desc id="desc">{escape(desc or title)}</desc>\n{content}\n</svg>\n')
    (OUT / f'{name}.svg').write_text(text)


def horizontal(first=INK, second=HONEY, background=None, tagline=True):
    content = rect(1200, 400, background) if background else ''
    content += at(mark(first, second), 67, 72, .8)
    content += at(wordmark(first), 395, 127, 1.08)
    if tagline:
        content += outlined(SLOGAN, 395, 291, 43, first, tracking=.3)
    return content


description = 'An n-shaped doorframe, ajar door and two knock ticks. NokNok: ' + SLOGAN
svg('mark', 360, 336, 'NokNok symbol', mark(), description)
svg('mark-mono', 360, 336, 'NokNok single-color symbol', mark(INK, INK), description)
svg('mark-reverse', 360, 336, 'NokNok reversed symbol', mark(PAPER, PAPER), description)
svg('mark-small', 360, 336, 'NokNok small-size symbol', mark(INK, INK, True), description)
svg('wordmark', 708, 182, 'noknok', at(wordmark(), 24, 62), 'Original lowercase NokNok lettering.')
svg('logo-horizontal', 1200, 400, 'NokNok — ' + SLOGAN, horizontal(background=PAPER), description)
svg('logo-horizontal-dark', 1200, 400, 'NokNok — ' + SLOGAN, horizontal(PAPER, HONEY, INK), description)
svg('logo-horizontal-transparent', 1200, 400, 'NokNok — ' + SLOGAN, horizontal(), description)
svg('logo-compact', 1000, 300, 'NokNok', at(mark(), 30, 22, .76) + at(wordmark(), 336, 123, .95), description)
svg('app-icon', 512, 512, 'NokNok app icon', rect(512, 512, HONEY, 112) + at(mark(INK, INK), 76, 88), description)
svg('favicon', 512, 512, 'NokNok favicon', rect(512, 512, HONEY, 112) + at(mark(INK, INK, True), 76, 88), description)

social = rect(1200, 630, PAPER)
social += at(mark(), 69, 111, .92) + at(wordmark(), 446, 207, 1)
social += outlined(SLOGAN, 446, 381, 39, tracking=.3)
social += outlined('INSTANT MESSAGING BETWEEN AGENTS', 81, 542, 19, weight=600, tracking=2)
svg('social-card', 1200, 630, 'NokNok — ' + SLOGAN, social, description)

preview = rect(1536, 1024, PAPER)
preview += outlined('01 / THE KNOCK', 58, 64, 17, tracking=4)
preview += at(mark(), 207, 187, .9) + at(wordmark(), 515, 336, 1.19)
preview += outlined(SLOGAN, 515, 518, 49, tracking=.5)
preview += rect(1420, 1, '#D9D2C6', x=58, y=640)
preview += rect(1, 200, '#D9D2C6', x=552, y=726)
preview += rect(1, 200, '#D9D2C6', x=984, y=726)
preview += at(mark(INK, INK), 234, 709, .56)
preview += outlined('MONO', 289, 947, 17, tracking=3)
preview += rect(196, 196, INK, 38, 670, 714)
preview += at(mark(PAPER, PAPER), 699, 745, .38)
preview += outlined('REVERSE', 712, 947, 17, tracking=3)
preview += rect(196, 196, HONEY, 38, 1095, 714)
preview += at(mark(INK, INK), 1124, 745, .38)
preview += outlined('APP', 1173, 947, 17, tracking=3)
svg('brand-preview', 1536, 1024, 'NokNok brand identity — The Knock', preview, description)

(OUT / 'brand.json').write_text(json.dumps({
    'name': 'NokNok', 'wordmark': 'noknok', 'concept': 'The Knock',
    'slogan': {'en': SLOGAN, 'zh-CN': '敲敲门，Agent 聊起来。'},
    'descriptor': {'en': 'Instant messaging between agents.', 'zh-CN': 'Agent 之间的即时通信。'},
    'colors': {'charcoal': INK, 'honey': HONEY, 'paper': PAPER},
    'reference': '../reference/concept-the-knock.png',
}, ensure_ascii=False, indent=2) + '\n')
print(f'Generated {len(list(OUT.glob("*.svg")))} SVG assets and brand.json in {OUT}')
