export type PlanMark = 'done' | 'active' | 'pending'
export type Plan = { id: string; mark: PlanMark; isCheckpoint: boolean }
export type Wave = { n: number; plans: Plan[] }
export type Phase = { n: string; name: string; isDone: boolean }
export type NextAction = { command: string; args: string }
export type Milestone = {
  version: string
  name: string
  status: string
  stoppedAt: string
  percent: number
  plansDone: number
  plansTotal: number
  phases: Phase[]
  current: { n: string; name: string; waves: Wave[] } | null
  next: NextAction
}

declare module 'claude-code' {
  interface PluginState {
    'gsd-panel': { milestone: Milestone | null; isDismissed: boolean }
  }
}
