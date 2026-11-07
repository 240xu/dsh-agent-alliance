# C1 — External authorities for the audit's load-bearing claims

**Status: IN PROGRESS.** This file is written incrementally; each section is
appended as its evidence is gathered so a network failure cannot lose the whole
report.

Scope: only claims that rest on an **external** authority (vendor docs, papers).
Claims about our own code are out of scope here (they belong to the code audits).
Every claim below is either backed by a quoted primary source, or explicitly
marked **UNVERIFIED**.

Verdict legend:

- **CONFIRMED** — primary source states it.
- **CORRECTED** — primary source says something different; the audit's number or
  framing is wrong.
- **PARTIAL** — true under conditions the audit omits.
- **UNVERIFIED** — no primary source found; do not rely on it.

---

## 3. The 21.0% saving: independent recomputation

This section needs no network and is settled first.

Source under test: `docs/audit/04-orchestration.md` §1.2–1.3, as it stood when
this report was written.

### 3.1 Stated assumptions

| Symbol | Meaning | Value |
|---|---|---|
| `S` | system prompt + tool schema + harness instructions, per dispatch | 12,000 tok |
| `P` | base question | 800 tok |
| `A` | answer tokens per member per round | 1,200 tok |
| `PEER` | round-2+ peer block | 2,050 tok |
| `N` | members | 4 |
| `R` | rounds | 2 |
| input | 1 input token | 1.0 unit |
| cache write | 1 token written to cache | 1.25 units |
| cache read | 1 token read from cache | 0.1 units |
| output | 1 output token | 5.0 units |

Round-2 prompt = `S + P + PEER` = 12,000 + 800 + 2,050 = **14,850** tok.
Fixed prefix `S + P` = **12,800** tok.
Output per member per round = 1,200 × 5.0 = **6,000** units; per round (N=4) =
**24,000**; across both rounds = **48,000**.

### 3.2 Current design (no caching)

```
round 1 input : 4 × 12,800            = 51,200
round 1 output: 4 × 1,200 × 5.0       = 24,000   -> 75,200
round 2 input : 4 × 14,850            = 59,400
round 2 output: 4 × 1,200 × 5.0       = 24,000   -> 83,400
total         = 75,200 + 83,400       = 158,600
```

Matches the audit's **158,600**. Output share = 48,000 / 158,600 = **30.26%**
(printed 30.3%). USD at 3e-6 = **$0.4758**. All three check out.

### 3.3 Fix A (round 2 keeps `S+P` as a strict prefix; round 1 pays the write)

```
round 1 input : 4 × 12,800 × 1.25      = 64,000
round 1 output:                        = 24,000   -> 88,000
round 2 input : 4 × (12,800 × 0.1 + 2,050 × 1.0)
              = 4 × (1,280 + 2,050)    = 13,320     [cached prefix read @0.1,
                                                     only PEER at full price]
round 2 output:                        = 24,000   -> 37,320
total         = 88,000 + 37,320       = 125,320
```

Saving vs current: `1 − 125,320 / 158,600` = `1 − 0.79016` = **20.98% → 21.0%**.

USD: 125,320 × 3e-6 = $0.37596 → **$0.3760**.
Output share: 48,000 / 125,320 = **38.30%**.

### 3.4 Verdict on §1.3

**The 21.0% figure is arithmetically correct under the stated assumptions.**
Every printed value in the Fix A row — 125,320 tok-eq, $0.3760, −21.0%, 38.3% —
reproduces exactly. So do the current-design baseline (158,600 / $0.4758 /
30.3%), the own-answer-excluded row (123,320 / $0.3700 / −22.2% / 38.9%), the
trap row (186,250 / $0.5587 / +17.4% / 25.8%), and C2 (142,090 / −10.4%).

**So: no arithmetic error to report.** The audit's §1.3 math is sound. Whether
the *assumptions* are right is a separate question, and it is what the rest of
this document is about.

### 3.5 Assumption defects found while reproducing the table

