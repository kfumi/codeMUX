export async function nextWithTimeout<T>(
  next: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => T | never,
  additionalPromises: Promise<T>[] = [],
): Promise<T> {
  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return await next();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        try {
          resolve(onTimeout());
        } catch (error) {
          reject(error);
        }
      }, timeoutMs);
      timer.unref?.();
    });

    return await Promise.race([next(), timeout, ...additionalPromises]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
