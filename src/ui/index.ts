// Money Inc. game-UI toolkit ("Brass & Ledger" skin).
//
//   import { openWindow, updateWindows, kv, gauge, lineChart } from './ui';
//
// Importing this module loads the fonts and the skin stylesheet.

import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/500.css';
import '@fontsource/pixelify-sans/600.css';
import '@fontsource/pixelify-sans/700.css';
import '@fontsource/silkscreen/400.css';
import '@fontsource/silkscreen/700.css';
import './styles.css';

export * from './dom';
export * from './windows';
export * from './widgets';
export * from './chart';
export { glyph, iconEl, emojiSprite, pixelSvg, setPixelIcons, GLYPHS, type GlyphName, type IconOpts } from './icons';
export { hideTooltip, installTooltips } from './tooltip';
export { accentVars, luminance, mixRgb, toHex, SCREEN_PALETTE, PAPER_PALETTE, type RGB } from './color';
