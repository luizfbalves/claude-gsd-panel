import type { EngineInterface } from 'claude-code'

import type { Milestone, NextAction, Phase, Plan, Wave } from '../types'

type Front = Record<string, string>

// Flat YAML frontmatter; nested keys come out as `parent.child`.
function frontmatter(text: string): Front {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  const out: Front = {}
  if (!m?.[1]) return out
  let parent = ''
  for (const line of m[1].split('\n')) {
    const kv = /^(\s*)([\w-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, indent = '', key = '', raw = ''] = kv
    const value = raw.replace(/^["']|["']$/g, '').trim()
    if (indent.length === 0) {
      parent = value === '' ? key : ''
      out[key] = value
    } else if (parent) {
      out[`${parent}.${key}`] = value
    }
  }
  return out
}

async function readOr(api: EngineInterface, path: string) {
  try {
    return await api.fs.read(path)
  } catch {
    return null
  }
}

async function findPlanning(api: EngineInterface) {
  let dir = await api.session.cwd()
  for (let i = 0; i < 6 && dir; i++) {
    if (await api.fs.exists(`${dir}/.planning/STATE.md`)) return `${dir}/.planning`
    const up = dir.replace(/\/[^/]+\/?$/, '')
    if (up === dir) break
    dir = up
  }
  return null
}

function roadmapPhases(text: string): Phase[] {
  const visible = text.replace(/<details>[\s\S]*?<\/details>/g, '')
  const phases: Phase[] = []
  for (const m of visible.matchAll(/^\s*-\s*\[( |x|X)\]\s*\*\*Phase\s+([\d.]+):?\s*([^*]+?)\*\*/gm)) {
    phases.push({ n: m[2] ?? '', name: (m[3] ?? '').trim(), isDone: m[1] !== ' ' })
  }
  if (phases.length > 0) return phases
  for (const m of visible.matchAll(/^###\s+Phase\s+([\d.]+):\s*(.+)$/gm)) {
    phases.push({ n: m[1] ?? '', name: (m[2] ?? '').replace(/[`*]/g, '').trim(), isDone: false })
  }
  return phases
}

const sameNumber = (a: string, b: string) => parseFloat(a) === parseFloat(b)

async function phaseWaves(api: EngineInterface, dir: string) {
  const files = (await api.fs.list(dir)).map(f => f.name)
  const done = new Set(files.map(f => /^[\d.]+-(\d+)-SUMMARY\.md$/.exec(f)?.[1]).filter(Boolean))
  const plans: (Plan & { wave: number })[] = []
  for (const f of files) {
    const id = /^[\d.]+-(\d+)-PLAN\.md$/.exec(f)?.[1]
    if (!id) continue
    const fm = frontmatter((await readOr(api, `${dir}/${f}`)) ?? '')
    plans.push({
      id,
      wave: Number(fm.wave ?? 1) || 1,
      mark: done.has(id) ? 'done' : 'pending',
      isCheckpoint: fm.autonomous === 'false',
    })
  }
  const firstOpen = Math.min(...plans.filter(p => p.mark !== 'done').map(p => p.wave))
  const waves: Wave[] = []
  for (const p of plans.sort((a, b) => a.wave - b.wave || a.id.localeCompare(b.id))) {
    const mark = p.mark === 'pending' && p.wave === firstOpen ? 'active' : p.mark
    const wave = waves.find(w => w.n === p.wave) ?? waves[waves.push({ n: p.wave, plans: [] }) - 1]
    wave?.plans.push({ id: p.id, mark, isCheckpoint: p.isCheckpoint })
  }
  return { waves, files }
}

function recommend(phases: Phase[], n: string | null, files: string[], waves: Wave[]): NextAction {
  if (phases.length > 0 && phases.every(p => p.isDone)) return { command: 'gsd-audit-milestone', args: '' }
  if (n === null) return { command: 'gsd-next', args: '' }
  const plans = waves.flatMap(w => w.plans)
  if (plans.length === 0) {
    const hasContext = files.some(f => f.endsWith('-CONTEXT.md'))
    return { command: hasContext ? 'gsd-plan-phase' : 'gsd-discuss-phase', args: n }
  }
  if (plans.some(p => p.mark !== 'done')) return { command: 'gsd-execute-phase', args: n }
  if (!files.some(f => /-(UAT|VERIFICATION)\.md$/.test(f))) return { command: 'gsd-verify-work', args: n }
  return { command: 'gsd-next', args: '' }
}

export async function loadMilestone(api: EngineInterface): Promise<Milestone | null> {
  const root = await findPlanning(api)
  if (!root) return null
  const state = (await readOr(api, `${root}/STATE.md`)) ?? ''
  const fm = frontmatter(state)
  const status = fm.status ?? ''
  if (!fm.milestone || /\bcomplete\b|milestone_complete|shipped|archived/i.test(status)) return null

  const phases = roadmapPhases((await readOr(api, `${root}/ROADMAP.md`)) ?? '')
  const fromBody = /^Phase:\s*([\d.]+)/m.exec(state)?.[1]
  const n = fromBody ?? phases.find(p => !p.isDone)?.n ?? null

  let current: Milestone['current'] = null
  let files: string[] = []
  if (n !== null) {
    const dirs = await api.fs.list(`${root}/phases`).catch(() => [])
    const dir = dirs.find(d => d.kind === 'dir' && sameNumber(/^([\d.]+)-/.exec(d.name)?.[1] ?? 'x', n))
    const name = phases.find(p => sameNumber(p.n, n))?.name ?? dir?.name.replace(/^[\d.]+-/, '').replace(/-/g, ' ') ?? ''
    let waves: Wave[] = []
    if (dir) ({ waves, files } = await phaseWaves(api, `${root}/phases/${dir.name}`))
    current = { n, name, waves }
  }

  return {
    version: fm.milestone,
    name: fm.milestone_name ?? '',
    status,
    stoppedAt: fm.stopped_at && fm.stopped_at !== 'null' ? fm.stopped_at : '',
    percent: Number(fm['progress.percent'] ?? 0) || 0,
    plansDone: Number(fm['progress.completed_plans'] ?? 0) || 0,
    plansTotal: Number(fm['progress.total_plans'] ?? 0) || 0,
    phases,
    current,
    next: recommend(phases, n, files, current?.waves ?? []),
  }
}
