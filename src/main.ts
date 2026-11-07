/**
 * PokéBonk desktop client (docs/DESKTOP.md). It loads the live game from pokebonk.com, so it is always the same version
 * as the web and the server, with the same origin (saves, accounts, captcha and co-op work unchanged). What it adds is
 * the browser settings the players can't get right by themselves: the dedicated GPU, hardware acceleration always on,
 * no throttling in the background or behind another window, real fullscreen and a window of its own.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, powerSaveBlocker, screen, session, shell, WebContentsView, type WebContents } from 'electron';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { langOf, tips, tr, type Lang } from './text';
import { DISCORD_APP_ID, DiscordPresence, remoteAppId, type Activity } from './discord';
import { startUpdater } from './updater';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);

/** The game. `--url=http://localhost:5173` points the client at `npm run dev`. */
const GAME_URL = (arg('url') ?? process.env.POKEBONK_URL ?? 'https://pokebonk.com').replace(/\/$/, '');
const GAME = new URL(GAME_URL);
/** Same site: the game's domain, its www and its subdomains (api.). Anything else opens in the system browser. */
const ownHost = (h: string) => h === GAME.hostname || h.endsWith('.' + GAME.hostname.replace(/^www\./, ''));
const SELFTEST = arg('selftest');
const DEVTOOLS = flag('devtools') || !app.isPackaged;

// ---------------- GPU and scheduling (before `ready`: Chromium reads them when it starts) ----------------
// Hybrid laptops (Optimus, MacBook Pro with two GPUs): Chromium asks for the integrated one unless told otherwise.
app.commandLine.appendSwitch('force_high_performance_gpu');
// Chromium's GPU blocklist turns WebGL to software (about 10 fps) on some drivers that run the game fine.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
// A browser slows timers and frames of a page in the background or covered by another window: in co-op the host
// kept the whole party waiting. The game pauses itself when it loses focus; nothing else should slow it.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
// The menu music starts without a first click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
// Long Survival runs keep many sprite sheets and particles alive: a larger heap than a browser tab gets.
// Wayland sessions (Steam Deck Game Mode) + the Vulkan ANGLE backend don't mix: Chromium picks Wayland when it
// exists and then can't present through Vulkan. Force the X11 Ozone backend (XWayland) on Linux; native Wayland's
// perks (HDR, VRR, fractional scaling) aren't worth a black screen. No-op everywhere else.
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform-hint', 'x11');

/**
 * Settings of the client itself (Ajustes → Pantalla, see `display` below), in `client.json` of the data folder.
 * V-Sync is a Chromium switch, so it applies on the next launch: off, frames are not tied to the monitor
 * (more FPS than its refresh, with tearing) and the game's «Límite de FPS» is the only cap.
 */
type ClientCfg = { vsync: boolean; angle: Angle; lastArt?: string; discord: boolean };
const cfgFile = () => join(app.getPath('userData'), 'client.json');
const CFG0: ClientCfg = { vsync: true, angle: 'auto', discord: true };
function readCfg(): ClientCfg {
  try {
    const c = { ...CFG0, ...(JSON.parse(readFileSync(cfgFile(), 'utf8')) as Partial<ClientCfg>) };
    return { ...c, angle: ANGLES.includes(c.angle) ? c.angle : 'auto' };
  } catch { return { ...CFG0 }; }
}
function writeCfg(p: Partial<ClientCfg>) {
  try { mkdirSync(app.getPath('userData'), { recursive: true }); writeFileSync(cfgFile(), JSON.stringify({ ...readCfg(), ...p })); } catch { /* read-only profile */ }
}

/**
 * Graphics backend (Ajustes → Pantalla → Motor gráfico): which API ANGLE turns WebGL into. «auto» is Chromium's
 * choice (Direct3D 11 on Windows, Metal on macOS, OpenGL on Linux); some drivers crash or draw black with it and run
 * fine with another. A Chromium switch, so it applies on the next launch, like V-Sync.
 */
type Angle = 'auto' | 'd3d11' | 'gl' | 'vulkan' | 'metal';
const ANGLES: Angle[] = process.platform === 'win32' ? ['auto', 'd3d11', 'gl', 'vulkan'] : process.platform === 'darwin' ? ['auto', 'metal', 'gl'] : ['auto', 'gl', 'vulkan'];
/** The backend to offer after the GPU process keeps crashing with the current one. */
const angleFallback = (a: Angle): Angle => (process.platform === 'win32' ? (a === 'gl' ? 'd3d11' : 'gl') : process.platform === 'darwin' ? (a === 'gl' ? 'metal' : 'gl') : (a === 'vulkan' ? 'gl' : 'vulkan'));
const ANGLE_NAMES: Record<Angle, string> = { auto: 'Auto', d3d11: 'Direct3D 11', gl: 'OpenGL', vulkan: 'Vulkan', metal: 'Metal' };