I first wrote three defects here, then re-tested each against the audit's own
numbers. **Two of my three were wrong** — the audit's rows are more internally
consistent than they look. Corrections recorded rather than deleted:

1. **WITHDRAWN — `PEER` charging was not inconsistent.** I initially claimed the
   Fix A row charges `PEER` at 1.0x while the trap row charges it at 1.25x. That
   compares two different scenarios: Fix A leaves `PEER` after a *breakpoint*
   (uncached suffix, full price), while the trap row writes the *entire*
   `S+P+PEER` block because the prefix is header-first (everything is a write).
   Both rows are internally correct. Recomputing Fix A with `PEER` as a write
   gives −19.7%; the audit's −21.0% is the correct figure *for the scenario it
   labels*. **No defect.**

2. **Fix B does reproduce — WITHDRAWN.** I first reported 125,800 as
   irreproducible. It reproduces exactly if a resumed member's own previous
   answer `A` is also served from that member's session cache at 0.1x:
   `r2 per member = 12,800*0.1 + 2,050*1.0 + 1,200*0.1 = 3,450`, giving
   `4*12,800*1.25 + 4*3,450 + 48,000 = 125,800`. The difference from Fix A is
   exactly `N*A*0.1 = 480`, i.e. Fix B's *only* modelled advantage is caching the
   member's own answer, worth 0.3 points — which is why the audit says the two
   are "essentially the same". **The audit is right and my original claim was
   wrong.**

3. **CONFIRMED defect — the "already warm" row is mislabelled.** `112,520` is
   *exactly* `125,320 − 12,800`, i.e. it deletes the write premium
   (`4 × 12,800 × 0.25`) and still bills the prefix at 1.0x in round 1. A
   genuinely warm prefix is a **cache read at 0.1x**, which gives
   `4*12,800*0.1 + 48,000 + 4*(12,800*0.1 + 2,050) = 66,440`, a **58.1%**
   saving — not 29.1%. The audit labels this row "if the `S+P` prefix was already
   warm before round 1" and then reports it as the *ceiling*. It is not a warm
   cache; it is a no-write-premium cache. **The true ceiling is much higher, so
   the audit's "realistic 21–29%" band is understated, not overstated.** The
   conservative direction of the error does not change any recommendation, but
   the label is wrong and a reader will take −29.1% as the maximum achievable,
   which it is not.

4. **CONFIRMED — the ratios are Anthropic-only.** §1.2 asserts the ratios "match
   published cache pricing structure" and cites a single Anthropic page while
   modelling four vendors. See §1.6: OpenAI's write rate is 0.0x on models before
   GPT-5.6. Direction of error: conservative for the audit.

---

*Remaining sections (§1 ratios/prefix/TTL, §2 output caching, §4 subprocess cache
sharing, §5 debate literature) are being filled in below as sources are fetched.*

---

## 1. Cache pricing ratios, minimum prefix, TTL

### 1.1 Anthropic — ratios

