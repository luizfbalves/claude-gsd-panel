import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LiveRun, Milestone, NextAction, PlanMark } from '../types'
import { findRepos, loadCheckpoint, loadMilestone, loadPhaseDetail } from './gsd'

const PANE = 'gsd-panel'
const DIALOG = 'gsd-phase'
const milestone = atom({ plugin: 'gsd-panel', key: 'milestone' } as const, null)
const isDismissed = atom({ plugin: 'gsd-panel', key: 'isDismissed' } as const, false)
const detail = atom({ plugin: 'gsd-panel', key: 'detail' } as const, null)
const repos = atom({ plugin: 'gsd-panel', key: 'repos' } as const, [])
const selectedRoot = atom({ plugin: 'gsd-panel', key: 'selectedRoot' } as const, null)
const live = atom({ plugin: 'gsd-panel', key: 'live' } as const, [])
const now = atom({ plugin: 'gsd-panel', key: 'now' } as const, 0)
const checkpoint = atom({ plugin: 'gsd-panel', key: 'checkpoint' } as const, null)
const isExecuting = atom({ plugin: 'gsd-panel', key: 'isExecuting' } as const, false)

const marks: Record<PlanMark, string> = { done: '✓', active: '◆', pending: '○' }
const markColor: Record<PlanMark, string> = { done: 'success', active: 'warning', pending: 'inactive' }

const PHASE_ACTIONS = [
  { command: 'gsd-discuss-phase', label: 'discutir', hotkey: 'd' },
  { command: 'gsd-plan-phase', label: 'planejar', hotkey: 'p' },
  { command: 'gsd-execute-phase', label: 'executar', hotkey: 'e' },
  { command: 'gsd-verify-work', label: 'verificar', hotkey: 'v' },
] as const

const PLANNING_PATH = /(^|\/)\.planning\//
const SUMMARY_PATH = /(?:^|\/)([\d.]+)-(\d+)-SUMMARY\.md$/
const PLAN_REF = /\b(\d+(?:\.\d+)?)-(\d{2,})\b/

let ticker: { cancel: () => void } | null = null

function title(m: Milestone) {
  return `GSD · ${m.version}`
}

