import { expect, test } from 'claude-code/testing'

const STATE = `---
milestone: v1.7
milestone_name: Demo milestone
status: executing
stopped_at: "44-02 waiting on review"
progress:
  total_plans: 21
  completed_plans: 14
  percent: 67
---

Phase: 44 (Beta)

### Pending Todos

- Rename the flag

### Blockers/Concerns

- **Migrations** not applied in staging
`
const ROADMAP = `- [x] **Phase 43: Alpha** - a
- [ ] **Phase 44: Beta** - b
- [ ] **Phase 45: Gamma** - c
`
const ROADMAP_DETAIL = `${ROADMAP}
### Phase 44: Beta
**Goal**: Beta ships behind a flag
**Success Criteria** (what must be TRUE):
  1. The flag defaults to off
  2. \`beta\` endpoint answers 200
**Plans:** 1/3 plans complete
- [x] 44-01-PLAN.md — Flag plumbing
- [ ] 44-02-PLAN.md — Endpoint

### Phase 45: Gamma
`
const PLAN = (wave: number) => `---\nwave: ${wave}\n---\n`
const FILES: Record<string, string> = {
  '/repo/.planning/STATE.md': STATE,
  '/repo/.planning/ROADMAP.md': ROADMAP,
  '/repo/.planning/phases/44-beta/44-01-PLAN.md': PLAN(1),
  '/repo/.planning/phases/44-beta/44-02-PLAN.md': PLAN(2),
  '/repo/.planning/phases/44-beta/44-03-PLAN.md': `${PLAN(2)}\n<objective>\nWire the dashboard\n</objective>\n`,
  '/repo/.planning/phases/44-beta/44-01-SUMMARY.md': '---\nplan: 01\n---\n\n# Summary\n\n## One-liner\n\nFlag added to config.\n',
}
const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
const LISTS: Record<string, ReturnType<typeof entry>[]> = {
  '/repo/.planning/phases': [entry('43-alpha', 'dir'), entry('44-beta', 'dir')],
  '/repo/.planning/phases/44-beta': ['44-01-PLAN.md', '44-01-SUMMARY.md', '44-02-PLAN.md', '44-03-PLAN.md'].map(n => entry(n, 'file')),
}

const PANE = {
  plugin: 'gsd-panel',
  component: 'Pane',
  requestId: 'gsd-panel',
  surface: 'terminal',
  props: { title: 'GSD', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function engine(on: any, files: Record<string, string>, cwd = '/repo') {
  const ran: string[] = []
  on('command.register', () => ({ value: { command: 'gsd-panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: cwd }))
  on('fs.exists', (_: unknown, e: any) => ({ value: e.path in files }))
  on('fs.read', (_: unknown, e: any) => (e.path in files ? { value: files[e.path] } : { error: 'ENOENT' }))
  on('fs.list', (_: unknown, e: any) => ({ value: LISTS[e.path] ?? [] }))
  on('tool.call', () => ({ result: {} }))
  on('command.run', (_: unknown, e: any) => {
    ran.push(`${e.command} ${e.args ?? ''}`.trim())
    return { text: '' }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_: unknown, e: any) => {
    ran.push(`toast ${e.text}`)
    return { value: undefined }
  })
  on('ui.focus', () => ({ value: { isFocused: true } }))
  on('ui.notify', (_: unknown, e: any) => {
    ran.push(`notify ${e.text}`)
    return { value: { isSent: true, channel: 'terminal' } }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '## main...origin/main [ahead 2]\n M a.ts\n?? b.ts\n', stderr: '' } }))
  on('prompt.submit', (_: unknown, e: any) => {
    ran.push(`submit ${e.text}`)
    return { text: e.text }
  })
  on('agent.spawn', () => ({ model: 'opus', agentId: 'a1' }))
  on('turn.complete', () => ({ text: '' }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('prompt.fill', () => ({ value: { isFilled: true } }))
  return ran
}

test('shows the open milestone and runs the next action', async ($, on) => {
  const ran = engine(on, FILES)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)

  expect((await ui.find({ type: 'Text', text: /Beta/ }))?.text).toContain('44')
  const next = await ui.find({ type: 'Button', key: 'next' })
  expect(next?.text).toContain('/gsd-execute-phase 44')
  await ui.press({ key: 'next' })
  await ui.press({ key: 'clear' })
  expect(ran).toEqual(['gsd-execute-phase 44', 'clear'])
  await ui.unmount()
})

test('shows nothing when the milestone is complete', async ($, on) => {
  engine(on, { ...FILES, '/repo/.planning/STATE.md': STATE.replace('executing', 'milestone_complete') })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Sem milestone aberta/ }))?.text).toBeTruthy()
  await ui.unmount()
})

const DIALOG = { ...PANE, requestId: 'gsd-phase' } as const

test('a phase opens a detail dialog whose actions run for that phase', async ($, on) => {
  const files = { ...FILES, '/repo/.planning/ROADMAP.md': ROADMAP_DETAIL }
  const ran = engine(on, files)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'phase-44' })

  const dialog = await $.ui.mount(DIALOG)
  expect((await dialog.find({ type: 'Text', text: /Beta ships behind a flag/ }))).toBeTruthy()
  expect((await dialog.find({ type: 'Text', text: /beta endpoint answers 200/ }))).toBeTruthy()
  expect((await dialog.find({ type: 'Text', text: /Flag added to config/ }))).toBeTruthy()
  expect((await dialog.find({ type: 'Text', text: /Wire the dashboard/ }))).toBeTruthy()
  await dialog.press({ key: 'gsd-plan-phase' })
  expect(ran).toEqual(['gsd-plan-phase 44'])
  await dialog.unmount()
  await pane.unmount()
})