/**
 * Linux: Chromium's sandbox needs either the SUID helper (impossible inside an AppImage: it is a read-only mount, and the .deb only
 * sets it on install) or unprivileged user namespaces, which Ubuntu 24.04 (AppArmor), some Debian and hardened kernels switch off.
 * Without either, Electron aborts at launch with «The SUID sandbox helper binary was found, but is not configured correctly», and the
 * player sees an AppImage that "does nothing" (report 17906, Debian; 17955, Steam Deck from Game Mode). In that case, and only then, the
 * sandbox is turned off: the client only ever loads pokebonk.com (other sites open in the system browser, see `sameSite`).
 */
function linuxNeedsNoSandbox() {
  if (process.platform !== 'linux') return false;
  const read = (f: string) => { try { return readFileSync(f, 'utf8').trim(); } catch { return null; } };
  if (read('/proc/sys/kernel/unprivileged_userns_clone') === '0') return true;
  if (read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1') return true;
  if (read('/proc/sys/user/max_user_namespaces') === '0') return true;
  // An AppImage on a system with an old kernel without user namespaces at all.
  return !!process.env.APPIMAGE && !existsSync('/proc/self/ns/user');
}
if (linuxNeedsNoSandbox() || process.argv.includes('--no-sandbox')) app.commandLine.appendSwitch('no-sandbox');

const launchCfg = readCfg();
// V-Sync stays on whatever the saved setting says (2026-10-31): with `disable-gpu-vsync` + `disable-frame-rate-limit`
// requestAnimationFrame fired thousands of times a second and the game crawled while the FPS counter said hundreds
// (docs/DESKTOP.md). The web game no longer offers the option and switches old clients back on (src/core/desktop.ts).
if (launchCfg.angle !== 'auto') {
  app.commandLine.appendSwitch('use-angle', launchCfg.angle);
  // Vulkan needs its feature on as well in this Chromium.
  if (launchCfg.angle === 'vulkan') app.commandLine.appendSwitch('enable-features', 'Vulkan');
}

/**
 * Windows decides per executable which GPU a program uses (Settings → System → Display → Graphics). Without an
 * entry, a laptop with an RTX can run the game on the integrated GPU. We write «high performance» for this exe once,
 * and never overwrite a choice the player made there.
 */
function preferDedicatedGpuOnWindows() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const key = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences', exe = process.execPath;
  try {
    execFileSync('reg', ['query', key, '/v', exe], { stdio: 'ignore', windowsHide: true });
  } catch {
    try { execFileSync('reg', ['add', key, '/v', exe, '/t', 'REG_SZ', '/d', 'GpuPreference=2;', '/f'], { stdio: 'ignore', windowsHide: true }); } catch { /* no registry access: Chromium's own preference still applies */ }
  }
}
preferDedicatedGpuOnWindows();
// Linux with two GPUs (Mesa): render on the discrete one. A single-GPU machine ignores it.
if (process.platform === 'linux' && !process.env.DRI_PRIME) process.env.DRI_PRIME = '1';

app.setName('PokéBonk');
if (process.platform === 'win32') app.setAppUserModelId('com.pokebonk.desktop');

// One window: a second launch brings the first one forward (two would share the same save and fight over it).
if (!SELFTEST && !app.requestSingleInstanceLock()) app.exit(0);

