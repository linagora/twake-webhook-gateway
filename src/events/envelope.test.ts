import { describe, expect, it } from 'vitest'
import { ACTOR, ASSIGNEE, taskAssigned } from '../testing/fixtures.ts'
import { audienceOf, deliveryBody, parseCloudEvent } from './envelope.ts'

const parsed = (body: unknown) => {
  const result = parseCloudEvent(body)
  if (!result.ok) throw new Error(result.error)
  return result.event
}

describe('parseCloudEvent', () => {
  it('refuses what is not a CloudEvent', () => {
    expect(parseCloudEvent({ id: '1' }).ok).toBe(false)
    expect(parseCloudEvent({ ...taskAssigned, specversion: '0.3' }).ok).toBe(
      false
    )
  })
})

describe('audienceOf', () => {
  it('is the actor and the recipients, by uuid', () => {
    expect(audienceOf(parsed(taskAssigned))).toEqual([ACTOR, ASSIGNEE])
  })

  it('skips a recipient without a uuid, and an actor that is not one', () => {
    const event = parsed({
      ...taskAssigned,
      twakeactorid: 'alice',
      data: {
        ...taskAssigned.data,
        recipients: [{ email: 'bob@acme.example.com' }, { uuid: 'bob' }]
      }
    })
    expect(audienceOf(event)).toEqual([])
  })
})

describe('deliveryBody', () => {
  it('carries the ids only', () => {
    expect(JSON.parse(deliveryBody(parsed(taskAssigned)))).toEqual({
      specversion: '1.0',
      id: taskAssigned.id,
      type: 'com.twake.tasks.task.assigned.v1',
      source: 'twake://tasks',
      time: '2026-11-23T10:30:00Z',
      twakeorg: 'acme123',
      twakeactorid: ACTOR,
      data: {
        object: { type: 'task', id: 'task-1', board: { id: 'board-1' } },
        container: { kind: 'project', id: 'project-1' },
        assignee: { id: 'member-2' }
      }
    })
  })

  it('keeps no name of what the object points to', () => {
    const body = deliveryBody(
      parsed({
        ...taskAssigned,
        data: {
          object: {
            type: 'task',
            id: 'task-1',
            board: { id: 'board-1', name: 'Secret board' },
            owner: { email: 'bob@acme.example.com' },
            'bad key': { id: 'x' }
          },
          container: { kind: 'project', id: 'project-1', name: 'Secret' },
          assignee: { id: 'member-2', name: 'Secret person' },
          changes: { title: { from: 'Secret', to: 'Secret plan' } },
          recipients: [{ uuid: ASSIGNEE, email: 'bob@acme.example.com' }]
        }
      })
    )
    expect(body).not.toMatch(/Secret|bob@|bad key|recipients/)
    expect(JSON.parse(body)).toMatchObject({
      data: { assignee: { id: 'member-2' } }
    })
  })

  it('leaves out the organization of a B2C event', () => {
    const { twakeorg: _, ...b2c } = taskAssigned
    expect(JSON.parse(deliveryBody(parsed(b2c)))).not.toHaveProperty('twakeorg')
  })
})