Primary source: [Prompt Caching — Design & Optimization](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/prompt-caching.md)
(Anthropic's own `anthropics/skills` repository, `skills/claude-api/shared/prompt-caching.md`).

> "**Economics:** Cache reads cost ~0.1× base input price - **0.025× on Claude
> Fable 5.1** ($0.25/MTok, on Claude Mythos 5.1 too) and 0.05× on Claude Opus 5.5
> ($0.20/MTok), which moves every break-even below proportionally. Cache writes
> cost **1.25× for 5-minute TTL, 2× for 1-hour TTL**."

| Audit ratio | Verdict | Reality |
|---|---|---|
| cache write = **1.25×** input | **CONFIRMED, incomplete** | 1.25× only for the **5-minute** TTL. The 1-hour TTL is **2×**. |
| cache read = **0.1×** input | **CONFIRMED, incomplete** | 0.1× is the *default*. It is **0.025×** on Claude Fable 5.1 / Mythos 5.1 and **0.05×** on Claude Opus 5.5. |
| output = **5×** input | see §1.4 | Not stated in the caching doc; checked against the pricing page there. |

The direction of both defects is **conservative for the audit**: cheaper reads
(0.025×) make caching *more* attractive than modelled, and a 2× write only
applies if the fix selects the 1-hour TTL — which it would not, since
back-to-back rounds are well under 5 minutes.

Also confirmed verbatim, and it is the sentence the audit's whole "Fix A" rests
on:

> "**Prompt caching is a prefix match. Any change anywhere in the prefix
> invalidates everything after it.**"

And on the specific shape the audit recommends (shared prefix, varying suffix):

> "Put the breakpoint at the end of the **shared** portion, not at the end of the
> whole prompt - otherwise every request writes a distinct cache entry and
> nothing is ever read."

That is precisely the audit's "trap" scenario (§1.3, +17.4%), independently
confirmed by the vendor's own guidance.

### 1.2 Anthropic — minimum cacheable prefix (per model, not a flat number)

> "Minimum cacheable prefix is model-dependent. Shorter prefixes silently won't
> cache even with a marker - no error, just `cache_creation_input_tokens: 0`"

| Model family | Minimum |
|---|---:|
| Claude Opus 5.5, Opus 5, Fable 5, Mythos 5, Fable 5.1, Mythos 5.1, Sonnet 5.5, Haiku 5.5 | 512 tokens |
| Opus 4.8, Sonnet 5, Sonnet 4.6, Sonnet 4.5, Opus 4.1, Opus 4, Sonnet 4 | 1024 tokens |
| Opus 4.7, Mythos Preview, Haiku 3.5 | 2048 tokens |
| Opus 4.6, Opus 4.5, Haiku 4.5 | 4096 tokens |

**This matters for the audit's central number, and in the *safe* direction.**
The prompt the audit caches is `S + P` ≈ **12,800 tokens** — above the largest
documented minimum (4,096) by more than 3×. So:

- **No model in the table would refuse to cache the round-1 prefix.**
- The audit never states a minimum-prefix assumption at all, so this is an
  **omission rather than an error**: it happens to be safe at `S+P ≈ 12.8K`, but
  the model has no term for the threshold. If a future configuration shrinks `S`
  (a lighter tool schema, a smaller harness preamble) below 4,096 tokens on
  Opus 4.6/4.5 or Haiku 4.5, caching would **silently stop** — no error, just
  `cache_creation_input_tokens: 0` — and the −21.0% would become a **pure
  write-premium surcharge**, i.e. the +17.4% trap row. The audit's §1.5 advice to
  "gate cache work on `R ≥ 2`" is necessary but **not sufficient**; a
  `prefix ≥ model minimum` condition is also required.
- The audit should state `minPrefix(model)` instead of assuming any non-trivial
  prefix caches.

### 1.3 Anthropic — TTL

> `"cache_control": {"type": "ephemeral"}` // 5-minute TTL (default)
> `"cache_control": {"type": "ephemeral", "ttl": "1h"}` // 1-hour TTL

> "A cache read refreshes the entry's timer at no additional cost, on either TTL.
> The lifetime is measured from the **start** of the request that writes or reads
> the entry - generation time counts against it, so a 4-minute generation leaves
> about 1 minute for the next request to start before a 5-minute entry expires."

The audit's §1.5 caveat ("cache entries expire, commonly 5 minutes on the cheap
tier") is **CONFIRMED**, with a sharper and more dangerous detail the audit
misses: **the TTL clock starts at request start, and generation time counts
against it.** For a coding-agent roundtable with 1,200-token answers the
generation is short, so this is fine today — but it makes the audit's own
warning more urgent for the 3,000–4,000-token-answer case it claims is realistic
in §1.4. A 4-minute generation leaves ~1 minute of headroom for the round-2
dispatch to *start*. Under the audit's own "answers are routinely 3–6k tokens"
scenario, slow generation can eat most of a 5-minute TTL.

### 1.4 Anthropic — is output cached? and the 5× output ratio

> "**`input_tokens` is the uncached remainder only.** Total prompt size =
> `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`."

The cache accounting is defined **entirely over input tokens**; output tokens
enter no cache field. This supports "output tokens are never cached", but it is
an absence of evidence in this document — see §2 for the explicit check.

### 1.5 Anthropic — concurrency: the audit's §1.5 claim is vendor-confirmed

This is the single strongest external confirmation in the whole review. The
vendor states the mechanism the audit only inferred:

> "**Concurrent-request timing.** A cache entry becomes readable only after the
> first response **begins streaming**. N parallel requests with identical
> prefixes all pay full price - none can read what the others are still writing."
>
> "For fan-out patterns: send 1 request, await the first streamed token (not the
> full response), then fire the remaining N-1. They'll read the cache the first
> one just wrote."
>
> "The same arithmetic shapes multi-agent designs: N parallel workers each
> assembling a slightly different prompt over the same context write N separate
> cache entries and read none of each other's. When input cost dominates, fewer
> lanes over a byte-identical shared prefix - or one worker making N sequential
> passes - turn those writes into reads."

