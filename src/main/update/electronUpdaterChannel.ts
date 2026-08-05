import { autoUpdater } from "electron-updater";
import type { ChannelEvent, CheckOutcome, UpdateChannel } from "./channel";

// ---------------------------------------------------------------------------
// 2026-08-04 : LE MECANISME WINDOWS, DEPLACE SANS ETRE MODIFIE.
//
// Tout ce fichier vient du constructeur de src/main/updater.ts, VERBATIM. C'est
// le seul chemin de mise a jour qui fonctionne aujourd'hui, et le seul que Roch
// utilise ; le deplacer etait la partie risquee de la refonte, donc rien n'a ete
// « ameliore » au passage. Les commentaires d'origine sont conserves parce qu'ils
// portent des decisions, pas des descriptions.
// ---------------------------------------------------------------------------

export class ElectronUpdaterChannel implements UpdateChannel {
  readonly kind = "electron-updater";
  private emit: (e: ChannelEvent) => void = () => {};

  constructor(log: (msg: string) => void) {
    // Explicit rather than relying on the library defaults: these two are the
    // whole update strategy, and a future major flipping a default silently is
    // exactly the kind of surprise this app cannot afford.
    autoUpdater.autoDownload = true; // fetch in the background; installing is the guarded part
    autoUpdater.autoInstallOnAppQuit = true; // the natural swap: user quits, next launch is new
    // 2026-07-31, security pass: the same "explicit, not inherited" rule as the
    // two above, applied to the one default that is a SECURITY property rather
    // than a strategy. A downgrade is how an attacker who can publish gets a
    // machine back onto a version whose hole is already patched - the update
    // channel used in reverse. The library defaults this to false today; that is
    // exactly why it is written down, because a default nobody states is a
    // default nobody notices changing.
    autoUpdater.allowDowngrade = false;
    // Pre-releases are not a channel this app publishes, and accepting one would
    // widen what a compromised release page can push onto a machine.
    autoUpdater.allowPrerelease = false;

    autoUpdater.logger = {
      info: (m?: unknown) => log(`[updater] ${String(m)}`),
      warn: (m?: unknown) => log(`[updater] warn: ${String(m)}`),
      error: (m?: unknown) => log(`[updater] error: ${String(m)}`),
    };

    autoUpdater.on("checking-for-update", () => this.emit({ kind: "checking" }));
    autoUpdater.on("update-not-available", (info) => this.emit({ kind: "not-available", version: info.version }));
    autoUpdater.on("update-available", (info) => this.emit({ kind: "available", version: info.version }));
    autoUpdater.on("download-progress", (p) => this.emit({ kind: "progress", pct: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (e) => this.emit({ kind: "downloaded", version: e.version }));
    autoUpdater.on("error", (err) => this.emit({ kind: "error", message: err.message }));
  }

  onEvent(cb: (e: ChannelEvent) => void): void {
    this.emit = cb;
  }

  async check(): Promise<CheckOutcome> {
    try {
      const result = await autoUpdater.checkForUpdates();
      // autoDownload is on, so when something is available the download has
      // already started; from here the event handlers own the state.
      return { ok: true, available: result?.isUpdateAvailable === true, version: result?.updateInfo.version ?? "" };
    } catch (err) {
      // The "error" event has already recorded the phase; this is only about
      // what the caller gets to say.
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  install(): void {
    // Silent install, then relaunch. Relaunching matters: Flow is a hotkey
    // daemon, and an update that leaves the machine with no push-to-talk until
    // the next login is a worse outcome than a window reappearing.
    autoUpdater.quitAndInstall(true, true);
  }
}
