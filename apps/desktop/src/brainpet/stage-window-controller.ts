import type { BrowserWindow, IpcMainEvent, Session } from "electron";
import { join } from "node:path";

import { debug, error as logError, info, warn } from "../logger.js";
import { isBrainPetPointInsideRectangle } from "./interaction-rig.js";
import type { BrainPetInteractionRigController } from "./interaction-rig-controller.js";
import type { BrainPetSessionAuthority } from "./session-authority.js";

const STAGE_HOST_EVENT_CHANNEL = "brainpet:host-event";

export interface BrainPetStageWindowControllerOptions {
  readonly authority: BrainPetSessionAuthority;
  readonly rigController: BrainPetInteractionRigController;
  readonly resolveDefaultAnchor: () => BrowserWindow | null;
  readonly createWindow: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
  readonly getAppPath: () => string;
  readonly getCursorScreenPoint: () => Electron.Point;
  readonly rendererUrl?: string;
  readonly exerciser?: boolean;
  readonly onClosed?: () => void | Promise<void>;
}

export class BrainPetStageWindowController {
  private stageWindow: BrowserWindow | null = null;
  private hitTestTimer: NodeJS.Timeout | null = null;
  private rendererRequestedInteractive = false;
  private mouseInteractive: boolean | null = null;
  private readonly hardenedSessions = new WeakSet<Session>();
  private readonly createWindow: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
  private readonly getAppPath: () => string;
  private readonly getCursorScreenPoint: () => Electron.Point;
  private disposed = false;

  constructor(private readonly options: BrainPetStageWindowControllerOptions) {
    this.createWindow = options.createWindow;
    this.getAppPath = options.getAppPath;
    this.getCursorScreenPoint = options.getCursorScreenPoint;
  }

  get window(): BrowserWindow | null {
    return this.stageWindow;
  }

  get isOpen(): boolean {
    return Boolean(this.stageWindow && !this.stageWindow.isDestroyed());
  }

  open(anchorWindow?: BrowserWindow): void {
    if (this.disposed) return;
    const current = this.stageWindow;
    if (current && !current.isDestroyed()) {
      if (anchorWindow && !anchorWindow.isDestroyed() && anchorWindow !== this.options.rigController.anchorWindow) {
        this.options.rigController.replaceAnchor(anchorWindow);
      } else {
        this.options.rigController.synchronizeFromPet();
      }
      if (current.isMinimized()) current.restore();
      current.show();
      current.focus();
      return;
    }

    const resolvedAnchor = anchorWindow && !anchorWindow.isDestroyed() ? anchorWindow : this.options.resolveDefaultAnchor();
    if (!resolvedAnchor || resolvedAnchor.isDestroyed()) {
      warn("brainpet.host", "stage open skipped because no live pet anchor exists");
      return;
    }

    this.options.authority.beginOpen();
    const rig = this.options.rigController.start(resolvedAnchor);
    const bounds = rig.overlayBoundsScreen;
    const window = this.createWindow({
      title: "BrainPet Training Stage",
      ...bounds,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
        webgl: false,
        partition: "persist:brainpet-stage",
        preload: join(this.getAppPath(), "brainpet-preload.cjs"),
      },
    });

