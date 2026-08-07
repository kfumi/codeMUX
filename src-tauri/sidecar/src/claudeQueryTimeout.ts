export async function nextWithTimeout<T>(
  next: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => T | never,
  additionalPromises: Promise<T>[] = [],
  keepWaiting: () => boolean = () => false,
): Promise<T> {
  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return await Promise.race([next(), ...additionalPromises]);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<T>((resolve, reject) => {
      const arm = (): void => {
        timer = setTimeout(() => {
          if (keepWaiting()) {
            arm();
            return;
          }
          try {
            resolve(onTimeout());
          } catch (error) {
            reject(error);
          }
        }, timeoutMs);
        timer.unref?.();
      };
      arm();
    });

    return await Promise.race([next(), timeout, ...additionalPromises]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
