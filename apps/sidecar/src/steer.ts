/** Thrown when the active turn cannot absorb a follow-up (no turn, slash command, protocol refuse). */
export class SteerUnavailableError extends Error {
  constructor(message = 'steer unavailable') {
    super(message);
    this.name = 'SteerUnavailableError';
  }
}

export function isSteerUnavailableError(error: unknown): boolean {
  return error instanceof SteerUnavailableError
    || (error instanceof Error && error.name === 'SteerUnavailableError');
}

/** Slash commands are turn-control, not steer-able user follow-ups. */
export function isSteerBlockedPrompt(prompt: string): boolean {
  return prompt.trim().startsWith('/');
}
