/** Only trusted backend validation constructs user-facing failure messages. */
export class CommandFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CommandFailure";
  }
}
