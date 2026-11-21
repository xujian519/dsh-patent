/** Fixture for `dsh-no-dynamic-code`: a registration table must not be reported. */

/** Entry of the fixture handler table. */
export interface Handler {
  /** Runs the handler. */
  run(): string
}

const handlers: Record<string, Handler> = {
  greet: { run: () => 'hello' },
}

/**
 * Look up a handler by name.
 * @param name - registered handler name.
 * @returns the handler, or undefined when the name is unknown.
 */
export function handlerFor(name: string): Handler | undefined {
  return handlers[name]
}