// ---------------- window state ----------------
type WinState = { x?: number; y?: number; width: number; height: number; maximized?: boolean; fullscreen?: boolean };
const stateFile = () => join(app.getPath('userData'), 'window.json');
function loadState(): WinState {
  try {
    const s = JSON.parse(readFileSync(stateFile(), 'utf8')) as WinState;
    // A window saved on a monitor that is no longer there opens on the main one.
    const visible = s.x !== undefined && s.y !== undefined && screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return s.x! + 100 > a.x && s.x! < a.x + a.width - 100 && s.y! >= a.y - 10 && s.y! < a.y + a.height - 100;
    });
    return visible ? s : { width: s.width, height: s.height, maximized: s.maximized, fullscreen: s.fullscreen };
  } catch {
    const a = screen.getPrimaryDisplay().workAreaSize;
    return { width: Math.min(1600, Math.round(a.width * 0.85)), height: Math.min(900, Math.round(a.height * 0.85)), fullscreen: true };
  }
}
function saveState(win: BrowserWindow) {
  const b = win.getNormalBounds();
  const s: WinState = { ...b, maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
  try { mkdirSync(app.getPath('userData'), { recursive: true }); writeFileSync(stateFile(), JSON.stringify(s)); } catch { /* read-only profile */ }
}

/** The language the game shows (its <html lang>), else the system's. */
async function langNow(wc: WebContents | undefined): Promise<Lang> {
  try { if (wc && !wc.isDestroyed()) return langOf(await wc.executeJavaScript('document.documentElement.lang', true)); } catch { /* page not ready */ }
  return langOf(app.getPreferredSystemLanguages()[0] ?? app.getLocale());
}

// ---------------- the window ----------------
let win: BrowserWindow | null = null;
let quitting = false;

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    x: st.x, y: st.y, width: st.width, height: st.height,
    minWidth: 960,
    minHeight: 540,
    show: false,
    title: 'PokéBonk',
    backgroundColor: '#1a1630',
    icon: join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: DEVTOOLS,
    },
  });
  const w = win, wc = w.webContents;
  if (st.maximized) w.maximize();
  // The loading screen goes up at once (a local page), and the window shows with it: no blank window while
  // pokebonk.com answers. Without it (self-test), the window shows with the game's first paint.
  if (SPLASH) showSplash(w, langOf(app.getPreferredSystemLanguages()[0] ?? app.getLocale()), () => w.show());
  else w.once('ready-to-show', () => w.show());
  // Every load of the game (reload, recovery after a crash) gets the loading screen again, until its menu is up.
  wc.on('did-start-navigation', (d) => {
    if (!d.isMainFrame || d.isSameDocument || !sameSite(d.url)) return;
    if (SPLASH && !splash) showSplash(w, lang);
    if (splash) { splash.p = 0; splashSet(0.04, tr(splash.lang, 'connecting')); }
  });
  wc.on('dom-ready', () => { if (splash && sameSite(wc.getURL())) splashSet(0.15, tr(splash.lang, 'loadingGame')); watchBoot(w); });
  keepAwake(w);
  // Fullscreen is the window's, not the page's (the HTML Fullscreen API, 1.1.0 and before): Chromium takes a short Esc out of
  // the page's before the game sees it, and Electron never grants the Keyboard Lock that holds it back in the browser
  // («pulsan Esc y se sale de la pantalla completa», 2026-10-30). The window's ignores Esc, which reaches the game (pause,
  // close menus). The page learns of it through the bridge (preload.ts: `fullscreen()` and a `fullscreenchange` event).
  if (st.fullscreen) w.setFullScreen(true);
  // From the event, not isFullScreen(): on Windows it still says the old state while they fire.
  for (const on of [true, false]) w.on((on ? 'enter-full-screen' : 'leave-full-screen') as 'enter-full-screen', () => { if (!wc.isDestroyed()) wc.send('pb:fs', on); });
  for (const ev of ['resize', 'move', 'enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize'] as const) w.on(ev as 'resize', () => saveState(w));
  w.on('close', () => saveState(w));
  w.on('closed', () => { win = null; });

  // The browser's user agent plus our tag (reports tell the client apart). Electron adds «PokéBonk/1.0.0 Electron/…»:
  // a non-ASCII name in an HTTP header, so out.
  wc.setUserAgent(`${wc.getUserAgent().replace(/ \S*Bonk\/\S+| Electron\/\S+/g, '')} PokeBonkDesktop/${app.getVersion()}`);
  wc.setVisualZoomLevelLimits(1, 1).catch(() => {});

  // Keys the browser used to handle: F11 fullscreen, F5/Ctrl+R reload (the game asks first during a run),
  // Ctrl+Shift+I developer tools only in development or with --devtools. No zoom (it blurs the pixel art).
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta, key = input.key.toLowerCase();
    if (input.key === 'F11' || (process.platform === 'darwin' && input.meta && input.control && key === 'f')) {
      e.preventDefault();
      setFullscreen(w, !w.isFullScreen());
    } else if (input.key === 'F5' || (ctrl && key === 'r')) { e.preventDefault(); wc.reload(); }
    else if (DEVTOOLS && (input.key === 'F12' || (ctrl && input.shift && key === 'i'))) { e.preventDefault(); wc.toggleDevTools(); }
    else if (ctrl && ['+', '-', '=', '0'].includes(key)) e.preventDefault();
  });

  // The right-click (or long press on a touch screen, as on the Steam Deck) menu Chromium has in a browser and Electron leaves out:
  // without it, on Linux there was no way to paste the name or the password with the mouse or the touch screen (report 17955).
  wc.on('context-menu', (_e, p) => {
    const items: Electron.MenuItemConstructorOptions[] = p.isEditable
      ? [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' }]
      : p.selectionText ? [{ role: 'copy' }] : [];
    if (items.length) Menu.buildFromTemplate(items).popup({ window: w });
  });

  // Links to other sites (Discord, X, credits, legal pages elsewhere) open in the system browser, never in here.
  wc.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => { if (!sameSite(url) && !url.startsWith('file:')) { e.preventDefault(); openOutside(url); } });

  // Leaving during a run: the game's beforeunload asks, and Electron shows nothing by itself. Our own dialog.
  // The handler must answer at once (no await), so the game's language is kept up to date beforehand.
  let lang: Lang = langOf(app.getPreferredSystemLanguages()[0] ?? app.getLocale());
  const readLang = () => { void langNow(wc).then((l) => { lang = l; }); };
  wc.on('did-finish-load', readLang);
  w.on('focus', readLang);
  w.on('blur', readLang);
  wc.on('will-prevent-unload', (e) => {
    if (quitting) { e.preventDefault(); return; }
    const l = lang;
    const r = dialog.showMessageBoxSync(w, {
      type: 'question', title: 'PokéBonk', message: tr(l, 'quitTitle'), detail: tr(l, 'quitRun'),
      buttons: [tr(l, 'keep'), tr(l, 'quit')], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (r === 1) e.preventDefault(); // preventDefault on this event means «ignore the beforeunload and leave»
  });

  // No connection, server down, DNS: our own page with a retry instead of Chromium's error.
  wc.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (!isMain || code === -3 /* aborted: a navigation replaced it */ || url.startsWith('file:')) return;
    hideSplash(w);
    void showOffline(w, 'off');
  });
  // The page crashed or was killed (out of memory after hours of Survival): back to the game, which recovers the run.
  let crashes = 0;
  wc.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit' || quitting) return;
    if (++crashes <= 2) setTimeout(() => { if (!w.isDestroyed()) void w.loadURL(GAME_URL); }, 500);
    else { hideSplash(w); void showOffline(w, 'crash'); }
  });
  wc.on('unresponsive', () => { /* Chromium recovers by itself; a long frame (loading a zone) is not a hang */ });

  if (SELFTEST) selftest(w, SELFTEST);
  void w.loadURL(GAME_URL);
}

