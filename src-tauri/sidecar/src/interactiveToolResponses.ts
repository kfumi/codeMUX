type PendingInteractiveToolResponse = {
  resolve: (value: unknown) => void;
};

const pendingInteractiveToolResponses = new Map<string, PendingInteractiveToolResponse>();

export function waitForInteractiveToolResponse(toolUseId: string): Promise<unknown> {
  return new Promise((resolve) => {
    pendingInteractiveToolResponses.set(toolUseId, { resolve });
  });
}

export function resolveInteractiveToolResponse(toolUseId: string, response: unknown): boolean {
  const pending = pendingInteractiveToolResponses.get(toolUseId);
  if (!pending) {
    return false;
  }

  pendingInteractiveToolResponses.delete(toolUseId);
  pending.resolve(response);
  return true;
}
