# O1 — Official-behavior alignment: our external-agent extension vs the real `ctx.subagents` seam

Scope: line-by-line comparison of `dsh-agent-alliance` @ `519be02` against the official DSH subagent
implementation. Not a documentation review — every claim is quoted from both sides.

**Status: in progress** — sections appended as each is verified.

## Authorities

| Role | Path |
|---|---|
| Service Definition | `packages/subagent/subagent/src/{index,types,manager,out-of-process,child-agent,depth,error}.ts` |
| Consumer / tool | `packages/subagent/tool-subagent/src/index.ts` |
| Providers | `packages/subagent/subagent-spawn-in-process/src/index.ts`, `subagent-fork-in-process/src/index.ts` |
| Composition | `packages/bundle/base/cordis.patch.yml` |
| Ours | `src/backend.js`, `src/tools.js`, `src/config.js`, `src/roundtable.js`, `index.js` |

## Sections

1. Capability seam — what we lose by not being a `SubagentProvider`
2. Tool shape — model-visible differences
3. Positioning decision — become a real provider?
4. Lifecycle / HMR
5. Config catalog
6. Alignment backlog

_(filled below)_