The audit's §1.5 claim that four racing requests pay `4 × 12,800 × 1.25` while
serialised they pay `12,800 × 1.25 + 3 × 12,800 × 0.1` is **CONFIRMED** — including
the "serialisation is the only way to make read-after-write deterministic"
conclusion, and its `+69%` premium on the fixed prefix.

### 1.6 OpenAI — ratios, minimum prefix, TTL: the audit is WRONG for OpenAI

Primary source: [Prompt caching — OpenAI API](https://developers.openai.com/api/docs/guides/prompt-caching)
(fetched via the [r.jina.ai](https://r.jina.ai/https://developers.openai.com/api/docs/guides/prompt-caching)
text mirror; `developers.openai.com` itself returns HTTP 403 to this host).
Corroborated by Microsoft's independently-maintained
[Prompt caching with Azure OpenAI](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching)
(last updated 2026-11-06).

The audit's §1.2 says the three ratios "match published cache pricing structure
(e.g. Claude ...)" and cites **only Anthropic**. It then applies the Anthropic
ratios to a **four-vendor** roundtable. That is wrong for three of the four
vendors; OpenAI is documented in full.

> "For GPT-5.6 and later, cache writes cost **1.25× the standard, uncached
> input-token rate** for the default **30-minute** lifetime. In the Responses
> API, you can choose a **12-hour** minimum lifetime at a write rate of **2.5×**
> ordinary input. Subsequent reads cost **0.1×** the ordinary input rate on most
> of these models and **0.05×** on GPT-6.1 Sol and GPT-6.1 Terra, regardless of
> the selected lifetime."

Crucially — and this is the part the audit's whole model silently depends on —
older OpenAI models charge **nothing** to write:

> "| Cache write charge | 1.25× for `"30m"`; 2.5× for `"12h"` in the Responses API |
> **No additional cache-write charge** | **No additional cache-write charge** |"
>
> (columns: GPT-5.6 and later | GPT-5.5 and GPT-5.5 Pro | Other earlier models)

Azure states the same rule more bluntly:

> "Models before the GPT-5.6 family don't charge extra to write to the cache. On
> GPT-5.6 models and later model families, cache writes can incur charges in
> addition to discounted cache reads."

| Audit ratio | Anthropic | OpenAI (GPT-5.6+) | OpenAI (GPT-5.5 and earlier) |
|---|---|---|---|
| cache write | 1.25× (5 min) / 2× (1 h) | **1.25×** (30 min) / **2.5×** (12 h) | **0× — free** |
| cache read | 0.1× (0.025×/0.05× on newest) | **0.1×** (0.05× on GPT-6.1 Sol/Terra) | model-dependent cached-input rate |
| output | see §2 | see §2 | see §2 |

**Verdict: PARTIAL / CORRECTED for OpenAI.** The 1.25× and 0.1× ratios are
correct for *current* OpenAI models but **wrong for the older ones where writes
are free**, and the audit never distinguishes. This error is *conservative*: a
free write makes Fix A strictly better than modelled, never worse. But it means
the audit's claim that these are universal "published cache pricing structure"
is not supportable — the ratios are **per-vendor-per-model**, and the audit
cites one vendor's page as if it covered all four.

Azure also documents a second, differently-shaped constraint:

> "A minimum of 1,024 tokens in length. The first 1,024 tokens in the prompt must
> be identical."

> "On GPT-5.5 and earlier models, cache hits after the first 1,024 tokens occur in
> **128-token increments**."

OpenAI's own doc confirms the 1,024 floor and adds that hidden tokens don't count:

> "A prompt prefix must meet the model's **minimum cacheable token length** before
> it can be cached. Tokens in the OpenAI-provided hidden system content do not
> count toward this minimum. The minimum cacheable prompt length is **1,024
> tokens** for GPT-5.6 and later and varies by request settings for earlier
> models."

So the user brief's "OpenAI uses 1024-token granularity" is **CONFIRMED as a
minimum**, with the refinement that on pre-GPT-5.6 models hits are additionally
rounded to 128-token boundaries — so a 12,800-token prefix yields 12,800 usable
cached tokens (a multiple of 128), and the `S+P` prefix is 12.5× the floor.

**TTL, OpenAI.** Three different answers depending on model family:

> "| Cache lifetime | Minimum lifetime of 30 minutes or 12 hours ... | Typically
> around 30 minutes, up to 24 hours | Typically 5 to 10 minutes inactive for
> `in_memory`, or up to 24 hours for `24h` |"

and for older models:

> "`in_memory`: Entries typically remain active for around **5 to 10 minutes** of
> inactivity, up to one hour."

The audit's "commonly 5 minutes on the cheap tier" is therefore **correct for
Anthropic (exactly 5 min) and for older OpenAI `in_memory` (5–10 min)**, but
**understates** current OpenAI (30 min default) — again conservative.

### 1.7 Does the minimum prefix change the 21% claim? — No, at `S+P ≈ 12.8K`

This was the sharpest question in the brief, and the answer is reassuring but not
free.

**The claim survives on every documented model.** The cached prefix `S + P` is
~12,800 tokens. The largest documented minimum anywhere is **4,096** (Anthropic
Opus 4.6/4.5, Haiku 4.5); OpenAI's floor is 1,024. 12,800 exceeds the worst case
by **3.1×**. No vendor would silently decline to cache it.

**But the audit's model has no term for the threshold, and that is a real
defect.** Both vendors cache *silently* when the prefix is too short:

> "Shorter prefixes silently won't cache even with a marker - **no error, just
> `cache_creation_input_tokens: 0`**" (Anthropic)

If a configuration change shrinks `S` below the model minimum — a lighter tool
schema, a trimmed harness preamble, a smaller member set — the outcome is not
"caching does nothing", it is **the +17.4% trap row**: every round pays the 1.25×
write premium and never reads. The audit's §1.5 gate ("only cache when `R ≥ 2`")
is **necessary but not sufficient**; the correct gate is
`R ≥ 2 AND (S + P) ≥ minPrefix(model)`.

How the saving degrades if the prefix *is* below the minimum:

| Case | Effect on the −21.0% claim |
|---|---|
| `S+P ≥ minPrefix` (today, 12,800 vs ≤4,096) | Claim holds as computed. |
| `S+P < minPrefix` | Caching **cannot** engage at all. Round 2 is byte-identical in cost to round 1 → saving becomes **0%**, and if the fix still requests caching, the premium makes it **worse than baseline** (the audit's own +17.4% trap). |
| Margins: prefix just above minimum, on a 128-token rounding boundary (OpenAI pre-5.6) | Up to 127 tokens of the prefix are billed uncached; negligible at 12.8K, ~1% of the prefix. |

So the correct statement is: **the 21.0% is conditional on `S+P` clearing a
model-specific floor, which at 12,800 tokens it does — but the audit should say
so, because the failure mode is silent and inverts the sign of the fix.**

---

## 2. "Output tokens are never cached" — CONFIRMED for both vendors

The audit asserts this twice and it is load-bearing: §1.4 calls 30.3% the
"structural floor" and derives that "69.7% is the absolute maximum any caching
work could ever save".

### 2.1 OpenAI — explicit, quotable

> "No. Prompt caching does not change how the model generates output tokens. The
> model generates a new response using the cached prefix, so identical requests
> are not guaranteed to produce identical outputs."
> — [Prompt caching — OpenAI API](https://developers.openai.com/api/docs/guides/prompt-caching)

Also, the OpenAI cache is scoped to input by construction:

> "The prompt cache stores key-value (KV) tensors, not the tokens themselves."
> "Prompt caching preserves that state for a reusable **prefix**: the unchanged
> tokens at the beginning of a prompt."

And the billing fields are all input-side:
`usage.input_tokens_details.cached_tokens` and `…cache_write_tokens`, with
`cache_write_tokens_details` split into `ttl_30m_tokens` / `ttl_12h_tokens`.
Anthropic's equivalents are `cache_creation_input_tokens` /
`cache_read_input_tokens`, both explicitly *input*.

**Verdict: CONFIRMED.** For both vendors the cache is a prefix/KV cache over
input only. No vendor documents caching of generated output, and both vendors'
usage vocabularies have no output-cache field. The audit's structural-floor
argument stands.

### 2.2 Scope note the audit should add

"Never cached" is true but the audit's phrasing "output tokens are never cached
by any provider" is an **absolute claim about the whole industry**, which two
vendors' docs cannot establish. Within the scope that matters here — the four
vendor CLIs the plugin dispatches to — it is confirmed for the two vendors that
publish caching docs. I did **not** find primary documentation for OpenCode's or
ZCode's underlying providers, so the universal quantifier is
**PARTIAL / over-broad**: correct for Anthropic and OpenAI, **UNVERIFIED** for
the other two members. The recommendation (cap answer length) is unaffected.

---

## 4. Do Claude Code / Codex subprocesses share prompt cache with parent or siblings?

The audit's §1.3(b) claim: "four vendors have four independent caches and no read
can ever follow another member's write", sourced to the official packages'
READMEs. That is the audit citing **our own reading of a package README**, and the
question in the brief is whether a vendor *documents* subprocess cache behaviour.

### 4.1 What Anthropic documents about sharing

> "Caches are isolated per workspace on the Claude API, Claude Platform on AWS,
> and Microsoft Foundry (per organization on Amazon Bedrock and Google Cloud),
> and **never shared across organizations**. Traffic for the same prompt split
> across workspaces writes and reads separate entries — check this before blaming
> a low hit rate on the prompt."
> — [prompt-caching.md, anthropics/skills](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/prompt-caching.md)

This is isolation **by account/workspace**, not by process. It establishes that
two *different customers* never share; it says nothing about two processes
belonging to the *same* customer.

And on the subagent case specifically, the same Anthropic document gives the
opposite of "independent" as its advice:

> "**Fork operations must reuse the parent's exact prefix.** Side computations
> (summarization, compaction, sub-agents) often spin up a separate API call. If
> the fork rebuilds `system` / `tools` / `model` with any difference, it misses
> the parent's cache entirely. Copy the parent's `system`, `tools`, and `model`
> verbatim, then append fork-specific content at the end."

And the multi-agent paragraph quoted in §1.5:

> "N parallel workers each assembling a slightly different prompt over the same
> context write N separate cache entries and read none of each other's."

**This is the decisive answer, and it contradicts the audit's framing.** Anthropic
documents that a sub-agent **can and should** share the parent's cache — the cache
is keyed on `system` / `tools` / `model` bytes and the account, **not on the
process or PID**. A Claude Code (or any) subprocess that emits a byte-identical
`system`+`tools` prefix on the same account **will hit the parent's cache entry**.

So "cross-provider cache sharing is impossible" is **CONFIRMED** (different
vendors are different accounts and different model-scoped caches — Anthropic's
"caches are model-scoped", OpenAI's "A different model can use different weights
and caching behavior"), but the audit's stronger, load-bearing claim that a
*child process* cannot share with its parent or siblings is **CORRECTED /
not supported**. Within one vendor, same account, same model, byte-identical
prefix: sharing works, and the vendor recommends designing for it.

### 4.2 What OpenAI documents about sharing

> "Cached states live on individual machines, where traffic above 15 requests per
> minute can lead to overflow routing. A request can reuse a cached prefix only if
> it reaches a machine holding a matching entry that has not expired."

> "Caches are not shared across organizations and cannot be reused across regional
> processing boundaries."

Same conclusion: isolation is by **organization / region / machine / model**, not
by client process. A subprocess is just another client with the same org and
region, so it competes for the same cache entries — and the audit's `prompt_cache_key`
guidance ("Keep related requests on the same `prompt_cache_key` so they can reuse
its cache") is precisely a mechanism for making *separate processes* share.

### 4.3 What this does to the audit's conclusion

| Audit claim | Verdict |
|---|---|
| Cross-**vendor** sharing impossible (4 vendors ⇒ 4 caches) | **CONFIRMED.** |
| Parent ↔ Claude Code subprocess cannot share | **CORRECTED.** Vendor documents the opposite and instructs forks to reuse the parent prefix byte-for-byte. |
| Sibling subprocesses cannot share with each other | **CORRECTED** for same-vendor/same-model/same-account. They can, and for OpenAI require deliberate `prompt_cache_key`/routing cooperation plus serialisation (§1.5). |

**Practical consequence for the audit's numbers: none, on the default config.**
The default roundtable spans claude/codex/opencode/zcode — four vendors, so no read
can follow another member's write regardless. §1.3(b)'s "Fix C is worth 0.0% on
the default configuration" survives **unchanged**.

But the *reasoning* is wrong in a way that matters for the fixes the audit
proposes. The audit says cache sharing between our dispatches and the same
vendor's other work is impossible; the vendors say it is possible and recommend
it. That makes the "already warm" row (§1.3, 112,520) more plausible than the
audit's own conservative model computes — in fact a genuinely warm prefix should
cost 0.1×, not 1.0× (see §3.5), so the ceiling is **understated**, not overstated.

---

## 5. Debate / N-version literature: what the evidence supports

The audit asserts (§5, line ~299 table and surrounding prose) that cross-provider
debate may be "mostly redundancy". I found three primary sources. **Two of them
contradict that framing, in the specific dimension the audit's roundtable
actually implements** (different models, multiple rounds).

### 5.1 Du et al. 2023 — the paper the audit cites

[Improving Factuality and Reasoning in Language Models through Multiagent Debate](https://arxiv.org/abs/2305.14325)
(Du, Li, Torralba, Tenenbaum, Mordatch; arXiv:2305.14325):

> "In this paper, we present a complementary approach to improve language
> responses where multiple language model instances propose and debate their
> individual responses and reasoning processes over multiple rounds to arrive at
> a common final answer. Our findings indicate that this approach significantly
> enhances mathematical and strategic reasoning across a number of tasks. We also
> demonstrate that our approach improves the factual validity of generated
> content, reducing fallacious answers and hallucinations that contemporary
> models are prone to."
>
> "Our approach may be directly applied to existing black-box models and uses
> identical procedure and prompts for all tasks we investigate."

**This supports debate, not redundancy** — and note the caveat the audit should
carry: Du et al.'s instances are copies of the **same** model, so their result is
evidence for *homogeneous* debate. It is the strongest citation for "debate
helps" and the audit does not lean on it.

### 5.2 Smit et al. 2023/2024 — "Should we be going MAD?"

[Should we be going MAD? A Look at Multi-Agent Debate Strategies for LLMs](https://arxiv.org/abs/2311.17371)
(Smit, Duckworth, Grinsztajn, Barrett, Pretorius; arXiv:2311.17371 v3):

> "We benchmark a range of debating and prompting strategies to explore the
> trade-offs between cost, time, and accuracy. Importantly, we find that
> multi-agent debating systems, in their current form, **do not reliably outperform
> other proposed prompting strategies, such as self-consistency and ensembling
> using multiple reasoning paths**. However, when performing hyperparameter
> tuning, several MAD systems, such as Multi-Persona, perform better. This
> suggests that MAD protocols might not be inherently worse than other
> approaches, but that they are more sensitive to different hyperparameter
> settings and difficult to optimize. ... adjusting agent agreement levels, which
> can significantly enhance performance and even surpass all other non-debate
> protocols we evaluated."

**This supports "debate is not automatically better than cheaper baselines"** —
the audit's *conclusion* that debate is expensive relative to its benefit is
supported. But note the precise claim: MAD **did not beat self-consistency**, and
**self-consistency needs one model, N samples**. That is a direct argument that
the cheapest path to diversification is sampling, not four vendors — which is a
stronger and better-sourced version of the audit's own point than the audit makes.

### 5.3 Zhang et al. 2025 — "Stop Overvaluing Multi-Agent Debate"

[Stop Overvaluing Multi-Agent Debate — We Must Rethink Evaluation and Embrace Model Heterogeneity](https://arxiv.org/abs/2502.08788)
(Zhang et al.; arXiv:2502.08788 v3):

> "This paper presents a systematic evaluation of 5 representative MAD methods
> across 9 benchmarks using 4 foundational models. Surprisingly, our findings
> reveal that MAD often fail to outperform simple single-agent baselines such as
> Chain-of-Thought and Self-Consistency, even when consuming significantly more
> inference-time computation. To advance MAD research, we further explore the
> role of model heterogeneity and find it as **a universal antidote to
> consistently improve current MAD frameworks**. Based on our findings, we argue
> that the field must stop overvaluing MAD in its current form ... and actively
> embrace **model heterogeneity** as a core design principle."

**This is the source that most directly contradicts the audit's "mostly
redundancy" framing.** The audit says cross-*provider* diversity adds little over
same-model sampling. The largest systematic study available says the opposite:
MAD on homogeneous models fails to beat trivial baselines, **and model
heterogeneity is the one intervention that consistently rescues it.**

### 5.4 What the evidence actually supports

| Question | Evidence | Verdict on the audit |
|---|---|---|
| Does debate beat a single answer? | Du 2023: yes. Smit 2023 & Zhang 2025: **not reliably**, often loses to self-consistency at much lower cost. | Audit's *skepticism about debate's value per dollar* is **SUPPORTED**. |
| Is multi-*model* debate "mostly redundancy"? | Zhang 2025: heterogeneity is "a universal antidote", consistently improving MAD. Du 2023's homogeneous result understates the heterogeneous case. | **NOT SUPPORTED — contradicted.** This is the audit's weakest external claim. |
| Is the per-round peer block worth its tokens? | Smit 2023: MAD is hypersensitive to hyperparameters (agreement level), and tuning flips the result. | **SUPPORTED** that debate is fragile/expensive; the audit's cost analysis is the right axis. |

**Plainly stated:** the audit's *conclusion* ("debate is an output-heavy operation
whose cost is not rescued by caching") is **well supported**. But its *aside* that
cross-provider debate "may be mostly redundancy" is **contradicted by the most
direct study of exactly that question** (Zhang et al. 2025). If the audit wants to
argue against cross-provider roundtables it should argue **cost/latency**, where
the evidence is on its side, and should not imply the diversity is worthless —
which is what a reader takes from "mostly redundancy".

Caveat on all three: none of them studies *coding-agent* delegation, which is
this plugin's use case. All three are closed-form QA/reasoning benchmarks. So the
transfer to "should four CLI coding agents debate a refactor" is **UNVERIFIED** in
both directions — which is itself an argument for the audit's cost caution, not
for its redundancy claim.
