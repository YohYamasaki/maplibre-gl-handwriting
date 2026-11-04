// Toolbar icons: SVG paths from Lucide (https://lucide.dev), on a 24x24 grid, stroked with currentColor.
// Lucide is under the ISC License:
//   Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
//   All other copyright (c) for Lucide are held by Lucide Contributors 2022.
//   Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is
//   hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
// Elements with the class `tip` are filled with the pen's color instead (see toolbar.css)

export type IconName =
  | 'hand'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'lasso'
  | 'laser'
  | 'undo'
  | 'redo'
  | 'pen-tool'
  | 'grip'
  | 'collapse'
  | 'plus'

const ICONS: Record<Exclude<IconName, 'hand' | 'lasso'>, string> = {
  pen:
    '<path class="tip" d="M3.34 17l3.66 3.66-4.36 1.32a.5.5 0 0 1-.62-.62z"/>' +
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  highlighter:
    '<path class="tip" d="m9 11-6 6v3h9l3-3z"/><path d="m9 11-6 6v3h9l3-3"/>' +
    '<path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  eraser:
    '<path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21"/>' +
    '<path d="m5.082 11.09 8.828 8.828"/>',
  // wand: the laser pointer, a beam with sparks at its end
  laser:
    '<path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8 19 13"/>' +
    '<path d="M15 9h.01"/><path d="M17.8 6.2 19 5"/><path d="m3 21 9-9"/><path d="M12.2 6.2 11 5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>',
  // pen-tool: the pen-only input toggle, told apart from the pen tool by its nib
  'pen-tool':
    '<path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z"/>' +
    '<path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18"/>' +
    '<path d="m2.3 2.3 7.286 7.286"/><circle cx="11" cy="11" r="2"/>',
  grip:
    '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/>' +
    '<circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
  // chevrons-left-right: the toolbar folds to its selected tool and opens again
  collapse: '<path d="m9 7-5 5 5 5"/><path d="m15 7 5 5-5 5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
}

// Lucide's hand, map and mouse-pointer-2, for the icons made of two
const HAND =
  '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/>' +
  '<path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/>' +
  '<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'
const MAP =
  '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/>' +
  '<path d="M15 5.764v15"/><path d="M9 3.236v15"/>'
const POINTER =
  '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>'
// A dotted ring for the lasso, on the 24x24 grid
const RING = '<ellipse cx="10.5" cy="9.5" rx="8.5" ry="6.5" stroke-dasharray="2 3"/>'

/** A shape on its own grid, placed on the 24x24 grid by `transform`, its lines `width` wide on its own grid */
type Shape = { markup: string; transform: string; width: number; fill?: boolean }

const group = (shape: Shape, attributes = ''): string =>
  `<g transform="${shape.transform}" stroke-width="${shape.width}"${shape.fill ? ' fill="currentColor"' : ''}${attributes}>${shape.markup}</g>`

/** Two shapes, the upper over the lower; the lower is drawn through a mask that cuts out the upper's area and a gap */
const OVERLAYS: Record<'hand' | 'lasso', { lower: Shape; upper: Shape }> = {
  // A small map at the top left and a hand over it at the bottom right
  hand: {
    lower: { markup: MAP, transform: 'translate(0.5 0.5) scale(0.62)', width: 3 },
    upper: { markup: HAND, transform: 'translate(8.2 8) scale(0.66)', width: 3 },
  },
  // A dotted ring and a large pointer over it
  lasso: {
    lower: { markup: RING, transform: 'translate(0 0)', width: 2 },
    upper: { markup: POINTER, transform: 'translate(9 9) scale(0.68)', width: 2.6, fill: true },
  },
}

// The gap the mask leaves around the upper shape is half of this less half its line, on the upper shape's grid
const CUT_WIDTH = 8

// Mask ids must be unique on the page, since every toolbar makes its own icons
let nextMask = 0

function overlay(name: 'hand' | 'lasso'): string {
  const { lower, upper } = OVERLAYS[name]
  const id = `handwriting-icon-mask-${++nextMask}`
  // The cut-out: the upper shape filled and stroked wide, in black on white
  const cut = group({ ...upper, width: CUT_WIDTH, fill: false }, ' fill="black" stroke="black"')
  return (
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">` +
    `<rect width="24" height="24" fill="white" stroke="none"/>${cut}</mask>` +
    `<g mask="url(#${id})">${group(lower)}</g>${group(upper)}`
  )
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** A 24px icon element; hidden from assistive technology, so the button it sits in carries the label */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '24')
  svg.setAttribute('height', '24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('handwriting-icon')
  // The markup is the constants above, never user input
  svg.innerHTML = name === 'hand' || name === 'lasso' ? overlay(name) : ICONS[name]
  return svg
}
