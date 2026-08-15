export class AsyncOperationDisposedError extends Error {
  public constructor(owner: string) {
    super(`${owner} is disposing.`);
    this.name = "AsyncOperationDisposedError";
  }
}

export class AsyncOperationGate {
  readonly #pending = new Set<Promise<unknown>>();
  #disposeRequested = false;

  public constructor(private readonly owner: string) {}

  public get isDisposeRequested(): boolean {
    return this.#disposeRequested;
  }

  public assertActive(): void {
    if (this.#disposeRequested) throw new AsyncOperationDisposedError(this.owner);
  }

  public run<T>(operation: (assertActive: () => void) => Promise<T>): Promise<T> {
    this.assertActive();
    const pending = operation(() => this.assertActive());
    this.#pending.add(pending);
    const remove = () => this.#pending.delete(pending);
    pending.then(remove, remove);
    return pending;
  }

  public dispose(): Promise<void> {
    this.#disposeRequested = true;
    return this.#drain();
  }

  async #drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }
}
