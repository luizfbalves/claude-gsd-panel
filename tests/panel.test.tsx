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
`
const ROADMAP = `- [x] **Phase 43: Alpha** - a
- [ ] **Phase 44: Beta** - b
- [ ] **Phase 45: Gamma** - c
`
const PLAN = (wave: number) => `---\nwave: ${wave}\n---\n`
const FILES: Record<string, string> = {
  '/repo/.planning/STATE.md': STATE,
  '/repo/.planning/ROADMAP.md': ROADMAP,
  '/repo/.planning/phases/44-beta/44-01-PLAN.md': PLAN(1),
  '/repo/.planning/phases/44-beta/44-02-PLAN.md': PLAN(2),
  '/repo/.planning/phases/44-beta/44-03-PLAN.md': PLAN(2),
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

function engine(on: any, files: Record<string, string>) {
  const ran: string[] = []
  on('command.register', () => ({ value: { command: 'gsd-panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: any) => ({ value: e.path in files }))
  on('fs.read', (_: unknown, e: any) => (e.path in files ? { value: files[e.path] } : { error: 'ENOENT' }))
  on('fs.list', (_: unknown, e: any) => ({ value: LISTS[e.path] ?? [] }))
  on('command.run', (_: unknown, e: any) => {
    ran.push(`${e.command} ${e.args ?? ''}`.trim())
    return { text: '' }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
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
  expect((await ui.find({ type: 'Text', text: /No open GSD milestone/ }))?.text).toBeTruthy()
  await ui.unmount()
})
