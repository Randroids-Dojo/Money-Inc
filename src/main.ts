// Money Inc. — boot the city, the renderer and the game UI, and run the main loop.

import { closeAllWindows, closeTopWindow, mountUI, updateWindows, installTooltips } from './ui';
import './game.css';
import { Game, type Selection, type Speed } from './game/game';
import { Renderer } from './render/renderer';
import type { UIContext } from './game/ui/context';
import { createHud } from './game/ui/hud';
import { openBankWindow } from './game/ui/bankWindow';
import { openFirmWindow } from './game/ui/firmWindow';
import { openHouseholdWindow, openResidenceWindow } from './game/ui/homeWindows';
import { openLoanWindow } from './game/ui/loanWindow';
import { openCentralBankWindow } from './game/ui/cbWindow';
import { openCityHallWindow, openFundWindow, openLandWindow, openProjectWindow } from './game/ui/miscWindows';
import { extraUi } from './game/ui/extra';
import { Advisor } from './game/ui/advisor';

const params = new URLSearchParams(location.search);
const app = document.getElementById('app')!;
const seed = Number(params.get('seed') ?? Math.floor(1 + Math.random() * 9999));
const game = new Game(seed, 'classic');
const renderer = new Renderer(app, game);
mountUI();
installTooltips();

const ctx: UIContext = {
  game,
  renderer,
  open(sel: Selection, anchor?: { x: number; y: number }) {
    if (!sel) return;
    const eco = game.eco;
    switch (sel.kind) {
      case 'bank':
        return openBankWindow(ctx, sel.id, anchor);
      case 'firm':
        return openFirmWindow(ctx, sel.id, anchor);
      case 'household':
        return openHouseholdWindow(ctx, sel.id, anchor);
      case 'loan':
        return openLoanWindow(ctx, sel.id, anchor);
      case 'project':
        return openProjectWindow(ctx, sel.id, anchor);
      case 'cb':
        return openCentralBankWindow(ctx, anchor);
      case 'fund':
        return openFundWindow(ctx, anchor);
      case 'cityhall':
        return openCityHallWindow(ctx, anchor);
      case 'lot': {
        const use = eco.lotUse.get(sel.id);
        if (use?.type === 'res') return openResidenceWindow(ctx, sel.id, anchor);
        return openLandWindow(ctx, sel.id, anchor);
      }
    }
  },
  showOnMap(sel: Selection) {
    game.select(sel);
    if (!sel) return;
    const eco = game.eco;
    switch (sel.kind) {
      case 'lot':
        return renderer.focusLot(sel.id);
      case 'project': {
        const p = eco.projects.get(sel.id);
        if (p) renderer.focusLot(p.lotId);
        return;
      }
      case 'loan': {
        const l = eco.loans.get(sel.id);
        if (l) renderer.focusAgent(l.borrowerId);
        return;
      }
      case 'cb':
        return renderer.focusAgent(eco.cb.id);
      case 'fund':
        return renderer.focusAgent(eco.fund.id);
      case 'cityhall':
        return renderer.focusAgent(eco.treasury.id);
      default:
        return renderer.focusAgent(sel.id);
    }
  },
  showAgent(id: number) {
    const a = game.eco.agents.get(id);
    if (!a) return;
    let sel: Selection = null;
    switch (a.kind) {
      case 'bank':
        sel = { kind: 'bank', id };
        break;
      case 'firm':
        sel = { kind: 'firm', id };
        break;
      case 'household':
        sel = { kind: 'household', id };
        break;
      case 'cb':
      case 'dif':
        sel = { kind: 'cb' };
        break;
      case 'fund':
        sel = { kind: 'fund' };
        break;
      case 'treasury':
        sel = { kind: 'cityhall' };
        break;
      default:
        return;
    }
    ctx.showOnMap(sel);
    ctx.open(sel);
  },
};

renderer.onPick = (sel, screen) => {
  game.select(sel);
  if (sel) ctx.open(sel, screen);
};

const newGame = () => {
  extraUi.intro(ctx, (s, scenario) => {
    closeAllWindows();
    game.newGame(s, scenario);
    game.setSpeed(1);
    try {
      const u = new URL(location.href);
      u.searchParams.set('seed', String(s));
      history.replaceState(null, '', u);
    } catch {
      // sandboxed frames may not allow changing the URL; the seed is shown in the intro anyway
    }
  });
};

const hud = createHud(ctx, {
  openReserveBank: () => openCentralBankWindow(ctx),
  openStats: () => extraUi.stats(ctx),
  openNews: () => extraUi.news(ctx),
  openHelp: () => extraUi.help(ctx),
  newGame: () => {
    game.setSpeed(0);
    newGame();
  },
});

const advisor = new Advisor(ctx, hud);
if (params.has('notips')) advisor.enabled = false;

// ---- keyboard
const PAN = 60;
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const cam = renderer.camera;
  switch (e.key) {
    case ' ':
      game.togglePause();
      break;
    case '1':
    case '2':
    case '3':
    case '4':
      game.setSpeed(([1, 2, 5, 10] as Speed[])[Number(e.key) - 1]);
      break;
    case 'Escape':
      if (!closeTopWindow()) game.select(null);
      break;
    case '+':
    case '=':
      cam.zoomStep(1);
      break;
    case '-':
    case '_':
      cam.zoomStep(-1);
      break;
    case 'ArrowUp':
    case 'w':
    case 'W':
      cam.panBy(0, PAN);
      break;
    case 'ArrowDown':
    case 's':
    case 'S':
      cam.panBy(0, -PAN);
      break;
    case 'ArrowLeft':
    case 'a':
    case 'A':
      cam.panBy(PAN, 0);
      break;
    case 'ArrowRight':
    case 'd':
    case 'D':
      cam.panBy(-PAN, 0);
      break;
    case 'l':
    case 'L':
      hud.cycleLens();
      break;
    case 'f':
    case 'F':
      hud.toggleFlows();
      break;
    case 'b':
    case 'B':
      openCentralBankWindow(ctx);
      break;
    case 'g':
    case 'G':
      extraUi.stats(ctx);
      break;
    case 'n':
    case 'N':
      extraUi.news(ctx);
      break;
    case 'h':
    case 'H':
    case '?':
      extraUi.help(ctx);
      break;
    default:
      return;
  }
  e.preventDefault();
});

// ---- main loop
(window as unknown as { game: Game; ctx: UIContext }).game = game;
(window as unknown as { game: Game; ctx: UIContext }).ctx = ctx;
if (params.has('speed')) game.setSpeed(Number(params.get('speed')) as Speed);
let last = performance.now();
let uiClock = 0;
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const steps = game.tick(dt);
  if (steps > 0) advisor.onDay(game.events);
  renderer.frame(dt, steps);
  uiClock += dt;
  if (uiClock >= 0.25) {
    uiClock = 0;
    hud.update();
    updateWindows();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

if (!params.has('skipintro')) {
  game.setSpeed(0);
  newGame();
}
