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
INK, MINT, PAPER = '#193E36', '#66D9AE', '#F4F6F2'
FONTS = {}

# Two facing doorways. The gap between their silhouettes survives monochrome use.
LEFT = ('M20 114C20 55 54 22 106 22C149 22 183 45 194 79'
        'C171 86 158 105 158 133V211L144 226V141'
        'C144 132 138 128 130 132L111 142C103 146 100 151 100 161'
        'V243C100 250 96 254 90 257L34 283C26 287 20 284 20 275Z')
RIGHT = ('M178 149C178 94 211 55 260 55C310 55 342 89 342 144'
         'V305C342 313 336 317 329 313L277 287C271 284 268 279 268 273'
         'V179C268 171 265 166 258 163L244 156C237 152 231 156 231 164'
         'V257L192 236C183 232 178 225 178 216Z')
# Optical variant for 16–32 px: remove the narrow inner spur and open both apertures.
SMALL_LEFT = ('M20 114C20 55 54 22 106 22C149 22 183 45 194 79'
              'C168 88 150 109 150 139V154L119 169'
              'C111 173 108 178 108 187V243C108 250 104 254 98 257'
              'L34 283C26 287 20 284 20 275Z')
SMALL_RIGHT = ('M182 149C182 94 213 55 260 55C310 55 342 89 342 144'
               'V305C342 313 336 317 329 313L284 290C277 287 274 282 274 275'
               'V186C274 178 271 173 264 170L250 163C243 159 237 163 237 171'
               'V259L197 237C187 232 182 225 182 216Z')


def mark(first=INK, second=MINT, small=False):
    a, b = (SMALL_LEFT, SMALL_RIGHT) if small else (LEFT, RIGHT)
    return f'<path fill="{first}" d="{a}"/><path fill="{second}" d="{b}"/>'


def at(content, x, y, scale=1):
    return f'<g transform="translate({x} {y}) scale({scale})">{content}</g>'


def wordmark(color=INK):
    # Original geometric lettering; deliberately independent of an installed font.
    n = ('M0 96V50C0 20 18 0 47 0C77 0 94 20 94 50V96'
         'H65V50C65 36 59 29 47 29C35 29 29 36 29 50V96Z')
    o = ('M49 0C20 0 0 20 0 48C0 76 20 96 49 96'
         'C78 96 98 76 98 48C98 20 78 0 49 0Z'
         'M49 29C61 29 69 37 69 48C69 60 61 67 49 67'
         'C37 67 29 60 29 48C29 37 37 29 49 29Z')
    k = ('M0 96V-32Q0 -38 6 -38H24Q30 -38 30 -32V34'
         'L60 3Q63 0 67 0H97L54 46L102 96H66L30 58V96Z')
    return f'<g fill="{color}" fill-rule="evenodd">' + ''.join(
        at(f'<path d="{p}"/>', x, 0) for p, x in
        [(n, 0), (o, 108), (k, 220), (n, 338), (o, 446), (k, 558)]) + '</g>'


def outlined(text, x, baseline, size, color=INK, weight=500, tracking=0):
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


def horizontal(first=INK, second=MINT, background=None, tagline=True):
    content = rect(1200, 400, background) if background else ''
    content += at(mark(first, second), 67, 72, .8)
    content += at(wordmark(first), 395, 127, 1.08)
    if tagline:
        content += outlined('Where agents talk.', 395, 291, 49, first)
    return content


description = 'Two facing doorways suggest agents in conversation. NokNok: Where agents talk.'
svg('mark', 360, 336, 'NokNok symbol', mark(), description)
svg('mark-mono', 360, 336, 'NokNok single-color symbol', mark(INK, INK), description)
svg('mark-reverse', 360, 336, 'NokNok reversed symbol', mark(PAPER, PAPER), description)
svg('mark-small', 360, 336, 'NokNok small-size symbol', mark(INK, INK, True), description)
svg('wordmark', 708, 182, 'noknok', at(wordmark(), 24, 62), 'Original lowercase NokNok lettering.')
svg('logo-horizontal', 1200, 400, 'NokNok — Where agents talk.', horizontal(background=PAPER), description)
svg('logo-horizontal-dark', 1200, 400, 'NokNok — Where agents talk.', horizontal(PAPER, MINT, INK), description)
svg('logo-horizontal-transparent', 1200, 400, 'NokNok — Where agents talk.', horizontal(), description)
svg('logo-compact', 1000, 300, 'NokNok', at(mark(), 30, 22, .76) + at(wordmark(), 336, 123, .95), description)
svg('app-icon', 512, 512, 'NokNok app icon', rect(512, 512, MINT, 112) + at(mark(INK, INK), 76, 88), description)
svg('favicon', 512, 512, 'NokNok favicon', rect(512, 512, MINT, 112) + at(mark(INK, INK, True), 76, 88), description)

social = rect(1200, 630, PAPER)
social += at(mark(), 69, 111, .92) + at(wordmark(), 446, 207, 1)
social += outlined('Where agents talk.', 446, 381, 49)
social += outlined('INSTANT MESSAGING BETWEEN AGENTS', 81, 542, 19, weight=600, tracking=2)
svg('social-card', 1200, 630, 'NokNok — Where agents talk.', social, description)

preview = rect(1536, 1024, PAPER)
preview += outlined('03 / IN CONVERSATION', 64, 69, 19, tracking=4)
preview += at(mark(), 130, 175, 1.02) + at(wordmark(), 558, 288, 1.2)
preview += outlined('Where agents talk.', 558, 494, 56)
preview += rect(1536, 1, '#CDD8D1', y=663)
preview += at(mark(INK, INK), 115, 702, .59)
preview += outlined('MONO', 116, 967, 17, tracking=3)
preview += rect(512, 360, INK, x=512, y=664)
preview += at(mark(PAPER, PAPER), 651, 702, .59)
preview += outlined('REVERSE', 628, 967, 17, PAPER, tracking=3)
preview += rect(208, 208, MINT, 45, 1176, 711)
preview += at(mark(INK, INK), 1207, 746, .405)
preview += outlined('APP', 1176, 967, 17, tracking=3)
svg('brand-preview', 1536, 1024, 'NokNok brand identity — concept 03', preview, description)

(OUT / 'brand.json').write_text(json.dumps({
    'name': 'NokNok', 'wordmark': 'noknok', 'concept': '03 / In conversation',
    'slogan': {'en': 'Where agents talk.', 'zh-CN': '让 Agent 聊起来。'},
    'descriptor': {'en': 'Instant messaging between agents.', 'zh-CN': 'Agent 之间的即时通信。'},
    'colors': {'evergreen': INK, 'mint': MINT, 'paper': PAPER},
    'reference': '../reference/concept-03.png',
}, ensure_ascii=False, indent=2) + '\n')
print(f'Generated {len(list(OUT.glob("*.svg")))} SVG assets and brand.json in {OUT}')
