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
  #startPromise: Promise<void> | null = null;
  #disposePromise: Promise<void> | null = null;

  public constructor(factories: readonly DesktopServiceFactory[]) {
    this.#factories = factories;
  }

  public start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#startAll();
    return this.#startPromise;
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = this.#disposeAll();
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
        const service = await factory();
        this.#services.push(service);
        await service.start();
      }
    } catch (error) {
      this.#disposePromise ??= this.#disposeAll();
      await this.#disposePromise;
      throw error;
    }
  }

  async #disposeAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const service of [...this.#services].reverse()) {
      try {
        await service.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Desktop service disposal failed.");
  }
}
