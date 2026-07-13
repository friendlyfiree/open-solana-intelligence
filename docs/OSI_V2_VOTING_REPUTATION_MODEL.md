# OSI V2 — Voting Power & Reputation Model

**Status:** Blueprint / design-only. Voting power is **bounded to [0.50, 3.00]** and can never let one analyst finalize a critical outcome alone (Constitution P3/P4).

---

## 1. Design goals

- Reward **quality-adjusted** contribution, not raw case count.
- Bounded weight ∈ [0.50, 3.00]; monotonic-ish but decaying and penalizable.
- Resist self-farming, quantity farming, sybil, mutual-voting rings, one-user dominance.
- Every critical outcome keeps a **minimum independent-analyst count** regardless of weight.

## 2. Two-gate rule (the core anti-dominance mechanism)

Any critical outcome (publish, reject-final, resolve, pack-approve, seal, challenge-accept) requires **BOTH**:

1. **Count gate:** `independent_approving_analysts ≥ N_min` (distinct **eligible verified analyst** wallets; **author/owner/creator/applicant/challenger excluded** from deciding their own item; de-collusioned). `N_min = 2` (standard), `3` (high-risk).
2. **Weight gate:** `Σ weight(approvers) ≥ W_thr` where `W_thr` scales with risk tier.

Because max weight is 3.00 and `N_min ≥ 2`, **no single analyst can satisfy the count gate.** Weight can accelerate consensus but never bypass the count gate. This is the mathematical guarantee behind P3.