/**
 * In and out of the window's fullscreen. Leaving also leaves the page's, if a game from before 1.2.0's bridge asked for
 * it (its own button calls requestFullscreen): that one sits on top and the window's alone would not leave it.
 */
function setFullscreen(w: BrowserWindow, on: boolean) {
  if (!on) void w.webContents.executeJavaScript(`document.fullscreenElement && document.exitFullscreen().catch(() => {})`, true).catch(() => {});
  w.setFullScreen(on);
}

const sameSite = (url: string) => {
  try { const u = new URL(url); return (u.protocol === GAME.protocol && ownHost(u.hostname)) || u.origin === GAME.origin; } catch { return false; }
};
function openOutside(url: string) {
  try { const u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') void shell.openExternal(u.toString()); } catch { /* not a URL */ }
}

async function showOffline(w: BrowserWindow, why: 'off' | 'crash') {
  if (w.isDestroyed()) return;
  const l = await langNow(undefined);
  const q = new URLSearchParams({
    title: tr(l, 'offTitle'), body: tr(l, why === 'crash' ? 'crashed' : 'offBody'), retry: tr(l, 'retry'), url: GAME_URL, lang: l,
  });
  await w.loadFile(join(__dirname, '..', 'static', 'offline.html'), { search: q.toString() }).catch(() => {});
}

// ---------------- loading screen (static/splash.html) ----------------
/**
 * A local page over the game, from the first frame until the game's main menu is up: one of the in-game captures
 * (static/splash/, a different one each launch), the wordmark, tips and a bar that follows the real load (connecting,
 * the page, then the game's own «Cargando Pokédex…» bar, read from its DOM). Not in the self-test (it screenshots the game).
 */
const SPLASH = !SELFTEST || flag('splash');
/** Captures of the game itself (art/source/desktop/captures, docs/ART.md): the four legendary shrines and a horde. */
const SPLASH_ART = ['forest', 'coast', 'glacier', 'desert', 'horde'];
let splash: { view: WebContentsView; lang: Lang; p: number; fit: () => void; since: number } | null = null;

function showSplash(w: BrowserWindow, lang: Lang, onReady?: () => void) {
  if (splash || w.isDestroyed()) return;
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: DEVTOOLS, spellcheck: false } });
  view.setBackgroundColor('#1a1630');
  const fit = () => { const [cw, ch] = w.getContentSize(); view.setBounds({ x: 0, y: 0, width: cw, height: ch }); };
  fit();
  w.on('resize', fit);
  w.contentView.addChildView(view);
  splash = { view, lang, p: 0, fit, since: Date.now() };
  // A different illustration from last time.
  const last = readCfg().lastArt, pool = SPLASH_ART.filter((a) => a !== last), img = pool[Math.floor(Math.random() * pool.length)];
  writeCfg({ lastArt: img });
  const q = new URLSearchParams({ lang, img, tips: JSON.stringify(tips(lang)), tip: tr(lang, 'tip'), label: tr(lang, 'connecting'), ver: app.getVersion() });
  let shown = false;
  const ready = () => { if (!shown) { shown = true; onReady?.(); } };
  view.webContents.once('did-finish-load', ready);
  setTimeout(ready, 1500);
  void view.webContents.loadFile(join(__dirname, '..', 'static', 'splash.html'), { search: q.toString() }).catch(ready);
}
/** Moves the bar (never back) and changes the line under the tip. */
function splashSet(p: number, label?: string) {
  if (!splash || p < splash.p) return;
  splash.p = p;
  void splash.view.webContents.executeJavaScript(`window.pb && pb.set(${p.toFixed(3)}, ${JSON.stringify(label ?? '')})`).catch(() => {});
}
/** Fades the loading screen out and gives the keyboard back to the game. */
function hideSplash(w: BrowserWindow, fade = true) {
  const s = splash;
  if (!s) return;
  splash = null;
  const drop = () => {
    w.off('resize', s.fit);
    if (!w.isDestroyed()) { w.contentView.removeChildView(s.view); w.webContents.focus(); }
    s.view.webContents.close();
  };
  if (!fade) return drop();
  void s.view.webContents.executeJavaScript('window.pb && pb.out()').catch(() => {});
  setTimeout(drop, 480);
}
/**
 * Follows the game's boot from its DOM (src/main.ts, App.boot): its `.loading` screen with the Pokédex bar, then the
 * first real screen (menu, login…). Read from the page, not told by it, so it works with any version of the game.
 * A loading screen that asks something (no connection, the GPU help, «Reintentar») is shown at once: it is the game talking.
 */