test('shows git state, blockers and todos', async ($, on) => {
  engine(on, FILES)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /⎇ main/ }))?.text).toContain('2 alterações')
  expect((await ui.find({ type: 'Text', text: /Migrations not applied/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /1 todos pendentes/ }))).toBeTruthy()
  await ui.unmount()
})

test('a running executor shows live and a checkpoint raises the band', async ($, on) => {
  const files = {
    ...FILES,
    '/repo/.planning/phases/44-beta/44-02-PLAN.md':
      '---\nwave: 2\nautonomous: false\n---\n<task type="checkpoint:human-verify"><name>Check the flag in staging</name><how-to-verify>1. Open staging\n2. Toggle the flag</how-to-verify></task>\n',
  }
  const ran = engine(on, files)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'Execute plan 44-03', description: 'Execute 44-03', subagentType: 'gsd-executor' } as any)

  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Text', text: /44-03 executando/ }))).toBeTruthy()
  await pane.unmount()

  await $.turn.complete({ agentId: 'a1', reason: 'end_turn', answer: '' } as any)
  await $.turn.complete({ reason: 'end_turn', answer: '' } as any)

  const band = await $.ui.mount({ ...PANE, component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} } } as any)
  expect((await band.find({ type: 'Text', text: /Check the flag in staging/ }))).toBeTruthy()
  expect(ran.some(r => r.startsWith('notify 44-02'))).toBe(true)
  await band.press({ key: 'approve' })
  expect(ran).toContain('submit approved')
  await band.unmount()
})

test('writing a SUMMARY raises a toast', async ($, on) => {
  const ran = engine(on, FILES)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: '/repo/.planning/phases/44-beta/44-02-SUMMARY.md', content: '' } as any)
  expect(ran).toContain('toast ✓ 44-02 concluído')
})

test('a workspace lists its repos and switches between them', async ($, on) => {
  const ws: Record<string, string> = {
    '/ws/WORKSPACE.md': '',
    '/ws/api/.planning/STATE.md': STATE,
    '/ws/api/.planning/ROADMAP.md': ROADMAP,
    '/ws/web/.planning/STATE.md': STATE.replace('Demo milestone', 'Web milestone').replace('v1.7', 'v2.0'),
    '/ws/web/.planning/ROADMAP.md': ROADMAP,
  }
  LISTS['/ws'] = [entry('api', 'dir'), entry('web', 'dir'), entry('WORKSPACE.md', 'file')]
  engine(on, ws, '/ws/api')
  await $.session.start({ cwd: '/ws/api', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Demo milestone/ }))).toBeTruthy()
  await ui.press({ key: 'repo-web' })
  expect((await ui.find({ type: 'Text', text: /Web milestone/ }))).toBeTruthy()
  await ui.unmount()
})
