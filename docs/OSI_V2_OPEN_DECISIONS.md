# OSI V2 — Open Product-Owner Decisions

**Status:** Blueprint / design-only. These decisions are **not** made here. Each is irreversible-ish or policy-defining and must be chosen by the product owner before implementation. Recommendations are provided but not enacted.

Legend: **Sec** = security impact · **UX** = UX impact · **Impl** = implementation cost · **Mig** = migration impact.

---

### D1 — Case vs Wire classification for existing standalone approved reports
- **Question:** When migrating, does an approved standalone `report` become a **Case** (with itself as first report) or a **Wire Report**?
- **Options:** (a) all → Cases; (b) all → Wire Reports; (c) rule-based (has investigation `detail`/parent → Case; pure finding → Wire); (d) manual queue.
- **Sec:** low · **UX:** high (determines where records live) · **Impl:** medium · **Mig:** high.
- **Recommendation:** (c)+(d) — rule-based with a manual queue for ambiguous rows. Never auto-invent.

### D2 — Legacy bounty winner without a Report
- **Question:** `bounties.winner_wallet` may have no Report. How to represent a legacy winner as a V2 winning **Report**?
- **Options:** (a) synthetic report stub attributed to winner; (b) resolved-legacy Case with no V2 winning report; (c) leave in a compat view only.
- **Sec:** low · **UX:** medium · **Impl:** medium · **Mig:** high.
- **Recommendation:** (b) for display + (a) only if a reward payment must attach to a Report.

### D3 — Maintainer-absence fallback governance
- **Question:** Enable the stricter no-maintainer fallback (higher count/weight + waiting period) for finalization/seal?
- **Options:** (a) never (maintainer required); (b) enable with `N_min+1`, `W_thr+1.5`, 72h wait, no active challenge; (c) enable only for non-high-risk cases.
- **Sec:** high (removes a human gate) · **UX:** medium · **Impl:** high · **Mig:** low.
- **Recommendation:** (c) initially, behind `OSI_V2_FALLBACK_GOVERNANCE` flag, high-risk cases always need maintainer.

### D4 — Reputation model: tier vs formula first
- **Question:** Ship the tier model or the full formula first?
- **Sec:** medium · **UX:** medium · **Impl:** tier=small, formula=medium · **Mig:** low.
- **Recommendation:** tier model live + formula in shadow (per Voting Model §8). Same two-gate guarantee either way.

### D5 — Voting thresholds `N_min`/`W_thr`
- **Question:** Confirm standard (2 / 2.00) and high-risk (3 / 4.00) values, and which categories are "high-risk."
- **Sec:** high · **UX:** medium · **Impl:** small · **Mig:** low.
- **Recommendation:** adopt defaults; classify impersonation/large-fund-movement/entity-attribution as high-risk.

### D6 — Owner status read path
- **Question:** How do owners read their private Cases/Reports — signature-proof Edge endpoint, or a scoped own-wallet RLS SELECT?
- **Sec:** high · **UX:** high · **Impl:** medium · **Mig:** low.
- **Recommendation:** signature-proof Edge endpoint (no broad RLS SELECT on pending rows; consistent with current Stage-2A posture).

### D7 — AI Pack confidence headline
- **Question:** Show only the component **profile**, or also a single "Review Signal" number?
- **Sec:** medium (single numbers get misread as accuracy) · **UX:** high · **Impl:** small.
- **Recommendation:** profile only; if a number is required, use the count-gated *minimum* labeled "Review Signal," never "accuracy."

### D8 — Case owner AI Pack attestation
- **Question:** May a case owner attest their own pack at all (advisory/uncounted), or not attest?
- **Recommendation:** advisory + uncounted, clearly labeled; never contributes weight (Constitution §14).

### D9 — Retire `OSI_CASE_BACKED` "boost/back" feature
- **Question:** Keep case "backing/boost" (a demand-signal memo that leaks `subject` text) or retire it?
- **Sec:** medium (memo narrative leak) · **UX:** low.
- **Recommendation:** retire the narrative-bearing memo; if demand signaling is kept, make it a class-C receipt with no subject text.

### D10 — Wire ↔ Field Office boundary enforcement
- **Question:** Can a Wire Report host a reward if promoted, or only after becoming a Case?
- **Recommendation:** rewards only on Cases; promotion first (Constitution §20).

### D11 — Challenge eligibility
- **Question:** Any connected wallet may challenge, or only contributors/analysts?
- **Sec:** medium (spam) · **UX:** medium.
- **Recommendation:** any wallet + rate-limit + required evidence_ref + bad-faith penalty; keeps it open but abuse-resistant.

### D12 — Ancillary table retirement
- **Question:** Retire `requests`/`request_votes`/`bounty_boosts`/`profiles` or migrate?
- **Recommendation:** evaluate per-table; likely retire `bounty_boosts` (with D9), fold `profiles` into `analyst_profiles`, decide `requests` per product need.

### D13 — Reward payment attribution
- **Question:** Must a reward be tied to exactly one winning Report author, or split among contributors?
- **Recommendation:** single winner primary; optional supporting-contributor attribution is display-only (no auto-split) initially.

### D14 — Stage-5 replay/authenticity timing
- **Question:** Ship V2 grammar now with `n`/`h` placeholders and enforce later, or block V2 on Stage-5?
- **Recommendation:** ship grammar with placeholders; enforce in Stage-5 (grammar is already compatible).

---

**Rule:** none of the above is silently chosen in code. Each `→` a written product-owner sign-off before the corresponding implementation stage begins.