function watchBoot(w: BrowserWindow) {
  const wc = w.webContents;
  const tick = async () => {
    if (!splash || w.isDestroyed() || !sameSite(wc.getURL())) return;
    const s = await wc.executeJavaScript(`(() => {
      const ui = document.getElementById('ui');
      const ld = ui && ui.querySelector(':scope > .loading');
      if (!ld) return { screen: !!(ui && ui.querySelector(':scope > .screen')) };
      const bar = ld.querySelector('.bar'), fill = bar && bar.querySelector('i'), label = bar && bar.querySelector('b');
      const m = fill && /scaleX\\(([\\d.]+)\\)/.exec(fill.style.transform);
      return { p: m ? Number(m[1]) : 0, label: label ? label.textContent : '', asks: !bar || !!ld.querySelector('button, .gl-help, .panel') };
    })()`, true).catch(() => null) as { screen?: boolean; p?: number; label?: string; asks?: boolean } | null;
    if (!splash) return;
    const lang = splash.lang;
    if (s?.screen) {
      splashSet(1, tr(lang, 'starting'));
      // A beat for the menu's first frames under the fade.
      setTimeout(() => hideSplash(w), 350);
      return;
    }
    if (s?.asks) return hideSplash(w);
    if (s && s.p !== undefined) splashSet(0.2 + 0.72 * s.p, s.label || undefined);
    // Never stuck behind it: after 90 s the game's own screen says what is going on.
    if (Date.now() - splash.since > 90_000) return hideSplash(w);
    setTimeout(() => void tick(), 200);
  };
  void tick();
}

// ---------------- staying awake ----------------
/**
 * A gamepad doesn't count as input for the system: playing with one, the screen dimmed and turned off mid-run. While
 * the window is in front and not minimized, the display stays on (released as soon as it isn't).
 */
