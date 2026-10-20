import type { EngineInterface } from 'claude-code'

import type { Checkpoint, Git, Milestone, NextAction, Phase, PhaseDetail, Plan, PlanDetail, Repo, Wave } from '../types'

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

export async function findPlanning(api: EngineInterface) {
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

async function phaseDir(api: EngineInterface, root: string, n: string) {
  const dirs = await api.fs.list(`${root}/phases`).catch(() => [])
  return dirs.find(d => d.kind === 'dir' && sameNumber(/^([\d.]+)-/.exec(d.name)?.[1] ?? 'x', n))
}

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

const CLOSED = /\bcomplete\b|milestone_complete|shipped|archived/i

const base = (path: string) => path.replace(/\/+$/, '').replace(/^.*\//, '')
const parentOf = (path: string) => path.replace(/\/[^/]+\/?$/, '')

// Bullets under the first `###` heading matching `heading`, up to the next heading.
function bullets(text: string, heading: RegExp) {
  const lines = text.split('\n')
  const at = lines.findIndex(l => /^#{2,4}\s/.test(l) && heading.test(l))
  if (at < 0) return []
  const out: string[] = []
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,4}\s/.test(l)) break
    const item = /^\s*[-*]\s+(.+)$/.exec(l)?.[1]
    if (item) out.push(item.replace(/\*\*|`/g, '').trim())
  }
  return out.filter(b => !/^(none|nenhum)/i.test(b))
}

async function gitState(api: EngineInterface, dir: string): Promise<Git | null> {
  try {
    const r = await api.process.run(['git', 'status', '--porcelain=v1', '--branch'], { cwd: dir, timeoutMs: 3000 })
    if (r.exitCode !== 0) return null
    const [head = '', ...rest] = r.stdout.split('\n')
    return {
      branch: /^## (?:No commits yet on )?([^.\s]+)/.exec(head)?.[1] ?? '',
      changes: rest.filter(l => l.trim() !== '').length,
      ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0),
    }
  } catch {
    return null
  }
}

async function repoOf(api: EngineInterface, root: string): Promise<Repo> {
  const fm = frontmatter((await readOr(api, `${root}/STATE.md`)) ?? '')
  const status = fm.status ?? ''
  return {
    name: base(parentOf(root)),
    root,
    version: fm.milestone ?? '',
    status,
    isOpen: Boolean(fm.milestone) && !CLOSED.test(status),
  }
}


// A GSD workspace is a folder holding WORKSPACE.md; each child with .planning/STATE.md is one repo.
export async function findRepos(api: EngineInterface): Promise<Repo[]> {
  const near = await findPlanning(api)
  let dir = await api.session.cwd()
  for (let i = 0; i < 6 && dir; i++) {
    if (await api.fs.exists(`${dir}/WORKSPACE.md`)) {
      const roots = [`${dir}/.planning`]
      for (const d of await api.fs.list(dir).catch(() => [])) {
        if (d.kind === 'dir' && !d.name.startsWith('.')) roots.push(`${dir}/${d.name}/.planning`)
      }
      const found: string[] = []
      for (const r of roots) if (await api.fs.exists(`${r}/STATE.md`)) found.push(r)
      return Promise.all(found.map(r => repoOf(api, r)))
    }
    const up = parentOf(dir)
    if (up === dir) break
    dir = up
  }
  return near ? [await repoOf(api, near)] : []
}

export async function loadCheckpoint(api: EngineInterface, root: string, n: string, id: string, since: number): Promise<Checkpoint | null> {
  const dir = await phaseDir(api, root, n)
  if (!dir) return null
  const files = (await api.fs.list(`${root}/phases/${dir.name}`)).map(f => f.name)
  const file = files.find(f => new RegExp(`^[\\d.]+-${id}-PLAN\\.md$`).test(f))
  const plan = file ? ((await readOr(api, `${root}/phases/${dir.name}/${file}`)) ?? '') : ''
  const task = /<task[^>]*type="checkpoint:([\w-]+)"[^>]*>([\s\S]*?)<\/task>/.exec(plan)
  const body = task?.[2] ?? ''
  const tag = (name: string) => new RegExp(`<${name}>\\s*([\\s\\S]*?)<\\/${name}>`).exec(body)?.[1]?.trim() ?? ''
  const steps = (tag('how-to-verify') || tag('decision') || tag('action'))
    .split('\n')
    .map(l => l.replace(/^\s*(\d+\.|[-*])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 4)
  return {
    phase: n,
    plan: id,
    title: tag('name') || tag('what-built') || objective(plan) || `Plan ${n}-${id}`,
    kind: task?.[1] ?? 'human-verify',
    steps,
    resume: tag('resume-signal'),
    since,
  }
}

export async function loadMilestone(api: EngineInterface, chosen?: string | null): Promise<Milestone | null> {
  const root = chosen ?? (await findPlanning(api))
  if (!root) return null
  const state = (await readOr(api, `${root}/STATE.md`)) ?? ''
  const fm = frontmatter(state)
  const status = fm.status ?? ''
  if (!fm.milestone || CLOSED.test(status)) return null

  const phases = roadmapPhases((await readOr(api, `${root}/ROADMAP.md`)) ?? '')
  const fromBody = /^Phase:\s*([\d.]+)/m.exec(state)?.[1]
  const n = fromBody ?? phases.find(p => !p.isDone)?.n ?? null

  let current: Milestone['current'] = null
  let files: string[] = []
  if (n !== null) {
    const dir = await phaseDir(api, root, n)
    const name = phases.find(p => sameNumber(p.n, n))?.name ?? dir?.name.replace(/^[\d.]+-/, '').replace(/-/g, ' ') ?? ''
    let waves: Wave[] = []
    if (dir) ({ waves, files } = await phaseWaves(api, `${root}/phases/${dir.name}`))
    current = { n, name, waves }
  }

  return {
    root,
    repo: base(parentOf(root)),
    blockers: bullets(state, /Blockers/i),
    todos: bullets(state, /Pending Todos/i).length,
    git: await gitState(api, parentOf(root)),
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

// The `### Phase N: name` block of ROADMAP.md, up to the next heading of that level or above.
function roadmapSection(text: string, n: string) {
  const lines = text.split('\n')
  const start = lines.findIndex(l => sameNumber(/^###\s+Phase\s+([\d.]+):/.exec(l)?.[1] ?? 'x', n))
  if (start < 0) return []
  const end = lines.findIndex((l, i) => i > start && /^#{1,3}\s/.test(l))
  return lines.slice(start, end < 0 ? undefined : end)
}

function oneLiner(summary: string) {
  const body = summary.replace(/^---\n[\s\S]*?\n---\n/, '')
  const afterHeading = /^##\s*One[- ]liner\s*\n+(.+)$/im.exec(body)?.[1]
  const bold = /^\*\*(.+?)\*\*\s*$/m.exec(body)?.[1]
  return (afterHeading ?? bold ?? '').trim()
}

function objective(plan: string) {
  const text = /<objective>\s*([\s\S]*?)<\/objective>/.exec(plan)?.[1] ?? ''
  return text.split('\n').find(l => l.trim() !== '')?.trim() ?? ''
}

export async function loadPhaseDetail(api: EngineInterface, n: string, chosen?: string | null): Promise<PhaseDetail | null> {
  const root = chosen ?? (await findPlanning(api))
  if (!root) return null
  const roadmap = (await readOr(api, `${root}/ROADMAP.md`)) ?? ''
  const phases = roadmapPhases(roadmap)
  const section = roadmapSection(roadmap, n)
  const heading = /^###\s+Phase\s+[\d.]+:\s*(.+)$/.exec(section[0] ?? '')?.[1]
  const goal = section.map(l => /^\*\*Goal\*\*:?\s*(.+)$/.exec(l)?.[1]).find(Boolean) ?? ''
  const criteriaAt = section.findIndex(l => /Success Criteria/i.test(l))
  const criteria: string[] = []
  if (criteriaAt >= 0) {
    for (const l of section.slice(criteriaAt + 1)) {
      const item = /^\s*\d+\.\s+(.+)$/.exec(l)?.[1]
      if (item) criteria.push(item.replace(/`/g, ''))
      else if (criteria.length > 0 && l.trim() !== '') break
    }
  }
  const roadmapPlans = new Map(
    section.flatMap(l => {
      const m = /[\d.]+-(\d+)-PLAN\.md\s*[—–-]\s*(.+)$/.exec(l)
      return m?.[1] && m[2] ? [[m[1], m[2].trim()] as const] : []
    }),
  )

  const dir = await phaseDir(api, root, n)
  let plans: PlanDetail[] = []
  let docs: string[] = []
  let files: string[] = []
  let waves: Wave[] = []
  if (dir) {
    const path = `${root}/phases/${dir.name}`
    ;({ waves, files } = await phaseWaves(api, path))
    docs = files.filter(f => /-(CONTEXT|RESEARCH|UAT|VERIFICATION|VALIDATION)\.md$/.test(f))
    plans = await Promise.all(
      waves.flatMap(w =>
        w.plans.map(async p => {
          const planFile = files.find(f => new RegExp(`^[\\d.]+-${p.id}-PLAN\\.md$`).test(f))
          const summaryFile = files.find(f => new RegExp(`^[\\d.]+-${p.id}-SUMMARY\\.md$`).test(f))
          const fromRoadmap = roadmapPlans.get(p.id)
          return {
            id: p.id,
            wave: w.n,
            mark: p.mark,
            objective: fromRoadmap ?? (planFile ? objective((await readOr(api, `${path}/${planFile}`)) ?? '') : ''),
            summary: summaryFile ? oneLiner((await readOr(api, `${path}/${summaryFile}`)) ?? '') : '',
          }
        }),
      ),
    )
  }

  const phase = phases.find(p => sameNumber(p.n, n))
  const isDone = phase?.isDone ?? false
  return {
    n,
    name: heading?.replace(/[`*]/g, '').trim() ?? phase?.name ?? dir?.name.replace(/^[\d.]+-/, '') ?? '',
    goal,
    criteria,
    plans,
    docs,
    next: isDone ? { command: 'gsd-next', args: '' } : recommend([], n, files, waves),
  }
}
