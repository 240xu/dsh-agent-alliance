# Audit 04 — Orchestration economics and debate semantics

Domain review of `dsh-agent-alliance` 0.2.0 (commit `e15fcf8`) as a multi-agent
orchestration system: delegation economics, prompt-cache mechanics, and
debate / N-version sampling semantics.

**Scope.** Read-only audit. No source changes, no commit. Every claim about
behaviour cites `file:line`. Cost figures are a model with stated assumptions,
not meters — the plugin reports no usage at all, so no meter is possible
(section 1.1).

**Verdict up front.** Roundtable is worth keeping as a *role-specialised fan-out
primitive* and not worth keeping as a *debate engine*. Its cost problem is not
the prompt text; it is that one tool call multiplies spend by `N × R` with no
effective concurrency gate, no usage reporting, no participant integrity, and no
aggregation rule — while three separate bugs guarantee that a meaningful share of
that spend is either wasted outright or thrown away before the caller sees it.

---

## Contents

1. Cache and cost economics (worked model)
2. Debate and N-version semantics
3. Failure isolation, participant sets, truncation
4. Delegation quality and the two-layer backend fallback
5. What a senior engineer changes first
6. Verification log

---

## 1. Cache and cost economics

### 1.1 What the code actually does

Three facts determine everything in this section.

**Every dispatch is a cold, one-shot process or activation.** `runRoundtable`
never passes a session id: its `provider.dispatch` call passes only
`{ prompt, cwd, model, timeoutMs, signal }` (`src/roundtable.js:33-35`). The
`resumeSessionId` argument that would reuse a prior thread exists only on the
`agent_dispatch` path (`src/tools.js:236`, `src/tools.js:264`). Every member
returns an `externalSessionId` (`src/roundtable.js:38`) and it is **discarded** —
never fed into the next round, never surfaced in the formatted text as something
to continue. So member *i*'s round 2 runs in a genuinely unrelated process from
its round 1.

**Round 1 and round 2 share no prefix at all.** `buildDebatePrompt`
(`src/roundtable.js:5-20`) returns `String(basePrompt)` verbatim for round 1
(`:6`), and for round ≥ 2 returns an array joined with newlines whose **first
element is the header** `'【第' + round + '轮辩论】'` (`:11`). Verified by
executing the function: with an 800-character base prompt, round 1 begins
`"PPPP…"` and round 2 begins `"【第2轮辩论】\n原始问题：\nPPPP…"`; the **common
prefix length is 0**, while round 2 *does* contain round 1 as a substring. So
~99% of the round-2 prompt is text the provider has already been paid to process
once, and none of it is positioned where a cache can match it.

**Nothing measures spend.** `grep -rn "usage\|cacheReadTokens\|cacheWriteTokens"`
across `src/` returns no hit. Normalised results carry `text`, `stopReason`,
`externalSessionId`, `durationMs`, `backend` (`src/backend.js:195-201`,
`:253-259`) — no usage. The DSH `TokenUsage` interface does carry `inputTokens`,
`outputTokens`, `cacheReadTokens`, `cacheWriteTokens`
(`@deepseek-ai/dsh-llm`, `lib/types/types.d.ts:160-174`), but that vocabulary
stops at the CLI/activation boundary and this plugin discards whatever the child
produced. The roundtable value is `{ prompt, debate, rounds }`
(`src/roundtable.js:55`) with per-entry `ok, text, externalSessionId, durationMs`
(`:36-42`) — again nothing billable. Cost is not merely unreported; it is
unobservable from inside the plugin, so neither the model nor the user can
attribute spend to a member or learn which configuration is expensive.

### 1.2 Worked cost model

Units are input-token-equivalents: one input token = `1.0`; a cache **write** =
`1.25`; a cache **read** = `0.1`; an **output** token = `5.0`. These are the
ratios the brief specifies and they match published cache pricing structure (e.g.
Claude: 5-minute cache writes at 1.25× base input, cache hits at 0.1× —
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)).

Assumptions, all deliberately **conservative** (they favour the current design):

| Symbol | Meaning | Value | Rationale |
|---|---|---|---|
| `S` | System prompt + tool schema + harness instructions, per dispatch | 12,000 tok | A CLI coding agent ships a large tool schema before the task; this dominates the fixed per-dispatch cost |
| `P` | Base question | 800 tok | |
| `A` | Answer text per member per round | 1,200 tok (~4,800 chars) | Ordinary prose answer, comfortably under the 4,000-char display cap |
| `PEER` | Round-2+ peer block | 2,050 tok | 4 entries × 500 tok + ~50 tok header/instruction — 4, not 3, because the block currently includes the member's own answer (section 3.4) |
| `N` | Members | 4 | `defaultConfig()` enables claude, codex, opencode (`src/config.js:18-21`), and roundtable defaults to *every* resolved backend (`src/roundtable.js:24`) |
| `R` | Rounds | 2 | The smallest setting where debate does anything |
| Price | `$/input token` | `3e-6` | Sonnet-tier input price, used only to convert units to dollars |

**Current design** = each dispatch pays the full `S + P` again, plus `PEER` from
round 2 on, with no cache reads at any point.

