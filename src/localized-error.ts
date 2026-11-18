/** One user-facing failure. CLI callers keep the original diagnostic in Error.message. */
export interface LocalizedMessage {
  key: string;
  params?: Record<string, string>;
  diagnostic?: string;
}

export class LocalizedError extends Error {
  readonly localized: LocalizedMessage;

  constructor(message: string, localized: LocalizedMessage) {
    super(message);
    this.localized = localized;
  }
}
