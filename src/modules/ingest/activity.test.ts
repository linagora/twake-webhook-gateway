import { describe, expect, it } from 'vitest'
import { taskAssigned } from '../../testing/fixtures.ts'
import { parseCloudEvent, type CloudEvent } from '../../events/envelope.ts'
import { RejectedEventError } from '../../events/errors.ts'
import { checkPublisher } from './activity.ts'

const event = (overrides: object = {}): CloudEvent => {
  const parsed = parseCloudEvent({ ...taskAssigned, ...overrides })
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.event
}

describe('checkPublisher', () => {
  const publishers = {
    tasks: { source: 'twake://tasks' },
    drive: { source: 'twake://drive' }
  }

  it("accepts an app's own event", () => {
    expect(checkPublisher(event(), publishers)).toBe('ok')
  })

  it('refuses an event with the source of another app', () => {
    expect(() =>
      checkPublisher(event({ source: 'twake://drive' }), publishers)
    ).toThrow(RejectedEventError)
  })

  it('ignores the events of an app it does not forward', () => {
    expect(
      checkPublisher(
        event({ type: 'com.twake.space.member.added.v1' }),
        publishers
      )
    ).toBe('unknown_app')
    expect(
      checkPublisher(event({ type: 'com.twake.constructor.x.v1' }), publishers)
    ).toBe('unknown_app')
  })
})
