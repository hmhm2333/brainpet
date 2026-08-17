export type DeferredHostSurfaceResult<T> =
  | { ok: true; value: T }
  | { ok: false; cause: unknown };

/**
 * Electron invokes HostCore pet/tray work from timer callbacks, where an
 * uncaught synchronous exception would otherwise escape the service lifecycle.
 * Keep those UI surfaces explicitly degradable and never let reporting failure
 * turn the original optional-surface failure into a process-level exception.
 */
export function runDeferredHostSurface<T>(
  operation: () => T,
  reportFailure: (cause: unknown) => void,
): DeferredHostSurfaceResult<T> {
  try {
    return { ok: true, value: operation() };
  } catch (cause) {
    try {
      reportFailure(cause);
    } catch {
      // Logging/diagnostics are also non-critical in a deferred UI callback.
    }
    return { ok: false, cause };
  }
}
