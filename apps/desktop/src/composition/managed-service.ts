export type DesktopServiceState = "created" | "started" | "disposed" | "failed";

export interface DesktopServiceDiagnostics {
  readonly id: string;
  readonly state: DesktopServiceState;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface DesktopManagedService {
  readonly id: string;
  start(): void | Promise<void>;
  dispose(): void | Promise<void>;
  diagnostics(): DesktopServiceDiagnostics;
  focusOpenTasks?(): void;
}

export type DesktopServiceFactory = () => DesktopManagedService | Promise<DesktopManagedService>;

export class DesktopServiceLifecycle {
  readonly #factories: readonly DesktopServiceFactory[];
  readonly #services: DesktopManagedService[] = [];
  readonly #disposedServices = new WeakSet<DesktopManagedService>();
  #startPromise: Promise<void> | null = null;
  #disposePromise: Promise<void> | null = null;
  #disposeRequested = false;

  public constructor(factories: readonly DesktopServiceFactory[]) {
    this.#factories = factories;
  }

  public start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    if (this.#disposeRequested) return Promise.resolve();
    this.#startPromise = this.#startAll();
    return this.#startPromise;
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposeRequested = true;
    this.#disposePromise = this.#disposeAfterStart();
    return this.#disposePromise;
  }

  public diagnostics(): readonly DesktopServiceDiagnostics[] {
    return this.#services.map((service) => service.diagnostics());
  }

  public focusOpenTasks(): void {
    for (const service of this.#services) service.focusOpenTasks?.();
  }

  async #startAll(): Promise<void> {
    try {
      for (const factory of this.#factories) {
        if (this.#disposeRequested) return;
        const service = await factory();
        this.#services.push(service);
        if (this.#disposeRequested) return;
        await service.start();
        if (this.#disposeRequested) return;
      }
    } catch (error) {
      this.#disposeRequested = true;
      await this.#disposeAll();
      throw error;
    }
  }

  async #disposeAfterStart(): Promise<void> {
    await this.#startPromise?.catch(() => undefined);
    await this.#disposeAll();
  }

  async #disposeAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const service of [...this.#services].reverse()) {
      if (this.#disposedServices.has(service)) continue;
      this.#disposedServices.add(service);
      try {
        await service.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Desktop service disposal failed.");
  }
}