### 1.3 The table

`N = 4`, `R = 2`, `A = 1,200`, `S = 12,000`, `P = 800`, `PEER = 2,050`.

| Scenario | Total (tok-eq) | USD | vs current | Output share |
|---|---|---|---|---|
| **Current design** | 158,600 | $0.4758 | — | 30.3% |
| **Fix A** — round 2 keeps `basePrompt` as a strict prefix; round 1 pays the 1.25× write | 125,320 | $0.3760 | **−21.0%** | 38.3% |
| **Fix A**, if the `S+P` prefix was already warm before round 1 | 112,520 | $0.3376 | **−29.1%** | 42.7% |
| **Fix A + exclude own answer from peer block** (section 3.4) | 123,320 | $0.3700 | **−22.2%** | 38.9% |
| **Fix B** — each member resumes its own session; round 1 pays the write | 125,800 | $0.3774 | **−20.7%** | 38.2% |
| **Fix C1** — serialize the fan-out, 4 distinct providers | 158,600 | $0.4758 | **0.0%** | 30.3% |
| **Fix C2** — serialize, all members on one shared provider | 142,090 | $0.4263 | **−10.4%** | 33.8% |
| **Fix C2 + Fix A** — shared provider *and* prefix-preserving prompt | 81,160 | $0.2435 | **−48.8%** | 59.1% |
| *Trap:* annotate cache but keep the bad prefix | 186,250 | $0.5587 | **+17.4%** | 25.8% |

Four conclusions, in order of importance.

**(a) Fix A is the right fix, not Fix B.** Fix A saves **21.0%** realistically
(**29.1%** at ceiling) by making the already-paid `S + P` a strict prefix of the
round-2 prompt. Fix B saves **20.7%** — essentially the same — while requiring
per-provider resume plumbing (`--resume` / `resume` subcommand / `-s`: three
different argv dialects at `src/provider/claude.js:43`,
`src/provider/codex.js:46-47`, `src/provider/opencode.js:47`), cross-process
session-id bookkeeping, and a hard incompatibility with the official subagent
path, which **rejects** resume outright (`src/backend.js:152-157`, verified).
Fix A is a one-line array reorder and works on both backend paths. **Fix A
strictly dominates Fix B: slightly more saving, an order of magnitude less
effort.**

**(b) Fix C is conditional, and on the default configuration it is worth
nothing.** Serialising the fan-out buys **0.0%** when the four members are
claude/codex/opencode/zcode, because four vendors have four independent caches
and no read can ever follow another member's write. Authoritative source: the
official packages state the child's cache is "independent of the parent request
cache" and reuse "depends only on Codex's own provider, model, instructions,
tools" (`packages/subagent/subagent-codex/README.md:142-144`); same for Claude
Code (`packages/subagent/subagent-claude-code/README.md:144-146`). Fix C becomes
meaningful only when several members share one provider and model — where a
serialised round 1 turns `4` racing cache writes into `1` write + `3` reads,
worth **−10.4%** alone and **−48.8%** combined with Fix A. Its real justification
on the default config is therefore not cost but **latency and rate-limit
control** (section 1.6), plus a large win for users who fan out to one provider
at several temperatures or models.

**(c) The naive fix is actively harmful.** Adding cache annotations while leaving
the header-first prompt shape unchanged makes round 2 pay **1.25× on the whole
`S + P + PEER` block** for a cache write that will never be read: **+17.4%**
worse than today. This is the most likely regression a follow-up patch
introduces, and it deserves an explicit test.

**(d) The prize is bounded and it is not in the question text.** In a round-2
dispatch the system prompt is **80.8%** of input, the question 5.4%, and the new
peer information only 13.8%. Gross duplicated `S + P` across rounds is 51,200
units = **32.3% of today's spend**; recovered at 0.1× that is 46,080 units =
**29.1% of spend** — the hard ceiling for prefix-caching work, before the write
premium. Any change that rationalises only the question and leaves the tool
schema cold per dispatch has fixed nothing that matters.

### 1.4 The structural floor: output is 30.3% and cannot be cached

Output tokens are never cached by any provider. At the baseline they are **30.3%
of total roundtable cost**, so **69.7% is the absolute maximum any caching work
could ever save** — and the realistic achievable figure is 21–29%.

The floor moves *against* you as answers lengthen, because output is priced at 5×:

| Answer length `A` | Output share of cost | Fix A realistic saving |
|---|---|---|
| 600 tok | 17.8% | −24.7% |
| **1,200 tok** | **30.3%** | **−21.0%** |
| 2,000 tok | 42.0% | −17.5% |
| 3,000 tok | 52.0% | −14.4% |
| 4,000 tok | 59.1% | −12.3% |

For a *coding* agent — the stated use case, per `package.json`'s own description —
answers are routinely 3–6k tokens, so the realistic output share is **above 50%**
and the cache ceiling collapses to low double digits. **Debate is intrinsically
an output-heavy operation: its cost is dominated by generation, not by context.**
That is exactly why caching cannot rescue a badly shaped debate loop, and why the
highest-leverage cost control is reducing `N·R` and capping answer length per
member — not the cache fix. The cache fix is still worth doing because it is one
line, but it is not the answer to "roundtable is expensive".