function keepAwake(w: BrowserWindow) {
  let id = -1;
  const sync = () => {
    const on = !w.isDestroyed() && w.isFocused() && !w.isMinimized() && w.isVisible();
    if (on && id < 0) id = powerSaveBlocker.start('prevent-display-sleep');
    else if (!on && id >= 0) { powerSaveBlocker.stop(id); id = -1; }
  };
  for (const ev of ['focus', 'blur', 'minimize', 'restore', 'show', 'hide'] as const) w.on(ev as 'focus', sync);
  w.on('closed', () => { if (id >= 0) powerSaveBlocker.stop(id); });
}

// ---------------- the GPU going wrong ----------------
/**
 * The GPU process crashing again and again (a driver that doesn't get along with ANGLE's default backend): Chromium
 * ends up drawing WebGL in software (about 10 fps) or black. Once per launch, after the third crash, the client offers
 * another backend and restarts with it.
 */
function watchGpu() {
  let crashes = 0, offered = false;
  app.on('child-process-gone', (_e, d) => {
    if (d.type !== 'GPU' || d.reason === 'clean-exit' || quitting || offered || ++crashes < 3 || !win) return;
    offered = true;
    const w = win, next = angleFallback(launchCfg.angle === 'auto' ? (process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'gl') : launchCfg.angle);
    void langNow(w.webContents).then(async (l) => {
      const { response } = await dialog.showMessageBox(w, {
        type: 'warning', title: 'PokéBonk', message: tr(l, 'gpuTitle'), detail: tr(l, 'gpuBody', { b: ANGLE_NAMES[next] }),
        buttons: [tr(l, 'gpuTry'), tr(l, 'later')], defaultId: 0, cancelId: 1, noLink: true,
      });
      if (response === 0) { writeCfg({ angle: next }); app.relaunch(); w.close(); }
    });
  });
}

// ---------------- what the page may ask for ----------------
function permissions() {
  const allowed = new Set(['fullscreen', 'pointerLock', 'keyboardLock', 'clipboard-sanitized-write', 'media']);
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(allowed.has(perm) && (sameSite(details.requestingUrl) || wc.getURL().startsWith('file:'))));
  ses.setPermissionCheckHandler((_wc, perm, origin) => allowed.has(perm) && sameSite(origin));
}

// ---------------- the page's bridge (preload.ts) ----------------
/**
 * Ajustes → Pantalla (src/ui/menus.ts, only in the client): window or fullscreen, the window's size, the monitor and
 * V-Sync. Fullscreen is the window's (setFullscreen), so Esc never leaves it.
 */
