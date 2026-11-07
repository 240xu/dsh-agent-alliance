# D2 — Official-behavior audit: `dsh-subagent-claude-code`

**Plugin under audit:** `dsh-agent-alliance` 0.2.0 at `1054bcb`
**Official authority:** `/home/ova/dsh/packages/subagent/subagent-claude-code/`
(package version **`0.2.1-alpha.2`**), plus the seam
`/home/ova/dsh/packages/subagent/subagent/src/types.ts`.

**The bundle is NOT installed** on this host. Everything below is read from the
source checkout, which is the only available authority; I mark any claim that
would need a live run as such rather than implying I executed it.

**Baseline note.** The tree moved eight commits since my A2 review. Every
plugin citation below was re-read at `1054bcb`.

---

## Q1 — `subagentProvider: 'claude-code'` and the duplicate tool

*(pending)*

## Q2 — Does the bundle accept our `startActivation` request shape?

*(pending)*

## Q3 — `permissionMode: 'dontAsk'` and file-editing delegations

*(pending)*

## Q4 — The credential-scrubbing claim

*(pending)*

## Q5 — "Never falls back to the host claude executable"

*(pending)*

## Q6 — `maxConcurrent` vs `maxActiveSubagents`

*(pending)*

## Q7 — Every contradicted doc claim and misleading error

*(pending)*

## Q8 — `never` vs `dontAsk` risk comparison

*(pending)*

---

## Verdict summary

*(filled at the end)*
