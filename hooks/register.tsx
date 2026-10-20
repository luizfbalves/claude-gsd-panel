import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Milestone, NextAction, PlanMark } from '../types'
import { loadMilestone, loadPhaseDetail } from './gsd'

const PANE = 'gsd-panel'
const DIALOG = 'gsd-phase'
const milestone = atom({ plugin: 'gsd-panel', key: 'milestone' } as const, null)
const isDismissed = atom({ plugin: 'gsd-panel', key: 'isDismissed' } as const, false)
const detail = atom({ plugin: 'gsd-panel', key: 'detail' } as const, null)

const marks: Record<PlanMark, string> = { done: '✓', active: '◆', pending: '○' }
const markColor: Record<PlanMark, string> = { done: 'success', active: 'warning', pending: 'inactive' }

const PHASE_ACTIONS = [
  { command: 'gsd-discuss-phase', label: 'discutir', hotkey: 'd' },
  { command: 'gsd-plan-phase', label: 'planejar', hotkey: 'p' },
  { command: 'gsd-execute-phase', label: 'executar', hotkey: 'e' },
  { command: 'gsd-verify-work', label: 'verificar', hotkey: 'v' },
] as const

const PLANNING_PATH = /(^|\/)\.planning\//

function title(m: Milestone) {
  return `GSD · ${m.version}`
}

function commandLine(a: NextAction) {
  return `/${a.command}${a.args ? ` ${a.args}` : ''}`
}

async function openPhase($: EngineInterface, n: string) {
  const d = await loadPhaseDetail($, n).catch(() => null)
  if (d === null) return
  await update($, detail, () => d)
  await $.ui.open({ id: DIALOG, title: `Fase ${d.n} — ${d.name}`, focus: true, closeOnEscape: true, holdToasts: true, columns: 72 })
}

async function runFromDialog($: EngineInterface, a: NextAction) {
  await $.ui.close({ id: DIALOG })
  await $.command.run({ command: a.command, args: a.args })
}

