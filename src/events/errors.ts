/** An event the gateway can never handle: dead lettered, for inspection. */
export class RejectedEventError extends Error {
  override name = 'RejectedEventError'
}