    const stageSession = window.webContents.session;
    this.stageWindow = window;
    resolvedAnchor.webContents.send("openpets:brainpet-stage-state", { open: true });
    this.rendererRequestedInteractive = false;
    this.mouseInteractive = false;
    window.setIgnoreMouseEvents(true, { forward: true });
    this.hardenSession(stageSession);
    window.setMenu(null);
    window.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "normal");
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-redirect", (event) => event.preventDefault());
    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
      logError("brainpet.host", "stage load failed", { errorCode, errorDescription });
      this.close("load-failed");
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      logError("brainpet.host", "stage renderer gone", { reason: details.reason, exitCode: details.exitCode });
      this.close("renderer-gone");
    });
    window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      const fields = { level, message, line, sourceId };
      if (level >= 3) logError("brainpet.stage", "renderer console", fields);
      else if (level === 2) warn("brainpet.stage", "renderer console", fields);
      else debug("brainpet.stage", "renderer console", fields);
    });
    window.once("ready-to-show", () => {
      if (window.isDestroyed()) return;
      this.options.rigController.synchronizeFromPet();
      window.show();
      window.focus();
    });
    window.on("closed", () => {
      if (this.stageWindow === window) this.stageWindow = null;
      this.options.rigController.disposeStage();
      this.stopHitTestTimer();
      this.options.authority.stageClosed();
      void stageSession.clearCache().catch((error: unknown) => debug("brainpet.host", "stage cache release failed", { error: error instanceof Error ? error.message : String(error) }));
      if (!this.disposed) void this.options.onClosed?.();
      info("brainpet.host", "stage closed");
    });

    this.startHitTestTimer();
    const devUrl = getSafeRendererDevUrl(this.options.rendererUrl ?? process.env.OPENPETS_RENDERER_URL);
    const load = devUrl
      ? window.loadURL(new URL("brainpet.html", devUrl).toString())
      : window.loadFile(join(this.getAppPath(), "dist", "renderer", "brainpet.html"));
    void load.catch((error: unknown) => {
      logError("brainpet.host", "stage load rejected", error);
      this.close("load-rejected");
    });
    info("brainpet.host", "stage opening", { bounds, mode: this.getMode() });
  }

  close(reason = "requested"): void {
    const window = this.stageWindow;
    if (!window || window.isDestroyed()) {
      this.stageWindow = null;
      return;
    }
    this.options.authority.beginClose();
    info("brainpet.host", "stage close requested", { reason });
    const anchor = this.options.rigController.anchorWindow;
    if (anchor && !anchor.isDestroyed()) anchor.webContents.send("openpets:brainpet-stage-state", { open: false });
    window.close();
  }

  setRendererInteractive(interactive: boolean): void {
    this.rendererRequestedInteractive = interactive;
    this.refreshMouseInteractivity();
  }

  sendHostEvent(event: Record<string, unknown>): void {
    const window = this.stageWindow;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(STAGE_HOST_EVENT_CHANNEL, event);
  }

  isSender(event: Pick<IpcMainEvent, "sender">): boolean {
    return Boolean(this.stageWindow && !this.stageWindow.isDestroyed() && event.sender === this.stageWindow.webContents);
  }

  assertSender(event: Electron.IpcMainInvokeEvent): void {
    if (!this.isSender(event)) throw new Error("BrainPet IPC sender is not the active stage.");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.close("controller-disposed");
    this.stopHitTestTimer();
  }

  private getMode(): "stage-exerciser" | "training" {
    return (this.options.exerciser ?? process.env.OPENPETS_BRAINPET_EXERCISER === "1") ? "stage-exerciser" : "training";
  }

  private hardenSession(stageSession: Session): void {
    if (this.hardenedSessions.has(stageSession)) return;
    this.hardenedSessions.add(stageSession);
    stageSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    stageSession.on("will-download", (event) => event.preventDefault());
  }

  private startHitTestTimer(): void {
    this.stopHitTestTimer();
    this.refreshMouseInteractivity();
    this.hitTestTimer = setInterval(() => this.refreshMouseInteractivity(), 25);
    this.hitTestTimer.unref?.();
  }

  private stopHitTestTimer(): void {
    if (this.hitTestTimer) clearInterval(this.hitTestTimer);
    this.hitTestTimer = null;
    this.rendererRequestedInteractive = false;
    this.mouseInteractive = null;
  }

  private refreshMouseInteractivity(): void {
    const window = this.stageWindow;
    const rig = this.options.rigController.snapshot;
    if (!window || window.isDestroyed() || !rig) return;
    const cursor = this.getCursorScreenPoint();
    const stageInteractive = isBrainPetPointInsideRectangle(cursor, rig.stageBoundsScreen, 3);
    const interactive = this.rendererRequestedInteractive || stageInteractive;
    if (this.mouseInteractive === interactive) return;
    this.mouseInteractive = interactive;
    window.setIgnoreMouseEvents(!interactive, { forward: true });
  }
}

function getSafeRendererDevUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}
