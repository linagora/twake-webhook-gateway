import { z } from 'zod'

const key = z.string().min(1).max(255)

// A CloudEvent of the `activity` exchange (ADR 067). Only the fields the
// gateway reads are checked; the others are ignored.
const cloudEvent = z.looseObject({
  specversion: z.literal('1.0'),
  id: key,
  source: key,
  type: key,
  time: z.iso.datetime({ offset: true }).optional(),
  // A B2C user has no organization.
  twakeorg: key.optional(),
  twakeactorid: key.optional(),
  data: z
    .looseObject({
      object: z
        .looseObject({
          type: key.optional(),
          id: key.optional(),
          container: z.unknown().optional()
        })
        .optional(),
      container: z.unknown().optional(),
      // A recipient without a valid uuid is skipped, not refused.
      recipients: z.array(z.unknown()).max(10_000).optional()
    })
    .optional()
})

export type CloudEvent = z.infer<typeof cloudEvent>

export function parseCloudEvent(
  body: unknown
): { ok: true; event: CloudEvent } | { ok: false; error: string } {
  const result = cloudEvent.safeParse(body)
  return result.success
    ? { ok: true, event: result.data }
    : { ok: false, error: z.prettifyError(result.error) }
}

const recipient = z.looseObject({ uuid: z.uuid() })

/** The people an event is about: its actor, then its listed recipients. */
export function audienceOf(event: CloudEvent): string[] {
  const people = new Set<string>()
  if (event.twakeactorid !== undefined) {
    const actor = z.uuid().safeParse(event.twakeactorid)
    if (actor.success) people.add(actor.data.toLowerCase())
  }
  for (const candidate of event.data?.recipients ?? []) {
    const parsed = recipient.safeParse(candidate)
    if (parsed.success) people.add(parsed.data.uuid.toLowerCase())
  }
  return [...people]
}

const reference = z.looseObject({
  id: key,
  kind: key.optional(),
  type: key.optional()
})

const REFERENCE_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const MAX_REFERENCES = 10

// Only the id, kind and type of something an event points to, never its name.
function idsOf(value: unknown) {
  const parsed = reference.safeParse(value)
  if (!parsed.success) return undefined
  const { id, kind, type } = parsed.data
  return {
    id,
    ...(kind !== undefined && { kind }),
    ...(type !== undefined && { type })
  }
}

// The ids of what a record points to, such as a task's board, under keys a
// subscriber can read as JSON fields.
function referencesIn(record: Record<string, unknown>, skipped: Set<string>) {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([name]) => !skipped.has(name) && REFERENCE_KEY.test(name))
      .flatMap(([name, value]) => {
        const ids = idsOf(value)
        return ids === undefined ? [] : [[name, ids] as const]
      })
      .slice(0, MAX_REFERENCES)
  )
}

const OBJECT_SKIPPED = new Set(['type', 'id', 'container'])
// The recipients are matched against subscriptions, never forwarded.
const DATA_SKIPPED = new Set(['object', 'container', 'recipients'])

// The basics only: the subscriber fetches the object with its own token, so
// the app's permissions decide what it reads. No title, name or email. The
// object keeps the ids of what it sits in, such as a task's board, which the
// subscriber may need to read it, and the data the ids of the other things the
// event is about, such as the person a task is assigned to.
export function deliveryBody(event: CloudEvent): string {
  const object = event.data?.object
  const container = event.data?.container ?? object?.container
  const containerIds = idsOf(container)
  const data = {
    ...(object !== undefined && {
      object: {
        ...(object.type !== undefined && { type: object.type }),
        ...(object.id !== undefined && { id: object.id }),
        ...referencesIn(object, OBJECT_SKIPPED)
      }
    }),
    ...(containerIds !== undefined && { container: containerIds }),
    ...(event.data !== undefined && referencesIn(event.data, DATA_SKIPPED))
  }
  return JSON.stringify({
    specversion: '1.0',
    id: event.id,
    type: event.type,
    source: event.source,
    ...(event.time !== undefined && { time: event.time }),
    ...(event.twakeorg !== undefined && { twakeorg: event.twakeorg }),
    ...(event.twakeactorid !== undefined && {
      twakeactorid: event.twakeactorid
    }),
    data
  })
}
