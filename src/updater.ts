/**
 * Automatic client updates (docs/DESKTOP.md, «Actualizaciones del cliente», 1.4.0): electron-updater reads the latest GitHub
 * release of CharcherGit/pokebonk-app (its latest.yml / latest-linux.yml, `publish` in electron-builder.yml), downloads the new
 * version in the background and installs it when the player closes the game (or at once, if they press «Reiniciar» in the
 * game's bar). Only where it can work:
 *  - Windows installed with the setup (not the portable .exe, which has no installer to run).
 *  - Linux as an AppImage (the .deb belongs to the system's package manager).
 *  - Not macOS: Squirrel.Mac only installs updates signed with the same Apple Developer identity, and ours is ad-hoc.
 * Everywhere else the game's bar keeps saying «Descargar» (src/ui/update.ts, `checkDesktopUpdate`).
 */
import { app, ipcMain, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

export type UpdateState = {
  /** off: this install can't update itself. idle: up to date. ready: downloaded, installs on quit. */
  state: 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
  version?: string;
  percent?: number;
};

export const canAutoUpdate = () =>
  app.isPackaged && ((process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR) || (process.platform === 'linux' && !!process.env.APPIMAGE));

let st: UpdateState = { state: 'off' };
let getWin: () => BrowserWindow | null = () => null;

function set(s: UpdateState) {
  st = s;
  const w = getWin();
  if (w && !w.isDestroyed()) w.webContents.send('pb:update', st);
}

/** Starts checking (10 s after launch, then every 4 h) if this install can update itself. */
export function startUpdater(win: () => BrowserWindow | null, beforeInstall: () => void) {
  getWin = win;
  ipcMain.handle('pb:updateState', () => st);
  ipcMain.on('pb:updateInstall', () => {
    if (st.state !== 'ready') return;
    beforeInstall();
    // Silent (the assisted installer's pages were seen on the first install; it keeps the folder) and opens the game again.
    autoUpdater.quitAndInstall(true, true);
  });
  if (!canAutoUpdate()) return;
  st = { state: 'idle' };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Suffixed fork builds (1.4.0-cprivitere.1) live on GitHub prereleases: only they look at them. Stock 1.4.0 keeps false.
  autoUpdater.allowPrerelease = app.getVersion().includes('-');
  const log = (m: unknown) => console.warn('[update]', String(m).split(/\r?\n/)[0]);
  autoUpdater.logger = { info: () => {}, warn: log, error: log, debug: () => {} };
  autoUpdater.on('checking-for-update', () => { if (st.state !== 'ready') set({ state: 'checking' }); });
  autoUpdater.on('update-not-available', () => set({ state: 'idle' }));
  autoUpdater.on('update-available', (i) => set({ state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', version: st.version, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => set({ state: 'ready', version: i.version }));
  // No network, GitHub slow or blocked (China): nothing to tell the player, the next check tries again.
  autoUpdater.on('error', () => { if (st.state !== 'ready') set({ state: 'error' }); });
  const check = () => { if (st.state !== 'ready' && st.state !== 'downloading') autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 10_000);
  setInterval(check, 4 * 3600_000);
}
