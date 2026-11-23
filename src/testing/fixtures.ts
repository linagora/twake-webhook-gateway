export const ACTOR = '6f1c1b5e-0000-4000-8000-000000000001'
export const ASSIGNEE = '6f1c1b5e-0000-4000-8000-000000000002'

// As Twake Tasks publishes it (docs/events.md of twake-tasks).
export const taskAssigned = {
  specversion: '1.0',
  id: '0192f0c2-7c1e-7000-8000-4b1f2a3c5d6e',
  source: 'twake://tasks',
  type: 'com.twake.tasks.task.assigned.v1',
  time: '2026-11-23T10:30:00Z',
  twakeorg: 'acme123',
  twakeactorid: ACTOR,
  twakeactor: 'alice@acme.example.com',
  twakecorrelationid: 'req-1',
  data: {
    object: {
      type: 'task',
      id: 'task-1',
      key: 'ACME-12',
      title: 'Secret plan',
      board: { id: 'board-1', name: 'Board' },
      container: { kind: 'project', id: 'project-1' }
    },
    assignee: { id: 'member-2' },
    recipients: [
      { uuid: ASSIGNEE, email: 'bob@acme.example.com', reason: 'assigned' }
    ]
  }
}