type DisplayState = {
  mode: 'fullscreen' | 'window';
  /** 'max', a preset 'WxH' (content size) or 'custom' (dragged by hand). */
  size: string;
  /** The presets that fit the monitor the window is on. */
  sizes: string[];
  monitor: number;
  monitors: { label: string; primary: boolean }[];
  vsync: boolean;
  /** V-Sync after a restart (differs from `vsync` until the client is restarted). */
  vsyncNext: boolean;
  /** Graphics backend (Motor gráfico): the running one, the one after a restart and the ones this system offers. */
  angle: Angle;
  angleNext: Angle;
  angles: Angle[];
  /** Discord Rich Presence on (1.4.0; see discord.ts). */
  discord: boolean;
};
const SIZES = [[1280, 720], [1600, 900], [1920, 1080], [2560, 1440], [3200, 1800], [3840, 2160]];
const displays = () => [...screen.getAllDisplays()].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
function displayState(w: BrowserWindow): DisplayState {
  const list = displays(), on = screen.getDisplayMatching(w.getBounds()), primary = screen.getPrimaryDisplay().id;
  // Sizes are real pixels (what players know: 1920×1080), the window works in scaled ones (125 % on many laptops).
  const k = on.scaleFactor, wa = on.workAreaSize, [cw, ch] = w.getContentSize().map((v) => Math.round(v * k));
  const sizes = SIZES.filter(([sw, sh]) => sw / k <= wa.width && sh / k <= wa.height - 40).map(([sw, sh]) => `${sw}x${sh}`);
  const preset = sizes.find((v) => { const [sw, sh] = v.split('x').map(Number); return Math.abs(sw - cw) <= 2 && Math.abs(sh - ch) <= 2; });
  return {
    mode: w.isFullScreen() ? 'fullscreen' : 'window',
    size: w.isMaximized() ? 'max' : preset ?? 'custom',
    sizes,
    monitor: Math.max(0, list.findIndex((d) => d.id === on.id)),
    monitors: list.map((d) => ({
      label: `${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}${d.displayFrequency ? ` · ${Math.round(d.displayFrequency)} Hz` : ''}`,
      primary: d.id === primary,
    })),
    vsync: launchCfg.vsync,
    vsyncNext: readCfg().vsync,
    angle: launchCfg.angle,
    angleNext: readCfg().angle,
    angles: ANGLES,
    discord: readCfg().discord,
  };
}
/** Resolves once the window has left (or entered) fullscreen, or after 1.5 s. */
const fsSettled = (w: BrowserWindow, on: boolean) => new Promise<void>((res) => {
  if (w.isFullScreen() === on) return res();
  const ev = (on ? 'enter-full-screen' : 'leave-full-screen') as 'enter-full-screen';
  const done = () => { clearTimeout(t); w.off(ev, done); setTimeout(res, 150); };
  const t = setTimeout(done, 1500);
  w.once(ev, done);
});
async function setDisplay(w: BrowserWindow, p: { mode?: string; size?: string; monitor?: number; vsync?: boolean; angle?: string; discord?: boolean }) {
  if (p.discord !== undefined) { writeCfg({ discord: !!p.discord }); presence.enable(!!p.discord); }
  if (p.vsync !== undefined) writeCfg({ vsync: !!p.vsync });
  if (p.angle !== undefined && (ANGLES as string[]).includes(p.angle)) writeCfg({ angle: p.angle as Angle });
  if (p.monitor !== undefined) {
    const d = displays()[p.monitor];
    if (d && d.id !== screen.getDisplayMatching(w.getBounds()).id) {
      const wasFs = w.isFullScreen();
      if (wasFs) { setFullscreen(w, false); await fsSettled(w, false); }
      if (w.isMaximized()) w.unmaximize();
      const a = d.workArea, [ow, oh] = w.getSize(), ww = Math.min(ow, a.width), hh = Math.min(oh, a.height);
      w.setBounds({ x: a.x + Math.round((a.width - ww) / 2), y: a.y + Math.round((a.height - hh) / 2), width: ww, height: hh });
      if (wasFs) { setFullscreen(w, true); await fsSettled(w, true); }
    }
  }
  if (p.mode === 'fullscreen') { setFullscreen(w, true); await fsSettled(w, true); }
  if (p.mode === 'window' || p.size) {
    setFullscreen(w, false); await fsSettled(w, false);
  }
  if (p.size === 'max') w.maximize();
  else if (p.size && /^\d+x\d+$/.test(p.size)) {
    const [sw, sh] = p.size.split('x').map(Number), k = screen.getDisplayMatching(w.getBounds()).scaleFactor;
    if (w.isMaximized()) w.unmaximize();
    w.setContentSize(Math.round(sw / k), Math.round(sh / k));
    w.center();
  }
  saveState(w);
  return displayState(w);
}
ipcMain.handle('pb:display', () => (win ? displayState(win) : null));
ipcMain.handle('pb:setDisplay', (_e, p) => (win ? setDisplay(win, p ?? {}) : null));
ipcMain.on('pb:relaunch', () => { app.relaunch(); win?.close(); });
ipcMain.on('pb:fullscreen', (e) => { e.returnValue = !!win?.isFullScreen(); });
ipcMain.on('pb:quit', () => { win?.close(); });
ipcMain.on('pb:retry', () => { if (win && !win.isDestroyed()) void win.loadURL(GAME_URL); });

// ---------------- Discord Rich Presence (discord.ts) ----------------
/**
 * «Jugando a PokéBonk» from launch, with the logo, the time played and a «Jugar gratis» button for friends. The game adds what is
 * going on (`pokebonkDesktop.presence`, src/core/desktop.ts): menu, the Pokémon and zone of the run, the minute. Images only from the
 * game's own site; texts cut to Discord's 128 characters.
 */
