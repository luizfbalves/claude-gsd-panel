# gsd-panel

A Claude Code mod that shows the open GSD milestone of the repo you are working in, in a pane beside the chat:

- milestone, status and progress, plus the repo's git branch, uncommitted changes and commits ahead/behind
- live execution: each running `gsd-executor` plan with its elapsed time and last tool, and a toast when a plan's SUMMARY is written
- blockers and pending todos from `STATE.md`
- in a GSD workspace (a folder with `WORKSPACE.md`), one button per repo to switch the pane between them
- the phases around the current one
- the current phase's waves (✓ done, ◆ current wave, ○ pending, "stops for you" on checkpoints)
- where work stopped (`stopped_at`)
- click a phase for a detail dialog: goal, success criteria, each plan with its objective and summary, the phase files, and buttons to discuss, plan, execute or verify that phase
- two buttons: `[1] /clear` and `[2] ▶ next action`, the GSD command recommended from `.planning/` (`/gsd-discuss-phase`, `/gsd-plan-phase`, `/gsd-execute-phase`, `/gsd-verify-work`, `/gsd-audit-milestone`, or `/gsd-next` when unclear)

When execution stops on a checkpoint plan (`autonomous: false`), a band above the prompt shows what to check, with buttons to approve, report a problem or open the plan, and a system notification is sent. The status line keeps `◆ v1.9 · F22 W2 · 64%` visible even with the pane closed.

It refreshes when a turn ends and whenever a tool writes under `.planning/`. The pane opens by itself when `.planning/STATE.md` has an open milestone, and stays closed otherwise. `/gsd-panel` toggles it.

## Install

At the prompt of a terminal session:

```
/plugin install gsd-panel --marketplace luizfbalves/claude-gsd-panel
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install gsd-panel --marketplace luizfbalves/claude-gsd-panel
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `luizfbalves/claude-gsd-panel`, then Add plugin.