### 1.5 Cache writes pay back only if a later dispatch reads

A cold-cache write costs 1.25×, so a single-shot dispatch is *more* expensive
with caching than without:

| Rounds | With write premium | No cache | Delta |
|---|---|---|---|
| 1 | 64,000 | 51,200 | **+25.0%** (worse) |
| 2 | 69,120 | 102,400 | −32.5% |
| 3 | 74,240 | 153,600 | −51.7% |

So cache work must be **gated on `R ≥ 2`**. Applying "always cache-annotate" to
the default `rounds: 1` (`src/tools.js:353`) would raise the price of the single
most common call by **17.0%** end to end (measured, not just on the prefix block).

The same arithmetic explains the concurrent fan-out problem. Within one round the
`N` members issue *different* prompts to *different* providers, so there is
nothing to read. Even when all members hit *one* provider, `Promise.all`
(`src/roundtable.js:45`) launches them simultaneously: every request misses and
every request pays a write. Four racing requests sharing a 12,800-token prefix pay
`4 × 12,800 × 1.25 = 64,000` units; serialised they pay
`12,800 × 1.25 + 3 × 12,800 × 0.1 = 19,840` — the non-serialised fan-out pays a
**69% premium on the fixed prefix** for no benefit. Whether a cache entry written
milliseconds earlier is visible is provider-specific (a hit requires the prefix to
match an already-stored entry — [OpenAI prompt
caching](https://developers.openai.com/api/docs/guides/prompt-caching)), so
serialisation is the only way to make read-after-write deterministic rather than
lucky.

One caveat worth stating rather than assuming: cache entries expire (commonly 5
minutes on the cheap tier). Roundtable rounds are issued back-to-back, so the TTL
is not a problem *today* — but a fix that inserts a human-in-the-loop pause
between rounds would silently lose the saving.

### 1.6 The concurrency gate: documented, but not wired to roundtable

`createSemaphore` (`src/tools.js:45-89`) is constructed once
(`src/tools.js:220`) and consumed at exactly two call sites — `src/tools.js:233`
and `src/tools.js:319` — both inside `agent_dispatch`. The roundtable executor
(`src/tools.js:391-425`) and the HTTP roundtable route (`src/http.js:421-429`)
call `runRoundtable` directly, and `runRoundtable` contains no gate of any kind
(`src/roundtable.js:22-56`).

With the shipped `maxConcurrent: 3` (`src/config.js:25`):

| Situation | Live external processes | Over limit |
|---|---|---|
| 1 roundtable, N=4 | 4 concurrently | 1 over |
| 1 roundtable, N=6 | 6 | 3 over |
| 5 concurrent roundtables, N=4 | 20 | **6.7×** |
| Roundtable while 3 dispatches in flight | 3 + N | 3 + N − 3 over |

The limit the user sets in configuration is not a limit. The README is explicit
that `agent_dispatch` is "受 `maxConcurrent` 并发上限约束" (README:31) and silent
about roundtable (README:32), so the asymmetry is at least undocumented — but the
failure mode is not cosmetic. A fan-out that trips a provider rate limit produces
a 429 on the last member; that member returns `ok: false`
(`src/roundtable.js:41-43`), and section 3 shows exactly what that does to the
debate: it silently shrinks the panel.

Routing roundtable through the same semaphore is therefore both the honest
implementation of the documented contract and the mechanism that makes Fix C2's
cache behaviour deterministic.

### 1.7 Sensitivity: does the conclusion survive other configurations?

**Rounds** (Fix A, realistic, pays the round-1 write):

| R | Current | Fix A | Saving |
|---|---|---|---|
| 1 | 75,200 | 88,000 | **+17.0%** (worse — do not cache) |
| 2 | 158,600 | 125,320 | −21.0% |
| 3 | 242,000 | 162,640 | −32.8% |

**Members** (Fix A, realistic, R=2): the *percentage* is invariant in `N` at
−21.0%, because cost and waste both scale linearly; what `N` changes is the
absolute bill.

| N | Current | USD | Fix A | Saving |
|---|---|---|---|---|
| 1 | 39,650 | $0.1190 | 31,330 | −21.0% |
| 2 | 79,300 | $0.2379 | 62,660 | −21.0% |
| 4 | 158,600 | $0.4758 | 125,320 | −21.0% |
| 6 | 237,900 | $0.7137 | 187,980 | −21.0% |
| 8 | 317,200 | $0.9516 | 250,640 | −21.0% |

The actionable framing is the dollar column: **one `agent_roundtable` call at the
shipped defaults is a ~$0.48 event** at Sonnet-tier pricing, with no confirmation
step, no reported number, and a tool description that says only "Every member
spends quota" (`src/tools.js:345`). A model that decides to hold two roundtables
to cross-check its own work has spent a dollar and cannot tell you.

---

## 2. Debate and N-version semantics

### 2.1 Is cross-provider debate scientifically meaningful?

Mostly not — and the distinction decides whether the feature is worth keeping.

The multi-agent-debate literature this feature implicitly invokes (Du et al.,
[arXiv:2305.14325](https://arxiv.org/abs/2305.14325)) is explicit about its
setup: "multiple agents represented as **copies of a large language model**", with
all experiments run on `gpt-3.5-turbo-0301`
([paper text](https://arxiv.org/html/2305.14325v1)). Diversity comes from
**sampling variance within one model**, so the comparison is controlled: every
agent shares knowledge, tools, and failure modes, and disagreement is therefore
evidence about *the question*. The paper also separates its two levers and finds
they are not interchangeable — "both multiple model agents and multiple rounds of
debate are important", with majority-voting over the same samples scoring well
below debate (Table 1: arithmetic 67.0 single agent / 69.0 majority / **81.8
debate**).

Compare what this plugin assembles at its default setting:

| Property | Du et al. (the literature) | This plugin's default |
|---|---|---|
| Population | N copies of one model | claude + codex + opencode (+ zcode): **different vendors, different base models** |
| Source of disagreement | temperature on shared knowledge | genuinely different knowledge, instruction priors, tool scaffolding |
| Comparability | answers comparable because priors match | answers differ for reasons unrelated to correctness (formatting, verbosity, tool access) |
| Convergence | measured; "almost always converges" | **never measured**; no consensus logic, no disagreement metric, no aggregation rule |
| Cache sharing | one model ⇒ shared provider-side prefix | independent vendor caches (section 1.6, 3.2) |

Two consequences follow.

**(a) Cross-provider disagreement is confounded.** When claude and codex disagree
you cannot tell whether that is evidence about the question or evidence about the
vendors. The inference "the converged answer is more likely correct" is only valid
under exchangeability, which four different base models do not satisfy. The
*valid* signals from a heterogeneous panel are weaker but real, and **all of them
need one round, not N**:

- **coverage** — one member knows an API or a codebase fact the others
  hallucinate; a single pass surfaces it;
- **calibration contrast** — a claim all four assert confidently is worth more
  than one only one asserts;
- **failure independence** — a bug triggered by one vendor's tool-use pattern
  will not appear in all four;
- **verifiability** — when the answer can be *checked* cheaply (tests pass,
  citation resolves, code compiles), N samples convert directly into accuracy.

**(b) Rounds are the weakest part of the design.** Round 2 asks each member to
critique 2,000-character excerpts of the others. With heterogeneous models this
mostly produces *restatement with acknowledgment* — the classic
convergence/sycophancy failure — because a model shown a confident answer from
another vendor has no shared prior to argue from and cheaply adopts it. The
plugin has no mechanism to detect the degenerate outcome (everyone agrees in
round 2), no disagreement metric, and no early stop. It pays **100% of round-2
cost unconditionally**, even when round 2 changes nothing.

### 2.2 When is N-version fan-out actually worth its cost?

Worth it when **at least one** of these holds:

1. **The answer is verifiable but expensive to get wrong** — a failing test one
   member's patch fixes, a compile error only one avoids, a citation that
   resolves. Verifiability is what converts N samples into accuracy.
2. **Members have genuinely different failure modes** — different tool
   availability, vendor-specific hallucinations, different context limits. This
   is the honest justification for the heterogeneous panel, and it needs **one
   round**.
3. **The cost of a wrong answer dwarfs `N·R × call cost`.** At ~$0.48 for a
   default call, fan-out is cheap insurance against a wrong architectural
   decision and absurd for "what does this function do".
4. **You will actually read the disagreement.** A panel whose output is truncated
   to 4,000 chars per member and then summarised by the caller is paying for
   diversity and discarding the evidence (section 3.3).

Not worth it when the question has one obvious answer (syntax, conventions), when
members share a base model (nothing new is learned), when nobody reads the
disagreements, or when `rounds > 1` manufactures a consensus the code never
measures.

### 2.3 Honest verdict on keeping it

**Keep:** the fan-out, per-member isolation, and above all the decision to return
raw answers and leave synthesis to the caller (`src/roundtable.js:3` states this
explicitly). `formatRoundtableText`'s side-by-side layout
(`src/roundtable.js:58-84`) is the correct shape for a human or parent model to
read — one header per member, failures inline, cheap to parse.

**Gate or drop:** multi-round debate by default. `rounds` already defaults to 1 in
the schema (`src/tools.js:353`) and in the coercion
(`Math.max(1, Math.min(3, Number(rounds) || 1))`, `src/roundtable.js:23`), which
is the right default. What is missing is any reason to raise it: no convergence
detection, no disagreement metric, no early stop, no per-round cost visibility.
As shipped, `rounds: 2+` is a *pay-more-for-different-prose* switch, not a
reasoning-improvement mechanism.

### 2.4 The `rounds` clamp, and a dead `model` path

`rounds` is clamped to 1..3 (`src/roundtable.js:23`) and the clamp is pinned by a
test (`tests/roundtable.test.js:97-103`). Defensible as a blast-radius cap, but
it is **silent**: `rounds: 10` runs 3 and no field says so. Worse, the result's
`rounds` key is the *last round's entries* (`src/roundtable.js:55`), overloading
the name, so a caller cannot distinguish "you asked for 10, I ran 3" from "I ran
10 and the last was short". The formatted text does print the true count
(`src/roundtable.js:78-82`), but only by iterating `debate`, so the caller must
count sections. A `requestedRounds` / `ranRounds` pair would close it.

A related gap is a **missing cost control**: `runRoundtable` accepts a `model`
parameter (`src/roundtable.js:22`) and forwards it (`:34`), but **neither caller
passes it** — the tool schema has no `model` field (`src/tools.js:349-355`) and
the HTTP route omits it (`src/http.js:421-429`). So every member runs on its own
default model, with no way to pin a cheap model for a four-member fan-out. The
plumbing exists and is unreachable.

---

## 3. Failure isolation, participant sets, truncation

### 3.1 A failed member silently shrinks the next round

The participant set for round `r > 1` is derived **only from `history`**
(`src/roundtable.js:28`: `rn === 1 ? ids : history.map(h => h.provider)`), and
`history` is appended **only on success** (`:47-53`: `if (!e.ok) continue`). So a
member that fails in round 1 is **absent from rounds 2 and 3 entirely** — no
retry, no substitution.

Verified: two members, `rounds: 2`, `bad` throws in round 1 ⇒
`r.debate[1].entries.length === 1`. The suite asserts exactly this
(`tests/roundtable.test.js:80-95`), and even its test name concedes the design
choice. The formatted output then reports `共 2 轮 / 末轮参与 1 家 / 成功 1 家`,
which is honest about the *count* but never says **which** member vanished or that
the round-2 "debate" was a monologue.

That is a semantic change, not just data loss. A two-member debate with one
survivor is not a debate: the survivor is asked to respond to other agents' views
while the peer block contains only its own entry (3.4). The caller asked a
question of a panel and got a solo answer labelled "round 2".

**Is that desirable?** Partly. Continuing with survivors is right for resilience —
one dead provider should not abort a paid run. What is *not* desirable is that the
shrinkage is invisible where conclusions are drawn. The result object records it
(`debate[i].entries`, `src/roundtable.js:46`), but the text the model reads reports
only the last round's counts (`:78-82`), so a reader sees "2 rounds" and a small
panel without connecting them.

### 3.2 A member that fails *after* round 1 does not shrink — it retries with stale peers

The inverse bug, and worse, because it corrupts the peer context. Because
`history` still holds the member's **round-1** entry, a round-2 failure leaves it
in `history`, so it is invited again in round 3. Verified:

```
call order  = a,b,a,b,a,b
round 1 -> a(ok) b(ok)
round 2 -> a(ok) b(FAIL)
round 3 -> a(ok) b(ok)
```

So "failure in round 1 is permanent, failure in round 2 is transient" — an
asymmetry with no principled basis. And the peer block is then **stale**: member
`a`'s round-3 prompt is labelled `其他 agent 的上一轮发言` ("the other agents'
remarks from the previous round") but contains `b`'s **round-1** answer:

```
其他 agent 的上一轮发言：
【a】  A-R1-TEXT
【b】  B-R1-TEXT
```

`B-R2-TEXT` (what `b` would have said in round 2) does not exist and is not
mentioned. `a` is told stale text is the previous round — a silently false
statement inside the prompt, so round 3 runs on contradictory premises. `history`
is keyed by member and never records *which round* a text came from
(`src/roundtable.js:50`), so the code cannot even detect the staleness.

### 3.3 Truncation throws away information that was already paid for

Two independent caps:

| Cap | Where | Effect |
|---|---|---|
| Peer context: 2,000 chars per answer | `src/roundtable.js:8` (`String(h.text \|\| '').slice(0, 2000)`) | Only ~500 tok of a 1,200-tok answer reaches peers |
| Displayed answer: 4,000 chars | `src/roundtable.js:71` (`txt.slice(0, 4000) + '\n…(截断)'`) | ~1,000 tok of a 1,200-tok answer reaches the caller |

Measured with a 9,000-character answer: peers see **2,000 chars = 22.2%** of it,
and the formatted output keeps 4,000. At the baseline `A = 1,200` tok (4,800
chars):

- the 4,000-char display cap discards **800 chars = 16.7%** of that member's
  answer — **5.0% of total roundtable spend is generated and then discarded**;
- the 2,000-char peer cap means a peer sees **41.7%** of the answer it is
  supposed to critique.

**Is that defensible?** The display cap has a weak justification (protect the
parent model's context), but it is applied to the *only* representation of the
answer: no "full text" path, no note saying how much was dropped, and no way for
the caller to request the full text even though it existed in memory a moment
earlier (`result.debate` is discarded by the tool layer, which returns only
`{ text, rounds }` — `src/tools.js:402`). The information was paid for at 5×
output rates and then deleted.

The peer cap is worse in kind, because it is *load-bearing for the feature*: the
whole point of round 2 is that a member reads others' reasoning. A model given the
first 41.7% of an answer sees a thesis and is asked to critique a conclusion whose
argument it was never shown. Long-answer members — exactly the coding agents this
plugin targets — are structurally advantaged or disadvantaged by whatever happens
to fall in the first 2,000 characters.

`formatRoundtableText` is also the wrong home for the cap: it is a *presentation*
function (`src/roundtable.js:58`), yet it is the only path from `runRoundtable` to
the caller, so a rendering concern has silently become the data contract.

### 3.4 A member is handed its own answer, labelled as another agent's

The peer block is built from **all** of `history`, with no filter for the current
member (`src/roundtable.js:7-9`), and the current member's entry is always in
`history` by round 2 (`:47-53`). Verified — member `a`'s round-2 prompt contains:

```
其他 agent 的上一轮发言：
【a】 ANSWER-FROM-a
【b】 ANSWER-FROM-b
【c】 ANSWER-FROM-c
```

The member is instructed, in a block titled "the other agents' remarks", to
respond to the above views — including its own, presented as someone else's. This
costs real money (a fourth `PEER` entry, ~500 tok, spent on text the model already
generated: 2,050 → 1,550 tok, −1.2% of spend) and, more importantly, it is a false
statement in the prompt that invites a model to argue against itself or treat its
own prior answer as external corroboration. Filtering `h.provider !== currentId`
is the cheapest correctness fix in this audit and makes the block title true.

### 3.5 Total failure produces an empty round and a "completed" job

If every member fails in round 1 with `rounds: 2`, `history` stays empty, so
round 2's `activeIds` is `[]` (`src/roundtable.js:28`) and `Promise.all([])`
resolves to `[]` (`:45`). Verified output:

```
共 2 轮 / 末轮参与 0 家 / 成功 0 家
圆桌问题: Q

━━ 第 1 轮 ━━
[a] 失败: a boom
[b] 失败: b boom

━━ 第 2 轮 ━━
```

An empty `━━ 第 2 轮 ━━` section, and the job settles `status: 'completed'`
(`src/tools.js:414`). Nothing throws, nothing is marked failed; the caller must
read the counts to notice the entire run produced nothing. A round with zero
active members should be skipped rather than rendered.

This is not hypothetical: it is what a fresh install without the four CLIs
produces. A real run on this host, where all four providers reported
`available: true`, gave `共 1 轮 / 末轮参与 4 家 / 成功 0 家` with four spawn
failures (section 4.4).

---

## 4. Delegation quality and the two-layer backend fallback

### 4.1 Prompt framing: `agent_dispatch` vs the official `subagent` tool

Both take `{ prompt }` as their load-bearing argument, but the official
`subagent` tool (`@deepseek-ai/dsh-tool-subagent`, `lib/index.js:339-343`) states
the contract the child operates under, while `agent_dispatch`
(`src/tools.js:251-268`) does not:

| Contract element | Official `subagent` tool | `agent_dispatch` |
|---|---|---|
| Whether the child sees this conversation | Stated per backend: "seeded with all completed turns" vs "does not share this conversation's context" (`lib/index.js:336-343`) | **Absent** |
| Prompt self-containment instruction | "include everything it needs" / "state only what is new" (`:337`, `:342`) | **Absent** |
| cwd semantics | "omitted inherits it; later changes are independent" (`:388`) | "defaults to `config.defaults.defaultCwd`" (`src/tools.js:263`) — different default, no inheritance rule |
| Output contract | typed object with schema | free text, re-truncated to 4,000 chars (`src/tools.js:194-196`) |
| Model / route selection | first-class `provider`/`model`/`reasoning_effort` (`:404-417`) | one `model` string forwarded to whatever CLI it lands on (`src/tools.js:265`) |
| Depth control | `maxDepth` capability negotiation | **Absent** |

The most consequential absence is the first row. `agent_dispatch` can route to a
cold CLI process *or* an official one-shot activation (`src/backend.js:324-339`),
and **neither is a conversation fork** — but the tool description never tells the
model the child is context-free. The model learns self-containment only by
accident, from `agent_roundtable`'s description (`src/tools.js:343`). The
`COST_WARNING` (`src/tools.js:17`) warns about quota and file writes, not about
missing context — which is the failure mode that actually yields a useless answer.

`cwd` deserves its own note. `resolveCwd` (`src/tools.js:157-160`) returns
`undefined` when neither the argument nor `defaults.defaultCwd` is set, and every
provider then leaves `spawn`'s `cwd` undefined (`src/runner.js:37`), so the child
inherits **the DSH host process's** working directory — an incidental value
unrelated to the parent agent's current directory. The official path does better
by explicit inheritance (`request: { parent, … }`, `src/backend.js:235-240`), so
the same call can operate in two different directories depending on routing.

### 4.2 Does the two-layer fallback make the same call predictable? No.

`resolve()` (`src/backend.js:324-339`) checks, in order: the configured
`subagentProvider` (`:326` via `:75-82`), a live parent (`:78`), that provider
being registered on `ctx.subagents` (`:79`), and otherwise falls through to the
CLI backend (`:338`). Three of those four inputs are invisible to the calling
model, and one can change between two turns of the same session.

Verified behaviour:

```
with live parent  -> claude:subagent  codex:subagent  opencode:cli  zcode:cli
without parent    -> claude:cli  codex:cli  opencode:cli  zcode:cli
```

The same `provider: "claude"` therefore means an official one-shot activation in a
normal tool call and a local CLI subprocess from the HTTP panel
(`src/http.js:389-397` resolves without `parent`) or any headless composition.
That silent switch changes five observable properties at once:

| Property | `subagent` path | `cli` path |
|---|---|---|
| Session | fresh one-shot activation, disposed after (`src/backend.js:232-271`) | persistent local CLI session with resumable id (`src/provider/claude.js:43`) |
| `resumeSessionId` | **rejected** (`src/backend.js:152-157`) | accepted and forwarded |
| `model` / `timeoutMs` | **silently ignored** (`src/backend.js:216-218`) | honoured (`src/provider/claude.js:44-45`) |
| Sandbox / permissions | official package's route and limits | the local CLI's own config |
| History / import | no local session exists | appears in `agent_sessions` |

Two are outright traps:

1. **`model` is silently dropped on the subagent path.** The tool advertises it as
   "Override the target model" (`src/tools.js:265`). A caller setting it to
   control cost gets the official provider's configured model instead, with no
   error and no result field saying so.
2. **`resumeSessionId` fails loudly, but only after an activation has started.**
   The rejection is thrown at `src/backend.js:248`, *inside* the `try` that follows
   `startActivation` at `:232`. A caller deliberately resuming prior work therefore
   gets a failed dispatch **and** a partial charge for starting (and, for a
   provider that initialises its runtime at start, initialising) a child that is
   immediately discarded. The check belongs before line 232.

The documented mitigation is that "every tool result carries `backend`"
(README:25). True in the foreground return value (`src/tools.js:241-248`) — but
**not visible to the model**: `renderDispatch` (`src/tools.js:193-199`) prints only
a header built from `provider` and `externalSessionId` (`:273`), and the background
header is the same (`:327`). So the one signal that would let the model reason
about resume, model support, and session availability is dropped in the final
step. The fix is one string concatenation.

**Verdict:** two-layer fallback is a sound *deployment* strategy (prefer the
maintained official package) implemented as an *invisible* one. Predictability
requires routing to be observable and declarable — a caller must be able to say
"I need resume, give me the CLI path", or at minimum read `backend` in the text it
receives. What the user loses today is the ability to reason about *which* runtime
answered, and therefore about reproducibility, cost, and whether a follow-up is
even possible.

### 4.3 A correctness bug: `enabled: false` is ignored for provider selection

`config.providers.*.enabled` is validated (`src/config.js:94`) and documented as
the off switch (README:89-93). But `buildProviders` (`src/providers.js:17-29`)
constructs all four providers unconditionally, and only `zcode`'s own
`dispatch`/`detect` honour the flag (`src/provider/zcode.js:37-38`, `:48-49`).
`resolver.list` reports `available: true` for a disabled provider
(`src/backend.js:363-371`) because `cliLookup` (`:85-111`) only asks whether the
registry contains the id.

Verified: with `loadConfig({ providers: { claude: {enabled:false}, codex:
{enabled:false} } })`, `resolver.list()` returns
`claude:cli:true  codex:cli:true  opencode:cli:true  zcode:cli:true`.

Because `agent_roundtable` defaults its participant set to *every* resolved
backend (`src/roundtable.js:24`), **a user who disables providers to save money
still pays for all of them.** That is the highest-severity cost/security finding
in this audit, and it is a two-line fix.

### 4.4 "available" means "registered", not "working"

Nothing calls `registry.detectAll()` outside tests — `src/provider/types.js:28` is
its only occurrence in `src/`. So `available` is registry membership, not
installation. The capability exists and is tested
(`tests/providers-factory.test.js:17,30`) but is never wired to the default member
set.

A real run on this host, where all four reported `available: true`, produced:

```
attempted = ["claude","codex","opencode","zcode"]
  claude   FAIL: spawn /data/data/com.termux/files/usr/bin/grun ENOENT
  codex    FAIL: exit 1: MODULE_NOT_FOUND
  opencode FAIL: spawn /home/dsh/.local/share/xucodex/opencode/bin/opencode
  zcode    FAIL: zcode 未启用：...
```

The default call burned the full `N·R` slot budget to produce
`共 1 轮 / 末轮参与 4 家 / 成功 0 家`. Detecting once and filtering the default
set would prevent every such call — the code already exists.

---

## 5. What a senior engineer changes first

Ranked by benefit / effort. `S` ≈ under 30 minutes, `M` ≈ hours, `L` ≈ a day or
more.

| # | Change | Effort | Benefit | One-line justification |
|---|---|---|---|---|
| 1 | **Fix A: make round 2's prompt start with `basePrompt`** — `[basePrompt, '', '【第N轮辩论】…', peer…].join('\n')` instead of header-first (`src/roundtable.js:10-19`) | S | **−21.0%** on every `R ≥ 2` call (−29.1% ceiling) | The whole round-1 `S+P` prefix becomes cacheable for one array reorder, and it works on both backend paths — unlike resume, which the official path rejects. |
| 2 | **Honour `enabled: false` and filter the default member set through `detectAll()`** (`src/providers.js:17-29`, `src/roundtable.js:24`) | S | Up to **100%** of spend on disabled/uninstalled members | Two lines stop the tool paying four vendors when the user disabled three, and stop it launching members whose CLIs do not exist. |
| 3 | **Exclude the member's own answer from the peer block** (`src/roundtable.js:7-9`) | S | −1.2% cost; removes a false statement from the prompt | Members are told their own round-1 answer is "another agent's remark", which wastes tokens and invites self-contradiction. |
| 4 | **Report `backend` and per-member token usage in the result text** (`src/tools.js:193-199`, `:327`; capture usage in `src/backend.js:195-201`) | S–M | 0% direct; makes every other number here verifiable | The plugin is a black box that costs money; one surfaced field turns cache work, model choice, and quota attribution from guesswork into measurement. |
| 5 | **Route roundtable through the existing semaphore** (`src/tools.js:391-425` → `gate.run`) | S | −10.4% on shared-provider fan-outs; prevents rate-limit member loss | `maxConcurrent` is documented and currently bypassed entirely, so a fan-out can open `N ×` the configured processes and turn a 429 into a silently shrunken panel. |
| 6 | **Validate `resumeSessionId` before `startActivation`** (`src/backend.js:248` → before `:232`) | S | Avoids a partial charge on every rejected resume | The current order starts and disposes a child only to throw the result away. |
| 7 | **Make the two caps configurable, and stop discarding paid output** (`src/roundtable.js:8`, `:71`) | S | Recovers **5.0%** of spend at `A = 1,200`; much more for long answers | Output billed at 5× is deleted by a presentation function; keep full text in the result and cap only the render. |
| 8 | **Make multi-round debate convergence-gated, or drop it** (`src/roundtable.js:27-54`) | M–L | −21% to −33% by not running round 2 when it adds nothing | Round 2 costs a third of the run with no measured benefit, no disagreement metric, and no early stop; until that instrumentation exists, the honest default is `rounds: 1`. |

Two things deliberately **not** on this list:

- **Fix B (per-member resume).** It saves no more than Fix A (20.7% vs 21.0%),
  costs far more to build across three CLI dialects, and is unsupported on the
  official subagent path (`src/backend.js:152-157`). Revisit only if a caller
  needs conversational continuity *within* a member across separate tool calls —
  a different feature.
- **Cross-provider cache sharing.** It does not exist and no fix in this plugin
  can create it (`subagent-codex/README.md:142-144`,
  `subagent-claude-code/README.md:144-146`). Any plan premised on it is void.

---

## 6. Verification log

All code claims were checked against `e15fcf8`; behavioural claims were checked by
executing the shipped modules with stub providers, so no external CLI was invoked
and no quota was spent.

| Check | Method | Result |
|---|---|---|
| Round 1 vs round 2 prefix relationship | Ran `runRoundtable` with two stub members, `rounds: 2`, 800-char base prompt | common prefix length `0`; round 2 *contains* round 1 as a substring |
| No resume in roundtable | `grep -n resumeSessionId src/roundtable.js` | no match; `dispatch` receives no session id (`src/roundtable.js:33-35`) |
| Gate coverage | `grep -n "gate.run" src/` | exactly two sites, both in `agent_dispatch` (`src/tools.js:233`, `:319`) |
| Usage fields never read | `grep -rn "usage\|cacheReadTokens\|cacheWriteTokens" src/` | no match |
| `enabled: false` ignored | `loadConfig({providers:{claude:{enabled:false}}})` → `resolver.list()` | still `available: true` for every provider |
| `detectAll()` unused | `grep -rn detectAll src/ index.js client.js` | only the definition (`src/provider/types.js:28`) |
| Default member set on a bare host | ran the default path with real provider `dispatch` | four spawn failures; `成功 0 家` |
| Failure in round 1 removes member later | stub where `bad` throws in round 1, `rounds: 2` | `debate[1].entries.length === 1` |
| Failure in round 2 does **not** remove member | stub where `b` throws only on its 2nd call, `rounds: 3` | `b` retried in round 3 |
| Stale peer text after a mid-run failure | same run; inspected `a`'s round-3 prompt | peer block holds `b`'s **round-1** text, labelled "previous round" |
| Own answer included in peer block | 3 stub members; inspected `a`'s round-2 prompt | labels `a,b,c` — own answer present under "other agents" |
| Total failure with `rounds: 2` | both stubs throw | empty `━━ 第 2 轮 ━━`; job still `completed` |
| Peer cap discards long answers | 9,000-char answer | peer sees 2,000 chars (22.2%); display keeps 4,000 |
| Two-layer routing flips on parent presence | `resolve`/`list` with and without a live parent | `claude:subagent` vs `claude:cli` |
| `resumeSessionId` rejected on subagent path | subagent backend with a resume id | throws after `startActivation`; one disposal observed |
| `model` not plumbed into roundtable | `grep -n model src/roundtable.js`, `src/tools.js:391-399`, `src/http.js:421-429` | accepted at `:22`, forwarded at `:34`, never supplied by any caller |

Cost figures are arithmetic from the model in section 1.2, reproduced by a
standalone script; they are not measurements. The plugin cannot produce
measurements (section 1.1) — which is itself change #4 in section 5.