const presence = new DiscordPresence(DISCORD_APP_ID);
const launchedAt = Date.now();
const SITE = 'https://pokebonk.com';
function baseActivity(l: Lang): Activity {
  return { start: launchedAt, largeImage: `${SITE}/assets/ui/desktop/app.png`, largeText: 'PokéBonk', buttons: [{ label: tr(l, 'rpcPlay'), url: SITE }] };
}
const clean = (v: unknown) => (typeof v === 'string' && v.trim().length >= 2 ? v.trim().slice(0, 128) : undefined);
const img = (v: unknown) => { try { const u = new URL(String(v)); return u.protocol === 'https:' && (u.hostname === 'pokebonk.com' || u.hostname.endsWith('.pokebonk.com')) ? u.toString() : undefined; } catch { return undefined; } };
ipcMain.on('pb:presence', (e, p: Record<string, unknown> | null) => {
  if (!win || e.sender !== win.webContents || !sameSite(e.sender.getURL())) return;
  void langNow(win.webContents).then((l) => {
    const a = baseActivity(l);
    if (p && typeof p === 'object') {
      a.details = clean(p.details);
      a.state = clean(p.state);
      if (typeof p.start === 'number' && p.start > 1.6e12 && p.start <= Date.now() + 60_000) a.start = Math.round(p.start);
      a.largeImage = img(p.largeImage) ?? a.largeImage;
      a.largeText = clean(p.largeText) ?? a.largeText;
      a.smallImage = img(p.smallImage);
      a.smallText = a.smallImage ? clean(p.smallText) : undefined;
    }
    presence.set(a);
  });
});

// ---------------- client updates ----------------
/**
 * The game updates by itself (it is the website). The shell updates by itself too from 1.4.0 where it can (updater.ts: Windows setup and
 * AppImage), installing when the game closes; the game's bar offers «Reiniciar» once it is downloaded. Elsewhere (macOS, portable,
 * .deb) the GAME says there is a new download (src/ui/update.ts, `checkDesktopUpdate`, from `/desktop.json`).
 */

let splashGoneMs: number | null = null;
// ---------------- self-test (`--selftest=<dir>`): GPU report and a screenshot, then quit ----------------
function selftest(w: BrowserWindow, dir: string) {
  mkdirSync(dir, { recursive: true });
  // With --splash: the loading screen at 0.6, 2 and 4 s (splash-*.png) and how long it took to give way to the menu.
  const t0 = Date.now();
  if (SPLASH) for (const ms of [600, 2000, 4000]) setTimeout(() => {
    void splash?.view.webContents.capturePage().then((img) => writeFileSync(join(dir, `splash-${ms}.png`), img.toPNG())).catch(() => {});
  }, ms);
  const gone = setInterval(() => { if (!splash) { clearInterval(gone); splashGoneMs = Date.now() - t0; } }, 50);
  w.webContents.once('did-finish-load', () => setTimeout(async () => {
    const webgl = await w.webContents.executeJavaScript(`(() => {
      const gl = document.createElement('canvas').getContext('webgl2', { powerPreference: 'high-performance' });
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null, ua: navigator.userAgent,
        desktop: typeof pokebonkDesktop === 'object' ? Object.keys(pokebonkDesktop).join(',') + ' ' + pokebonkDesktop.version + ' ' + pokebonkDesktop.platform : null, lang: document.documentElement.lang,
        screen: innerWidth + 'x' + innerHeight + '@' + devicePixelRatio, keyboardLock: !!(navigator.keyboard && navigator.keyboard.lock) };
    })()`, true).catch((e) => ({ error: String(e) }));
    // `--selftest-js=<file>`: an async function body run in the page (with `npm run dev`, window.pokebonk is the App).
    const js = arg('selftest-js');
    const script = js ? await w.webContents.executeJavaScript(`(async () => { ${readFileSync(js, 'utf8')} })()`, true).catch((e) => ({ error: String(e) })) : undefined;
    const report = { splashGoneMs, script, version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, url: w.webContents.getURL(),
      gpuFeatures: app.getGPUFeatureStatus(), gpu: await app.getGPUInfo('complete').then((g: any) => ({ active: g.gpuDevice?.find((d: any) => d.active)?.deviceString, gl: g.auxAttributes?.glImplementationParts })).catch(() => null), webgl };
    writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(dir, 'screen.png'), (await w.webContents.capturePage()).toPNG());
    quitting = true;
    app.exit(0);
  }, Number(arg('selftest-wait') ?? 12000)));
}

// ---------------- app ----------------
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => { /* closing goes through the window's beforeunload (the run dialog) */ });
app.on('window-all-closed', () => app.quit());
app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    // macOS keeps an app menu (Cmd+Q, copy and paste in the name fields, fullscreen).
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'togglefullscreen' }] }, { role: 'windowMenu' }]));
  } else Menu.setApplicationMenu(null);
  permissions();
  watchGpu();
  createWindow();
  if (!SELFTEST) {
    presence.set(baseActivity(langOf(app.getPreferredSystemLanguages()[0] ?? app.getLocale())));
    presence.enable(readCfg().discord);
    if (!process.env.POKEBONK_DISCORD_ID) void remoteAppId().then((id) => { if (id) presence.useApp(id); });
    startUpdater(() => win, () => { quitting = true; });
  }
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