**Maintainer weight rule (correction #6):** *maintainer status alone confers no voting weight.* A maintainer contributes to count/weight gates **only if the same wallet is separately analyst-eligible** (verified + approved), and then subject to every exclusion above. Case initial open has a separate role-authority path: a full double-gated maintainer may record `approve_open` at weight `0` and anchor `CASE_OPENED` without an analyst profile. This does not become an analyst vote or a truth/guilt decision. The maintainer *finalization* signature required for the three maintainer-gated outcomes (resolution/winner, AI-Pack approval, seal — D5) remains a distinct act. Ordinary connected wallets never contribute counted weight.

## 3. Contribution score (formula option)

Per analyst, maintain a **quality-adjusted contribution score** `Q` from the immutable `analyst_contributions` ledger:

```
Q = Σ_i  base(kind_i) · quality_i · independence_i · recency_i   −   Σ_j penalty_j
```

Where per contribution `i`:
- `base(kind)`: accepted_report=1.0, winning_report=2.0, resolved_case_review=1.0, challenge_survived=0.5, challenge_accepted(as challenger)=1.5, peer_agreement=0.25.
- `quality_i ∈ [0,1]`: reviewer-panel quality grade (median of independent analyst quality marks; never self).
- `independence_i ∈ [0,1]`: **anti-collusion multiplier** = `1 / (1 + overlap)`, where `overlap` = how often the same small set of wallets co-approved this analyst's items (ring detection). Self-created cases contribute `independence=0`.
- `recency_i = 0.5 + 0.5·exp(−age_days/180)`: recent quality counts more; old contributions decay toward half weight (never zero).
- `penalty_j`: reversal (an approved item this analyst approved was later overturned) = −1.5·quality; policy_violation = −3.0; bad-faith challenge = −1.0.

Then map to bounded weight with a saturating curve:

```
weight = clamp( 0.50 + 2.50 · ( 1 − exp(−Q / K) ), 0.50, 3.00 )
```

- `K` (softness constant) ≈ 8 → ~15 solid contributions approach the top of the band; diminishing returns prevent quantity farming.
- New/probationary analyst: `Q≈0 → weight=0.50`.
- Revoked: weight forced to 0 (excluded from gates entirely).

### 3.1 Inactivity decay
Apply on each snapshot: `Q ← Q · exp(−idle_days/365)`. An analyst inactive ~1 year drifts back toward 0.50 (floor), never below.

### 3.2 Snapshotting
Weight is recomputed into `analyst_reputation_snapshots` on a schedule and after each finalized contribution; the value used in any tally is the **snapshot at decision time** (stored on the typed review row's `weight` column — `case_report_reviews.weight`, `resolution_reviews.weight`, etc.) so historical tallies are immutable and auditable. **Voluntary support never contributes to `Q`, weight, or any tally (P7, correction #15).**

## 4. Tier model (simpler first-implementation option)

| Tier | Entry condition | Weight | Quorum eligibility |
|---|---|---|---|
| Probationary | promoted candidate | 0.50 | counts toward count gate, low weight |
| Analyst I | ≥3 accepted contributions, 0 reversals in last 5 | 1.00 | yes |
| Analyst II | ≥8 accepted, ≥1 winning, reversal-rate <10% | 1.50 | yes |
| Senior | ≥20 accepted, ≥3 winning, reversal-rate <5%, ≥90d tenure | 2.25 | yes, eligible for high-risk quorum |
| Distinguished | **server-derived** ≥40 accepted + ≥6 winning + reversal-rate <5% | 3.00 | yes |

Tiers are **server-derived from documented thresholds**, never granted by discretionary maintainer preference (correction #9). Maintainer/governance only confirms policy and abuse checks before a server-eligible promotion is applied.

Demotion: a reversal or policy violation drops one tier (min Probationary). Tiers are a discretized view of the formula; the count gate applies identically.

## 5. Thresholds by risk tier

| Outcome | risk tier | `N_min` (independent) | `W_thr` (weight sum) |
|---|---|---|---|
| Open case (initial approve) | any | analyst path: 1; full-maintainer path: 1 double-gated maintainer | analyst path: 0.50; full-maintainer path: 0 |
| Normal initial rejection | any | 2 | 2.00 |
| Publish report | standard | 2 | 2.00 |
| Publish report | high | 3 | 4.00 |
| Resolve / select winning | standard | 2 + maintainer | 2.50 |
| Resolve / select winning | high | 3 + maintainer | 4.50 |
| Approve AI Pack | any | 2 (creator excluded) + maintainer | 2.50 |
| Accept/reject challenge | any | 2 | 2.50 |
| Seal | any | 2 + maintainer | 2.50 |

These are the locked initial defaults (`OSI_V2_OPEN_DECISIONS.md` D5); exact numbers are tunable via `osi_config` (measurement detail) without schema change. **Safety/moderation blocking is NOT on this table** — it is a maintainer/server-policy action requiring no factual analyst quorum (State Machines §1); it must never be presented as a factual review outcome.

### 5.1 Maintainer-absence fallback (governance, DEFERRED behind `OSI_V2_FALLBACK_GOVERNANCE=false`)
Designed but **disabled in the first release** (D3). When enabled: replace "+ maintainer" with `N_min+1` independent analysts **and** `W_thr + 1.5` **and** a 72-hour waiting period with no active challenge. High-risk outcomes remain maintainer-required initially. **Analyst-lifecycle fallback** (future): candidate/probationary promotion by ≥3 eligible senior analysts + a weight threshold + a waiting/objection period + no active governance challenge + logged outcome; high-risk authority changes stay maintainer-required. **No analyst weight tier is awarded by discretionary maintainer preference — eligibility is server-derived from documented contribution thresholds; human governance only confirms policy/abuse checks (correction #9).**

## 6. Worked examples

Weight from formula (`K=8`), `Q` illustrative:

| Validated contributions | approx `Q` (quality~0.8, independent) | weight |
|---|---|---|
| 0 | 0 | **0.50** |
| 1 | ~0.7 | ~0.71 |
| 5 | ~3.4 | ~1.48 |
| 15 | ~9.2 | ~2.31 |
| 30 | ~16 | ~2.83 |
| 50 | ~24 | ~2.95 (→ cap 3.00) |

### Simulated case vote (standard publish, `N_min=2`, `W_thr=2.00`)
- Analysts approve: A(1.00), B(1.50). Count=2 ✅, ΣW=2.50 ≥2.00 ✅ → **quorum ready**, then maintainer finalizes → published.
- Single senior A(3.00) approves alone: Count=1 ❌ (fails count gate) → **not published** (proves P3).
- Ring case: A,B,C each 2.00 but `independence` collapses their effective co-approval; ring detection flags overlap → their contributions' `independence→low`, future weight erodes, and the anti-collusion multiplier can require an *additional* independent approver for that cluster.

### High-risk case (`N_min=3`, `W_thr=4.00`)
- A(1.5)+B(1.5)+C(1.0)=Count 3 ✅, ΣW 4.0 ✅ → ready. Two seniors (2.25+2.25=4.5) still fail count gate (only 2 wallets) → need a third.

## 7. Anti-gaming measures

| Threat | Mitigation |
|---|---|
| Self-created case farming | `independence=0` for self-authored/owned items; author excluded from own tallies |
| Quantity farming | saturating curve (diminishing `Q→weight`), quality multiplier median-of-independents |
| Sybil | probationary floor 0.50, verification gate (maintainer), count gate needs distinct verified wallets |
| Mutual-voting ring | overlap-based `independence` multiplier + ring detection that raises `N_min` for flagged clusters |
| One-user dominance | hard cap 3.00 + count gate `N_min≥2` |
| Reversal gaming | reversals apply retroactive penalty to approvers of overturned items |
| Inactivity squatting | decay toward floor |

## 8. Recommended first implementation

**Ship the tier model (§4) with the two-gate rule (§2) and per-review weight snapshots (§3.2).** It is transparent, easy to audit, and hard to game, while the full formula (§3) runs in shadow mode producing snapshots for comparison. Promote to the formula once real contribution data validates `K` and the independence/ring detection parameters. Both share the **same count gate and thresholds**, so switching later does not change the security guarantee — only the weight numbers.
