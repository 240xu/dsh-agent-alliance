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

These are not arithmetic errors but they change the meaning of the headline:

1. **`PEER` is charged at 1.0× in the Fix A row but 1.25× in the trap row.** Both
   rows append the same 2,050-token suffix to a warm 12,800-token prefix, so a
   consistent model must charge it the same way. If the suffix is a cache write
   (the trap row's treatment), Fix A becomes 4 × (1,280 + 2,050 × 1.25) =
   15,370 instead of 13,320, i.e. **127,370 → −19.7%, not −21.0%**. The printed
   21.0% is the *optimistic* arm of an inconsistency. It is within ~1.3 points,
   so the conclusion survives, but the exact figure is not uniquely determined
   by the stated model.
2. **The "already warm" row (112,520) does not model a warm cache.** A warm
   prefix should be read at 0.1×, which would be ~66,440. 112,520 is exactly
   125,320 − 12,800, i.e. it removes only the *write premium* (1.25 → 1.0) and
   still charges full price for the prefix. The row is mislabelled; its own
   number is conservative, so the `−29.1%` "ceiling" is understated, not
   overstated.
3. **Fix B (125,800) is not reproducible** from the stated symbols by any
   interpretation tried (server-side resume implies round 2 sends only `PEER`,
   which gives 120,200). Marked **UNVERIFIED arithmetic**; it does not affect the
   Fix A verdict.
4. Both figures assume the vendor charges a **cache-write premium at all**. That
   is Anthropic's model; see §1, where OpenAI's is different. The whole `−21.0%`
   row is contingent on the §1 ratio findings.

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
