export type ResourceCleanup = () => void | Promise<void>;

export async function runResourceTransaction<T>(
  work: (defer: (cleanup: ResourceCleanup) => void) => Promise<T>,
  onCleanupError?: (error: unknown) => void,
): Promise<T> {
  const cleanups: ResourceCleanup[] = [];
  let acceptingCleanups = true;

  const defer = (cleanup: ResourceCleanup): void => {
    if (!acceptingCleanups) throw new Error("Resource transaction is already settled.");
    let completed = false;
    cleanups.push(async () => {
      if (completed) return;
      completed = true;
      await cleanup();
    });
  };

  try {
    const result = await work(defer);
    acceptingCleanups = false;
    return result;
  } catch (originalError) {
    acceptingCleanups = false;
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (cleanupError) {
        onCleanupError?.(cleanupError);
      }
    }
    throw originalError;
  }
}
