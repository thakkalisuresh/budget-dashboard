/** A fetcher signals "nothing there yet" (404, empty listing) vs a real failure. */
export class MfFetchError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'MfFetchError';
    this.kind = kind === 'missing' ? 'missing' : 'failed';
  }
}
