import { DeadLetterError } from '@linagora/rabbitmq-client'
import { describe, expect, it } from 'vitest'
import { RejectedEventError } from '../events/errors.ts'
import { taskAssigned } from '../testing/fixtures.ts'
import { consumerStats, deliveryHandler, loggedIds } from './amqp.ts'

function recorder() {
  const lines: { level: string; object: object; message: string }[] = []
  return {
    lines,
    logger: {
      info: (object: object, message: string) =>
        lines.push({ level: 'info', object, message }),
      warn: (object: object, message: string) =>
        lines.push({ level: 'warn', object, message })
    }
  }
}

const properties = {
  exchange: 'activity',
  routingKey: taskAssigned.type,
  messageId: 'm1',
  headers: {}
} as unknown as Parameters<ReturnType<typeof deliveryHandler>>[1]

describe('loggedIds', () => {
  it('keeps the ids of an event, never its content or the people it lists', () => {
    expect(loggedIds(taskAssigned)).toEqual({
      source: 'twake://tasks',
      id: taskAssigned.id,
      twakeorg: 'acme123',
      twakeactorid: taskAssigned.twakeactorid
    })
    expect(JSON.stringify(loggedIds(taskAssigned))).not.toMatch(
      /alice@|bob@|Secret plan/
    )
    expect(loggedIds('not an object')).toEqual({})
  })
})

describe('deliveryHandler', () => {
  it('logs one line per event handled, with its outcome', async () => {
    const { lines, logger } = recorder()
    const handler = deliveryHandler(
      () => Promise.resolve('queued'),
      consumerStats(),
      logger
    )
    await handler(taskAssigned, properties)
    expect(lines).toEqual([
      {
        level: 'info',
        message: 'event handled',
        object: {
          exchange: 'activity',
          routingKey: taskAssigned.type,
          messageId: 'm1',
          source: 'twake://tasks',
          id: taskAssigned.id,
          twakeorg: 'acme123',
          twakeactorid: taskAssigned.twakeactorid,
          outcome: 'queued'
        }
      }
    ])
  })

  it('dead letters a rejected event, and logs why', async () => {
    const { lines, logger } = recorder()
    const handler = deliveryHandler(
      () => Promise.reject(new RejectedEventError('the source is wrong')),
      consumerStats(),
      logger
    )
    await expect(handler(taskAssigned, properties)).rejects.toBeInstanceOf(
      DeadLetterError
    )
    expect(lines).toMatchObject([
      {
        level: 'warn',
        object: { outcome: 'dead_lettered', reason: 'the source is wrong' }
      }
    ])
  })
})