// Reads .planning, stores the summary, and opens or closes the pane to match.
async function refresh($: EngineInterface) {
  const m = await loadMilestone($).catch(() => null)
  await update($, milestone, () => m)
  if (m === null) {
    await $.ui.close({ id: PANE })
  } else if (!(await read($, isDismissed))) {
    await $.ui.open({ id: PANE, title: title(m), columns: 44 })
  }
  const open = await read($, detail)
  if (open !== null) {
    const d = await loadPhaseDetail($, open.n).catch(() => null)
    await update($, detail, () => d)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gsd-panel', description: 'Toggle the GSD milestone pane' })
    const ran = await next(e)
    await refresh($)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) await refresh($)
    return ran
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const touched =
      ('file_path' in e && typeof e.file_path === 'string' && PLANNING_PATH.test(e.file_path)) ||
      (e.tool === 'Bash' && e.command.includes('.planning'))
    if (touched) await refresh($).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'gsd-panel' }, async $ => {
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) {
      await update($, isDismissed, () => true)
      await $.ui.close({ id: PANE })
      return { text: 'GSD pane closed.' }
    }
    await update($, isDismissed, () => false)
    await refresh($)
    return { text: (await read($, milestone)) ? 'GSD pane opened.' : 'No open GSD milestone in this repo.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, isDismissed, () => true).catch(() => undefined)
    if (e.id === DIALOG) await update($, detail, () => null).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await read($, milestone)
    if (m === null) return <Text dimColor>No open GSD milestone.</Text>

    const barWidth = Math.max(10, Math.min(30, e.props.bodyColumns - 6))
    const filled = Math.round((m.percent / 100) * barWidth)
    const cur = m.current
    const at = m.phases.findIndex(p => cur !== null && parseFloat(p.n) === parseFloat(cur.n))
    const shown = m.phases.slice(Math.max(0, at - 3), Math.max(0, at - 3) + 8)
    const nextLabel = `▶ ${commandLine(m.next)}`

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold wrap="truncate-end">{m.name || m.version}</Text>
            <Text color="warning"> {m.status}</Text>
          </Box>
          <Text>
            <Text color="success">{'█'.repeat(filled)}</Text>
            <Text color="inactive">{'░'.repeat(barWidth - filled)}</Text>
            <Text dimColor> {m.percent}%</Text>
          </Text>
          {m.plansTotal > 0 && <Text dimColor>{m.plansDone}/{m.plansTotal} plans</Text>}
        </Box>

        {shown.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>FASES</Text>
            {shown.map(p => {
              const isCurrent = cur !== null && parseFloat(p.n) === parseFloat(cur.n)
              const mark: PlanMark = p.isDone ? 'done' : isCurrent ? 'active' : 'pending'
              return (
                <Button key={`phase-${p.n}`} plain onPress={() => openPhase($, p.n)}>
                  <Text color={markColor[mark]}>{marks[mark]}</Text>
                  <Text bold={isCurrent} dimColor={mark === 'pending'}> {p.n} {p.name}</Text>
                </Button>
              )
            })}
          </Box>
        )}

        {cur !== null && cur.waves.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>FASE {cur.n} · WAVES</Text>
            {cur.waves.map(w => (
              <Text key={String(w.n)} wrap="truncate-end">
                {w.n}{'  '}
                {w.plans.map(p => (
                  <Text key={p.id}>
                    {p.id} <Text color={markColor[p.mark]}>{marks[p.mark]}</Text>{' '}
                  </Text>
                ))}
                {w.plans.some(p => p.isCheckpoint && p.mark !== 'done') && <Text color="warning">stops for you</Text>}
              </Text>
            ))}
          </Box>
        )}

        {m.stoppedAt !== '' && (
          <Box flexDirection="column">
            <Text dimColor>PAROU EM</Text>
            <Text dimColor wrap="wrap">{m.stoppedAt}</Text>
          </Box>
        )}

        <Box gap={1} flexWrap="wrap">
          <Button key="clear" hotkey="1" label="/clear" onPress={() => $.command.run({ command: 'clear' })} />
          <Button
            key="next"
            hotkey="2"
            variant="primary"
            label={nextLabel}
            onPress={() => $.command.run({ command: m.next.command, args: m.next.args })}
          />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: DIALOG }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const d = await read($, detail)
    if (d === null) return <Text dimColor>Carregando…</Text>

    return (
      <Box flexDirection="column" gap={1}>
        {d.goal !== '' && (
          <Box flexDirection="column">
            <Text dimColor>OBJETIVO</Text>
            <Text wrap="wrap">{d.goal}</Text>
          </Box>
        )}

        {d.criteria.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>CRITÉRIOS DE SUCESSO</Text>
            {d.criteria.map((c, i) => (
              <Text key={String(i)} wrap="wrap">
                {i + 1}. {c}
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column">
          <Text dimColor>PLANS</Text>
          {d.plans.length === 0 && <Text dimColor>Nenhum plan ainda.</Text>}
          {d.plans.map(p => (
            <Box key={p.id} flexDirection="column">
              <Text wrap="wrap">
                <Text color={markColor[p.mark]}>{marks[p.mark]}</Text> {p.id} <Text dimColor>W{p.wave}</Text> {p.objective}
              </Text>
              {p.summary !== '' && (
                <Text dimColor wrap="wrap">
                  {'   ↳ '}
                  {p.summary}
                </Text>
              )}
            </Box>
          ))}
        </Box>

        {d.docs.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>ARQUIVOS</Text>
            <Text wrap="wrap">{d.docs.join('  ')}</Text>
          </Box>
        )}

        <Box gap={1} flexWrap="wrap">
          {PHASE_ACTIONS.map(a => (
            <Button
              key={a.command}
              hotkey={a.hotkey}
              variant={a.command === d.next.command ? 'primary' : 'secondary'}
              label={a.label}
              onPress={() => runFromDialog($, { command: a.command, args: d.n })}
            />
          ))}
          <Button key="close" hotkey="q" role="dismiss" label="fechar" onPress={() => $.ui.close({ id: DIALOG })} />
        </Box>
      </Box>
    )
  })
}