function clip(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

function commandLine(a: NextAction) {
  return `/${a.command}${a.args ? ` ${a.args}` : ''}`
}

function elapsed(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function statusLine(m: Milestone) {
  const cur = m.current
  const wave = cur?.waves.find(w => w.plans.some(p => p.mark !== 'done'))
  const where = cur ? ` · F${cur.n}${wave ? ` W${wave.n}` : ''}` : ''
  return `◆ ${m.version}${where} · ${m.percent}%`
}

async function openPhase($: EngineInterface, n: string) {
  const d = await loadPhaseDetail($, n, await read($, selectedRoot)).catch(() => null)
  if (d === null) return
  await update($, detail, () => d)
  await $.ui.open({ id: DIALOG, title: `Fase ${d.n}`, focus: true, closeOnEscape: true, holdToasts: true, columns: 72 })
  if (PHASE_ACTIONS.some(a => a.command === d.next.command)) {
    await $.ui.focus({ requestId: DIALOG, key: d.next.command }).catch(() => undefined)
  }
}

async function runFromDialog($: EngineInterface, a: NextAction) {
  await $.ui.close({ id: DIALOG })
  if (a.command === 'gsd-execute-phase') await update($, isExecuting, () => true)
  await $.command.run({ command: a.command, args: a.args })
}

async function tick($: EngineInterface) {
  const t = await $.clock.now()
  await update($, now, () => t)
}

async function setLive($: EngineInterface, fn: (runs: LiveRun[]) => LiveRun[]) {
  const runs = await update($, live, fn)
  if (runs.length > 0 && ticker === null) {
    ticker = $.clock.every(1000, () => void tick($))
  } else if (runs.length === 0 && ticker !== null) {
    ticker.cancel()
    ticker = null
  }
  return runs
}

// Raises the checkpoint band once the session is idle on a plan that waits for the person.
async function checkCheckpoint($: EngineInterface, m: Milestone | null, isIdle: boolean) {
  const waiting = await read($, checkpoint)
  const cur = m?.current ?? null
  const open = cur?.waves.find(w => w.plans.some(p => p.mark !== 'done'))
  const plan = open?.plans.find(p => p.isCheckpoint && p.mark !== 'done')

  if (m === null || cur === null || plan === undefined) {
    if (waiting !== null) await update($, checkpoint, () => null)
    return
  }
  if (waiting?.plan === plan.id && waiting.phase === cur.n) return
  const started = cur.waves.some(w => w.plans.some(p => p.mark === 'done'))
  if (!isIdle || !started || !(await read($, isExecuting)) || (await read($, live)).length > 0) return

  const cp = await loadCheckpoint($, m.root, cur.n, plan.id, await $.clock.now()).catch(() => null)
  await update($, checkpoint, () => cp)
  if (cp !== null) {
    void $.ui.notify(`${cp.phase}-${cp.plan} aguarda você: ${cp.title}`, { title: 'GSD checkpoint' }).catch(() => undefined)
  }
}

// Reads .planning, stores the summary, and opens or closes the pane to match.
async function refresh($: EngineInterface, isIdle = false) {
  const found = await findRepos($).catch(() => [])
  await update($, repos, () => found)
  let chosen = await read($, selectedRoot)
  if (chosen !== null && !found.some(r => r.root === chosen)) {
    chosen = null
    await update($, selectedRoot, () => null)
  }
  const m = await loadMilestone($, chosen).catch(() => null)
  await update($, milestone, () => m)
  $.ui.status(m === null ? undefined : statusLine(m))

  if (m === null && !found.some(r => r.isOpen)) {
    await $.ui.close({ id: PANE })
  } else if (!(await read($, isDismissed))) {
    await $.ui.open({ id: PANE, title: m ? title(m) : 'GSD', columns: 44 })
  }

  const shown = await read($, detail)
  if (shown !== null) {
    const d = await loadPhaseDetail($, shown.n, chosen).catch(() => null)
    await update($, detail, () => d)
  }
  await checkCheckpoint($, m, isIdle)
}

async function pickRepo($: EngineInterface, root: string) {
  await update($, selectedRoot, () => root)
  await update($, checkpoint, () => null)
  await refresh($)
}

async function answerCheckpoint($: EngineInterface, text: string, isSent: boolean) {
  await update($, checkpoint, () => null)
  if (isSent) await $.prompt.submit({ text })
  else await $.prompt.fill({ text, mode: 'replace' })
}

async function planDone($: EngineInterface, n: string, id: string) {
  const runs = await read($, live)
  const run = runs.find(r => r.plan === `${n}-${id}`)
  const took = run ? ` · ${elapsed((await $.clock.now()) - run.startedAt)}` : ''
  $.ui.toast(`✓ ${n}-${id} concluído${took}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gsd-panel', description: 'Toggle the GSD milestone pane' })
    const ran = await next(e)
    await refresh($)
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    const isExecute = e.command?.name === 'gsd-execute-phase' || e.text.trimStart().startsWith('/gsd-execute-phase')
    if (isExecute) await update($, isExecuting, () => true)
    if (e.origin === undefined || e.origin.kind !== 'plugin') await update($, checkpoint, () => null)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.agentId && /gsd-executor/.test(e.subagentType)) {
      const ref = PLAN_REF.exec(`${e.description} ${e.prompt}`)
      const run: LiveRun = {
        agentId: ran.agentId,
        plan: ref ? `${ref[1]}-${ref[2]}` : e.description,
        startedAt: await $.clock.now(),
        lastTool: '',
      }
      await update($, isExecuting, () => true)
      await tick($)
      await setLive($, runs => [...runs, run])
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      await refresh($, true)
    } else if ((await read($, live)).some(r => r.agentId === e.agentId)) {
      await setLive($, runs => runs.filter(r => r.agentId !== e.agentId))
      await refresh($)
    }
    return ran
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
    if (e.agentId !== undefined && (await read($, live)).some(r => r.agentId === e.agentId)) {
      const what = `${e.tool}${path ? ` ${path.replace(/^.*\//, '')}` : ''}`
      await setLive($, runs => runs.map(r => (r.agentId === e.agentId ? { ...r, lastTool: what } : r)))
    }
    const summary = SUMMARY_PATH.exec(path)
    if (summary?.[1] && summary[2] && e.tool === 'Write' && PLANNING_PATH.test(path)) {
      await planDone($, summary[1], summary[2])
    }
    const touched = PLANNING_PATH.test(path) || (e.tool === 'Bash' && e.command.includes('.planning'))
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const cp = await read($, checkpoint)
    if (e.props.hasSurvey || cp === null) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const ref = `${cp.phase}-${cp.plan}`
    const waited = elapsed((await $.clock.now()) - cp.since).replace(/\d+s$/, '') || '<1m'
    const isVerify = cp.kind === 'human-verify'

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
        <Box justifyContent="space-between">
          <Text>
            <Text color="warning" bold>
              ◆ Checkpoint · {ref}
            </Text>
            <Text dimColor> stops for you</Text>
          </Text>
          <Text dimColor>aguardando há {waited}</Text>
        </Box>
        <Text wrap="wrap">{cp.title}</Text>
        {cp.steps.map((step, i) => (
          <Text key={String(i)} dimColor wrap="wrap">
            {i + 1}. {step}
          </Text>
        ))}
        {cp.resume !== '' && !isVerify && (
          <Text dimColor wrap="wrap">
            ↳ {cp.resume}
          </Text>
        )}
        <Box gap={1} flexWrap="wrap">
          {isVerify ? (
            <Button key="approve" hotkey="1" variant="primary" label="Aprovado, continuar" onPress={() => answerCheckpoint($, 'approved', true)} />
          ) : (
            <Button key="approve" hotkey="1" variant="primary" label="Responder" onPress={() => answerCheckpoint($, `Checkpoint ${ref}: `, false)} />
          )}
          <Button key="issue" hotkey="2" label="Reportar problema" onPress={() => answerCheckpoint($, `Problema no checkpoint ${ref}: `, false)} />
          <Button key="plan" hotkey="3" label="Ver plan" onPress={() => openPhase($, cp.phase)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await read($, milestone)
    const all = await read($, repos)
    const width = Math.max(20, e.props.bodyColumns - 2)

    const switcher = all.length > 1 && (
      <Box flexDirection="column">
        <Text dimColor>Workspace</Text>
        <Box gap={1} flexWrap="wrap">
          {all.map(r => (
            <Button
              key={`repo-${r.name}`}
              variant={m?.root === r.root ? 'primary' : 'secondary'}
              label={`${r.name} ${r.isOpen ? '◆' : '—'}`}
              onPress={() => pickRepo($, r.root)}
            />
          ))}
        </Box>
      </Box>
    )

    if (m === null) {
      return (
        <Box flexDirection="column" paddingX={1} gap={1}>
          {switcher}
          <Text dimColor>Sem milestone aberta neste repo.</Text>
        </Box>
      )
    }

    const barWidth = Math.max(10, Math.min(30, width - 6))
    const filled = Math.round((m.percent / 100) * barWidth)
    const cur = m.current
    const isCurrent = (n: string) => cur !== null && parseFloat(n) === parseFloat(cur.n)
    const at = m.phases.findIndex(p => isCurrent(p.n))
    const shown = m.phases.slice(Math.max(0, at - 3), Math.max(0, at - 3) + 8)
    const phasesDone = m.phases.filter(p => p.isDone).length
    const runs = await read($, live)
    const t = await read($, now)
    const git = m.git

    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        {switcher}

        <Box flexDirection="column">
          <Text bold wrap="wrap">
            {m.name || m.version}
          </Text>
          <Text>
            <Text color="warning">● {m.status}</Text>
            <Text dimColor> · {m.version}</Text>
          </Text>
          {git !== null && (
            <Text dimColor wrap="truncate-end">
              ⎇ {git.branch}
              {git.changes > 0 && <Text color="warning"> · {git.changes} alterações</Text>}
              {git.ahead > 0 && ` · ↑${git.ahead}`}
              {git.behind > 0 && ` · ↓${git.behind}`}
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          <Text>
            <Text color="success">{'█'.repeat(filled)}</Text>
            <Text color="inactive">{'░'.repeat(barWidth - filled)}</Text>
            <Text bold> {m.percent}%</Text>
          </Text>
          <Text dimColor>
            {[m.plansTotal > 0 && `${m.plansDone}/${m.plansTotal} plans`, m.phases.length > 0 && `${phasesDone}/${m.phases.length} fases`]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </Box>

        {runs.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
            {runs.map(r => (
              <Box key={r.agentId} flexDirection="column">
                <Text>
                  <Text color="warning">◆</Text> {r.plan} executando · <Text bold>{elapsed(t - r.startedAt)}</Text>
                </Text>
                {r.lastTool !== '' && (
                  <Text dimColor wrap="truncate-end">
                    {r.lastTool}
                  </Text>
                )}
              </Box>
            ))}
          </Box>
        )}

        {shown.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Fases</Text>
            {shown.map(p => {
              const mark: PlanMark = p.isDone ? 'done' : isCurrent(p.n) ? 'active' : 'pending'
              const prefix = ` ${p.n}  `
              return (
                <Button key={`phase-${p.n}`} plain onPress={() => openPhase($, p.n)}>
                  <Text color={markColor[mark]}>{marks[mark]}</Text>
                  <Text bold={isCurrent(p.n)} dimColor={mark !== 'active'}>
                    {prefix}
                    {clip(p.name, width - prefix.length - 1)}
                  </Text>
                </Button>
              )
            })}
          </Box>
        )}

        {cur !== null && cur.waves.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Fase {cur.n} · waves</Text>
            {cur.waves.map(w => {
              const isWaveDone = w.plans.every(p => p.mark === 'done')
              return (
                <Text key={String(w.n)} wrap="truncate-end">
                  <Text dimColor>W{w.n}  </Text>
                  {isWaveDone ? (
                    <Text dimColor>
                      {w.plans.map(p => p.id).join(' ')} <Text color="success">✓</Text>
                    </Text>
                  ) : (
                    w.plans.map(p => (
                      <Text key={p.id}>
                        {p.id}
                        <Text color={markColor[p.mark]}>{marks[p.mark]}</Text>{' '}
                      </Text>
                    ))
                  )}
                  {!isWaveDone && w.plans.some(p => p.isCheckpoint && p.mark !== 'done') && (
                    <Text color="warning"> stops for you</Text>
                  )}
                </Text>
              )
            })}
          </Box>
        )}

        {(m.blockers.length > 0 || m.todos > 0) && (
          <Box flexDirection="column">
            <Text dimColor>Bloqueios</Text>
            {m.blockers.slice(0, 3).map((b, i) => (
              <Text key={String(i)} wrap="truncate-end">
                <Text color="warning">!</Text> {clip(b, width - 2)}
              </Text>
            ))}
            {m.blockers.length > 3 && <Text dimColor>+{m.blockers.length - 3} no STATE.md</Text>}
            {m.todos > 0 && (
              <Text>
                <Text color="warning">!</Text> {m.todos} todos pendentes
              </Text>
            )}
          </Box>
        )}

        {m.stoppedAt !== '' && (
          <Box flexDirection="column">
            <Text dimColor>Parou em</Text>
            <Text wrap="wrap">{m.stoppedAt}</Text>
          </Box>
        )}

        <Box flexDirection="column">
          <Button
            key="next"
            hotkey="2"
            variant="primary"
            label={`▶ ${commandLine(m.next)}`}
            onPress={async () => {
              if (m.next.command === 'gsd-execute-phase') await update($, isExecuting, () => true)
              await $.command.run({ command: m.next.command, args: m.next.args })
            }}
          />
          <Button key="clear" hotkey="1" label="/clear" onPress={() => $.command.run({ command: 'clear' })} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: DIALOG }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const d = await read($, detail)
    if (d === null) return <Text dimColor>Carregando…</Text>

    const recommended = PHASE_ACTIONS.find(a => a.command === d.next.command)

    return (
      <Box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
        <Box flexDirection="column">
          <Text bold>Fase {d.n}</Text>
          <Text bold color="claude" wrap="wrap">
            {d.name}
          </Text>
        </Box>

        {d.goal !== '' && <Text wrap="wrap">{d.goal}</Text>}

        {d.criteria.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Critérios de sucesso</Text>
            {d.criteria.map((c, i) => (
              <Text key={String(i)} wrap="wrap">
                {i + 1}. {c}
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column">
          <Text dimColor>Plans</Text>
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

        {d.docs.length > 0 && <Text dimColor wrap="wrap">{d.docs.join('  ')}</Text>}

        <Box justifyContent="flex-end" gap={2} flexWrap="wrap">
          {PHASE_ACTIONS.map(a => (
            <Button
              key={a.command}
              hotkey={a.hotkey}
              variant={a === recommended ? 'primary' : 'secondary'}
              label={a.label}
              onPress={() => runFromDialog($, { command: a.command, args: d.n })}
            />
          ))}
        </Box>

        <Box justifyContent="flex-end">
          <Text dimColor>
            <Text bold>tab</Text> próximo · {recommended && <Text><Text bold>enter</Text> {recommended.label} · </Text>}<Text bold>esc</Text> fechar
          </Text>
        </Box>
      </Box>
    )
  })
}
