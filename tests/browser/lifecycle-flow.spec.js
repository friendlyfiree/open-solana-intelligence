// End-to-end OSI lifecycle: file a Case, approve it, anchor the public open,
// submit a Report, reach analyst approve quorum, publish, and read the
// published finding as an anonymous visitor.
//
// The backend here is a state machine, not a table of canned responses. Every
// public projection is derived from the same mutable state the write ops
// change, so a lifecycle rule that the product gets wrong shows up as a wrong
// public page rather than as a fixture that quietly disagrees with itself.
// Nothing is injected into the DOM: each assertion is about markup the
// application rendered after a real click, key press or form submission.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const OWNER = '7wT9ZrM3B41GfZ9sA33fPTnRM23fZ9wP5VeFJvvzG5Ai';
const AUTHOR = '9xQeWvG816bUx9EPjHmaT23yvVM2ZHbZMULu5vDpAAAA';
const ANALYST_A = '2awpjumkqhWywwbmDBixjo7cAnqD5fGfNGNv6MMTc4M7';
const ANALYST_B = 'h82pJGF9p7kpzb6eU326EFZf2cDnimbTFVeJtx1qtBmU';
const CASE_REF = 'OSI-A1B2C3D4E5F6';
const REPORT_REF = 'OSI-RPT-1234567890AB';
const VERSION_REF = 'OSI-RV-1234567890ABCDEF';
const OPEN_TX = 'YFbEg7G5tC5DjPTqKkGeEjeBb2QpqNysjexUuKVUz9KSwxp6iALjaS6b4SnHRZjMSNR874Z5eGSpCRTkJVdRS2H';
const PUBLISH_TX = 'DR4znTjFxyRZVJGCXgMbyPADWp8U3oSQSHCTiKxWHSaTj58c92TACh7gBcpuVpqruCYrSk8An86SFixPe5YpyAV';

// A restricted narrative sentinel. If it ever reaches an anonymous surface the
// privacy boundary has failed, whatever else the page got right.
const PRIVATE_SENTINEL = 'RESTRICTED_NARRATIVE_SENTINEL';
const NARRATIVE = `${PRIVATE_SENTINEL} The restricted narrative traces the transfer path across intermediate wallets, records the limits of the attribution, and states the residual uncertainty in full detail for reviewers only.`;
const SUMMARY_P1 = 'Funds left the reported wallet in three transfers and consolidated into a single intermediate address within twenty minutes.';
const SUMMARY_P2 = 'The consolidation address has no public attribution. This Report records a transfer path only and makes no claim about who controls it.';
const PUBLIC_SUMMARY = `${SUMMARY_P1}\n\n${SUMMARY_P2}`;

const REQUIRED_COUNT = 2;
const REQUIRED_WEIGHT = 2;
const ANALYST_WEIGHT = { [ANALYST_A]: 1, [ANALYST_B]: 1 };

// ---------------------------------------------------------------------------
// Lifecycle state machine
// ---------------------------------------------------------------------------

// The read-session client decodes the token it is handed and refuses one whose
// subject or audience does not match, so the fixture has to mint a real
// JWT-shaped token rather than an opaque string.
function sessionToken(origin, wallet) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    v: 1, iss: 'osi-v2-case-read', aud: origin, sub: wallet,
    iat: issuedAt, exp: Math.floor(Date.now() / 1000) + 1800,
    sid_iat: issuedAt, abs_exp: issuedAt + 28800,
    jti: 'lifecycle-fixture-session-000000000001',
    scp: ['case:mine', 'case:detail', 'case:review', 'case:maintainer', 'report:mine', 'report:review', 'wire:mine', 'wire:queue', 'analyst:workspace', 'aipack:detail'],
    auth_sub: null,
  })}.fixture-signature`;
}

// The canonical OSI2 envelope. The browser re-validates a pending publication
// Memo against this exact shape before it will keep a recovery record, so the
// fixture has to produce the real thing rather than a placeholder.
function outcomeMemo(purpose, decision, versionRef, wallet, nonce, expiresAt) {
  return [
    'OSI2', '1', purpose, 't=report_version', `id=${versionRef}`,
    `a=${wallet}`, 'r=analyst', `d=${decision}`, `n=${nonce}`, `h=${'d'.repeat(64)}`,
    `ts=${expiresAt - 240}`, `exp=${expiresAt}`,
  ].join('|');
}
function publicationMemo(versionRef, wallet, nonce, expiresAt) {
  return outcomeMemo('REPORT_PUBLISHED', 'publish', versionRef, wallet, nonce, expiresAt);
}

function createBackend() {
  const state = {
    cases: [],
    reports: [],
    receipts: [],
    calls: [],
    nonce: 0,
  };

  const nextNonce = (prefix) => `${prefix}-nonce-${++state.nonce}`;
  const findCase = (ref) => state.cases.find((row) => row.public_ref === ref) || null;
  const findVersion = (ref) => {
    for (const report of state.reports) {
      const version = report.versions.find((row) => row.version_ref === ref);
      if (version) return { report, version };
    }
    return null;
  };

  function quorumFor(version) {
    const counted = (decision) => version.reviews.filter((row) => row.is_active && row.decision === decision);
    const weigh = (rows) => rows.reduce((sum, row) => sum + Number(row.weight || 0), 0);
    const approvals = counted('approve');
    const rejections = counted('reject');
    const approveWeight = weigh(approvals);
    const rejectWeight = weigh(rejections);
    return {
      risk_tier: 'standard',
      approve_count: approvals.length,
      approve_weight: approveWeight,
      reject_count: rejections.length,
      reject_weight: rejectWeight,
      required_count: REQUIRED_COUNT,
      required_weight: REQUIRED_WEIGHT,
      approve_ready: approvals.length >= REQUIRED_COUNT && approveWeight >= REQUIRED_WEIGHT,
      reject_ready: rejections.length >= REQUIRED_COUNT && rejectWeight >= REQUIRED_WEIGHT,
    };
  }

  // Mirrors osi_v2_report_publication_capabilities: an analyst may publish only
  // once quorum is ready AND their own active review is an approve.
  function capabilityFor(version, wallet) {
    const quorum = quorumFor(version);
    const eligible = Object.prototype.hasOwnProperty.call(ANALYST_WEIGHT, wallet);
    const mine = version.reviews.find((row) => row.is_active && row.reviewer_wallet === wallet);
    const awaiting = ['submitted', 'in_review'].includes(version.lifecycle_state);
    const canReview = eligible && awaiting;
    const hasApprove = !!mine && mine.decision === 'approve';
    const canPublish = canReview && quorum.approve_ready && hasApprove;
    return {
      can_cast_analyst_review: canReview,
      analyst_review_reason_code: canReview ? null : 'analyst_not_eligible',
      can_publish_via_standard_quorum: canPublish,
      standard_publication_reason_code: canPublish
        ? null
        : !quorum.approve_ready ? 'analyst_quorum_not_ready' : 'active_approve_review_required',
      can_publish_via_maintainer_bootstrap: false,
      maintainer_bootstrap_reason_code: 'maintainer_double_gate_required',
      decision_channel: canPublish ? 'standard' : null,
      standard_quorum_ready: quorum.approve_ready,
      approve_count: quorum.approve_count,
      approve_weight: quorum.approve_weight,
      reject_count: quorum.reject_count,
      reject_weight: quorum.reject_weight,
      required_count: REQUIRED_COUNT,
      required_weight: REQUIRED_WEIGHT,
      risk_tier: 'standard',
      sas_enforcement_enabled: false,
      bootstrap: { enabled: false, active: false, tier: 'unavailable' },
    };
  }

  function caseReceipts(ref) {
    return state.receipts.filter((row) => row.case_public_ref === ref).map((row) => ({
      label: 'Memo-anchored on Solana',
      event_type: row.event_type,
      public_ref: row.public_ref,
      actor_wallet: row.actor_wallet,
      actor_role: row.actor_role,
      decision: row.decision,
      weight: null,
      occurred_at: row.occurred_at,
      decision_channel: row.decision_channel || 'standard',
      decision_channel_label: null,
      tx_sig: row.tx_sig,
      solscan_url: `https://solscan.io/tx/${row.tx_sig}`,
    }));
  }

  // The anonymous Case projection. A published version contributes its
  // public-safe summary; a restricted body never appears in any branch.
  function publicCaseDto(row) {
    const published = state.reports
      .filter((report) => report.case_public_ref === row.public_ref)
      .map((report) => {
        const version = report.versions.find((item) => item.version_ref === report.current_published_version_ref);
        if (!version) return null;
        return {
          public_ref: report.public_ref,
          status: report.status,
          current_version: {
            version_ref: version.version_ref,
            version_no: version.version_no,
            lifecycle_state: 'published',
            published_at: version.published_at,
          },
          content_public_safe: version.content_public_safe,
          published: true,
        };
      })
      .filter(Boolean);
    return {
      public_ref: row.public_ref,
      title: row.title,
      summary: row.summary,
      category: row.category,
      stage: row.stage,
      visibility: row.visibility,
      risk_tier: 'standard',
      created_at: row.created_at,
      sealed_at: null,
      evidence: [],
      reviews: row.reviews.filter((review) => review.is_active).map((review) => ({
        reviewer_wallet: review.reviewer_wallet,
        decision: review.decision,
        reviewer_role: review.reviewer_role,
        weight: review.weight,
        is_active: true,
        created_at: review.created_at,
        reason_code: review.reason_code,
        proof_label: 'Wallet-signed and server-verified',
        sas_authority: null,
      })),
      reports: published,
      governance: { resolution: null, challenges: [], process_notice: 'Primary Report selection and process sealing record reviewed, challengeable outcomes.' },
      money: { reward: null, support_options: [], confirmed_support: [], notice: 'Rewards and support are voluntary direct wallet-to-wallet SOL transfers.' },
      proof_log: caseReceipts(row.public_ref),
    };
  }

  function publicReportDto(report) {
    const version = report.versions.find((row) => row.version_ref === report.current_published_version_ref);
    if (!version) return null;
    const receipt = state.receipts.find((row) => row.public_ref === version.version_ref && row.event_type === 'REPORT_PUBLISHED');
    return {
      report_public_ref: report.public_ref,
      version_public_ref: version.version_ref,
      version_no: version.version_no,
      state: 'published',
      content_public_safe: version.content_public_safe,
      evidence: [],
      quorum: quorumFor(version),
      review_timeline: version.reviews.filter((row) => row.is_active).map((row) => ({
        review_public_ref: `OSI-RR-${row.reviewer_wallet.slice(0, 12)}`,
        reviewer_wallet: row.reviewer_wallet,
        reviewer_handle: null,
        decision: row.decision,
        weight: row.weight,
        public_rationale: row.public_rationale,
        created_at: row.created_at,
        proof_label: 'Wallet-signed and server-verified',
        sas_authority: null,
      })),
      publication_proof: receipt ? {
        event_type: 'REPORT_PUBLISHED',
        actor_wallet: receipt.actor_wallet,
        actor_role: receipt.actor_role,
        proof_type: 'solana_memo',
        server_verified: true,
        tx_sig: receipt.tx_sig,
        occurred_at: receipt.occurred_at,
        decision_channel: 'standard',
        decision_channel_label: null,
      } : null,
      published_at: version.published_at,
      process_notice: 'Publication records a reviewed OSI process outcome. It is not proof of truth, guilt, legal certainty, recovery, custody, or guaranteed payment.',
    };
  }

  function authorizedReportDto(report, wallet, access) {
    const current = report.versions[report.versions.length - 1];
    const capability = capabilityFor(current, wallet);
    return {
      case_public_ref: report.case_public_ref,
      report_public_ref: report.public_ref,
      author_wallet: report.author_wallet,
      status: report.status,
      current_version_ref: current.version_ref,
      current_version_no: current.version_no,
      current_published_version_ref: report.current_published_version_ref,
      access,
      revision_eligible: access === 'author',
      review_mutations_enabled: capability.can_cast_analyst_review,
      can_cast_analyst_review: capability.can_cast_analyst_review,
      can_publish_via_standard_quorum: capability.can_publish_via_standard_quorum,
      can_publish_via_maintainer_bootstrap: false,
      publication_capability: capability,
      versions: report.versions.map((version) => ({
        version_ref: version.version_ref,
        version_no: version.version_no,
        lifecycle_state: version.lifecycle_state,
        // The restricted body is part of an authorized projection only.
        body_private: access === 'author' || access === 'analyst' ? version.body_private : null,
        content_public_safe: version.content_public_safe,
        evidence_snapshot_hash: 'a'.repeat(64),
        revision_reason_code: null,
        supersedes_version_ref: null,
        submitted_at: version.created_at,
        evidence: [],
        proof: { proof_type: 'solana_memo', occurred_at: version.created_at, tx_sig: version.tx_sig, server_verified: true },
        reviews: version.reviews.map((row) => ({
          review_public_ref: `OSI-RR-${row.reviewer_wallet.slice(0, 12)}`,
          reviewer_wallet: row.reviewer_wallet,
          reviewer_handle: null,
          decision: row.decision,
          weight: row.weight,
          reason_code: row.reason_code,
          public_rationale: row.public_rationale,
          private_note: null,
          tier_snapshot: 'verified',
          is_active: row.is_active,
          created_at: row.created_at,
          proof: { proof_type: 'wallet_signed_server_verified' },
          sas_authority: null,
        })),
        quorum: quorumFor(version),
        publication_capability: capabilityFor(version, wallet),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Seeding helpers, so a test can start at the leg it is about.
  // -------------------------------------------------------------------------

  const api = {
    state,
    seedPrivateCase() {
      state.cases.push({
        public_ref: CASE_REF,
        title: 'Unexpected transfer pattern for review',
        summary: 'A neutral, public-safe description of the reported transfer pattern for independent review.',
        category: 'wallet_drain',
        stage: 'initial_review',
        visibility: 'private',
        submitted_by_wallet: OWNER,
        created_at: '2026-07-20T10:00:00+00:00',
        reviews: [],
      });
      return api;
    },
    seedApprovedCase() {
      api.seedPrivateCase();
      const row = findCase(CASE_REF);
      row.reviews.push({
        reviewer_wallet: ANALYST_A, decision: 'approve_open', reviewer_role: 'analyst',
        weight: 1, is_active: true, created_at: '2026-07-21T09:00:00+00:00',
        reason_code: 'public_scope_clear',
      });
      row.stage = 'open_public';
      row.visibility = 'public';
      state.receipts.push({
        case_public_ref: CASE_REF, public_ref: CASE_REF, event_type: 'CASE_OPENED',
        actor_wallet: ANALYST_A, actor_role: 'analyst', decision: 'open',
        occurred_at: '2026-07-21T09:05:00+00:00', tx_sig: OPEN_TX,
      });
      return api;
    },
    seedSubmittedReport() {
      api.seedApprovedCase();
      state.reports.push({
        public_ref: REPORT_REF,
        case_public_ref: CASE_REF,
        author_wallet: AUTHOR,
        status: 'active',
        current_published_version_ref: null,
        versions: [{
          version_ref: VERSION_REF,
          version_no: 1,
          lifecycle_state: 'submitted',
          body_private: NARRATIVE,
          content_public_safe: PUBLIC_SUMMARY,
          created_at: '2026-07-22T11:00:00+00:00',
          tx_sig: OPEN_TX,
          published_at: null,
          reviews: [],
        }],
      });
      return api;
    },
    seedApprovedReport(count = REQUIRED_COUNT) {
      api.seedSubmittedReport();
      const { version } = findVersion(VERSION_REF);
      const wallets = [ANALYST_A, ANALYST_B].slice(0, count);
      wallets.forEach((wallet, index) => {
        version.reviews.push({
          reviewer_wallet: wallet, decision: 'approve', weight: ANALYST_WEIGHT[wallet],
          reason_code: 'evidence_reviewed', is_active: true,
          public_rationale: 'The exact report version and its evidence were reviewed.',
          created_at: `2026-07-23T1${index}:00:00+00:00`,
        });
      });
      version.lifecycle_state = 'in_review';
      return api;
    },
    seedSealedCase() {
      api.seedPublishedReport();
      const row = findCase(CASE_REF);
      row.stage = 'sealed';
      return api;
    },
    seedRejectQuorum() {
      api.seedSubmittedReport();
      const { version } = findVersion(VERSION_REF);
      [ANALYST_A, ANALYST_B].forEach((wallet, index) => {
        version.reviews.push({
          reviewer_wallet: wallet, decision: 'reject', weight: ANALYST_WEIGHT[wallet],
          reason_code: 'evidence_insufficient', is_active: true,
          public_rationale: 'The evidence in this exact version does not support its stated conclusion.',
          created_at: `2026-07-23T1${index}:00:00+00:00`,
        });
      });
      version.lifecycle_state = 'in_review';
      return api;
    },
    seedPublishedReport() {
      api.seedApprovedReport();
      const { report, version } = findVersion(VERSION_REF);
      version.lifecycle_state = 'published';
      version.published_at = '2026-07-24T08:00:00+00:00';
      report.current_published_version_ref = VERSION_REF;
      state.receipts.push({
        case_public_ref: CASE_REF, public_ref: VERSION_REF, event_type: 'REPORT_PUBLISHED',
        actor_wallet: ANALYST_B, actor_role: 'analyst', decision: 'publish',
        occurred_at: '2026-07-24T08:00:00+00:00', tx_sig: PUBLISH_TX,
      });
      return api;
    },
  };

  // -------------------------------------------------------------------------
  // Request dispatch
  // -------------------------------------------------------------------------

  api.handle = function handle(endpoint, body, origin) {
    const op = String(body.op || '');
    const wallet = String(body.wallet || '');
    state.calls.push(`${endpoint}:${op}`);

    if (endpoint === 'osi-v2-case-read') {
      if (op === 'list_public_cases') {
        return { status: 200, payload: { ok: true, cases: state.cases.filter((row) => row.visibility === 'public').map(publicCaseDto) } };
      }
      if (op === 'get_public_case') {
        const row = findCase(String(body.public_ref || ''));
        if (!row || row.visibility !== 'public') return { status: 404, payload: { ok: false, error: 'not_found_or_private' } };
        return { status: 200, payload: { ok: true, case: publicCaseDto(row) } };
      }
      if (op === 'issue_read_session_challenge') {
        return { status: 200, payload: { ok: true, challenge: `osi-read-session:${nextNonce('sess')}`, expires_at: Math.floor(Date.now() / 1000) + 600 } };
      }
      if (op === 'create_read_session' || op === 'renew_read_session') {
        return { status: 200, payload: { ok: true, read_session: sessionToken(origin, wallet), expires_at: Math.floor(Date.now() / 1000) + 1800 } };
      }
      if (op === 'list_my_cases') {
        return { status: 200, payload: { ok: true, cases: state.cases.filter((row) => row.submitted_by_wallet === wallet).map(publicCaseDto) } };
      }
      if (op === 'list_reviewable_cases') {
        return { status: 200, payload: { ok: true, cases: state.cases.filter((row) => row.visibility === 'private' && row.submitted_by_wallet !== wallet).map(publicCaseDto) } };
      }
      return { status: 400, payload: { ok: false, error: 'bad_op' } };
    }

    if (endpoint === 'osi-v2-case-write') {
      if (op === 'actor_capabilities') {
        const analyst = Object.prototype.hasOwnProperty.call(ANALYST_WEIGHT, wallet);
        return { status: 200, payload: { ok: true, case_writes_enabled: true, analyst_eligible: analyst, maintainer_access: false, resolution_lifecycle_writes_enabled: false, ai_pack_access_mode: 'maintainer_only' } };
      }
      if (op === 'prepare_case') {
        return { status: 200, payload: { ok: true, nonce: nextNonce('case'), memo: 'OSI2|CASE_SUBMITTED|v1', expires_at: Math.floor(Date.now() / 1000) + 600 } };
      }
      if (op === 'commit_case') {
        const row = {
          public_ref: CASE_REF,
          title: String(body.case?.title || 'Filed Case'),
          summary: String(body.case?.summary_public || body.case?.summary || ''),
          category: String(body.case?.category || 'other'),
          stage: 'initial_review',
          visibility: 'private',
          submitted_by_wallet: wallet,
          created_at: new Date().toISOString(),
          reviews: [],
        };
        state.cases.push(row);
        state.receipts.push({
          case_public_ref: CASE_REF, public_ref: CASE_REF, event_type: 'CASE_SUBMITTED',
          actor_wallet: wallet, actor_role: 'wallet', decision: 'submit',
          occurred_at: row.created_at, tx_sig: OPEN_TX,
        });
        return { status: 200, payload: { ok: true, case: { public_ref: CASE_REF, stage: 'initial_review', visibility: 'private' } } };
      }
      if (op === 'prepare_review') {
        return { status: 200, payload: { ok: true, nonce: nextNonce('review'), message: `OSI2|CASE_REVIEWED|${body.review?.case_ref}` } };
      }
      if (op === 'commit_review') {
        const row = findCase(String(body.review?.case_ref || ''));
        if (!row) return { status: 404, payload: { ok: false, error: 'case_not_available' } };
        row.reviews.push({
          reviewer_wallet: wallet, decision: String(body.review?.decision || 'approve_open'),
          reviewer_role: body.route === 'maintainer' ? 'maintainer' : 'analyst',
          weight: body.route === 'maintainer' ? 0 : (ANALYST_WEIGHT[wallet] || 1),
          is_active: true, created_at: new Date().toISOString(),
          reason_code: String(body.review?.reason_code || 'public_scope_clear'),
        });
        const approved = row.reviews.some((review) => review.is_active && review.decision === 'approve_open' && review.reviewer_wallet === wallet);
        return { status: 200, payload: { ok: true, actor_open_ready: approved } };
      }
      if (op === 'prepare_open') {
        return { status: 200, payload: { ok: true, nonce: nextNonce('open'), memo: 'OSI2|CASE_OPENED|v1', expires_at: Math.floor(Date.now() / 1000) + 600 } };
      }
      if (op === 'commit_open') {
        const row = findCase(String(body.case_ref || ''));
        if (!row) return { status: 404, payload: { ok: false, error: 'case_not_available' } };
        row.visibility = 'public';
        row.stage = 'open_public';
        state.receipts.push({
          case_public_ref: row.public_ref, public_ref: row.public_ref, event_type: 'CASE_OPENED',
          actor_wallet: wallet, actor_role: 'analyst', decision: 'open',
          occurred_at: new Date().toISOString(), tx_sig: OPEN_TX,
        });
        return { status: 200, payload: { ok: true, case: { public_ref: row.public_ref } } };
      }
      return { status: 400, payload: { ok: false, error: 'bad_op' } };
    }

    if (endpoint === 'osi-v2-report-read') {
      if (op === 'list_public_reports') {
        const row = findCase(String(body.case_ref || ''));
        if (!row || row.visibility !== 'public') return { status: 404, payload: { ok: false, error: 'case_not_available' } };
        const reports = state.reports
          .filter((report) => report.case_public_ref === row.public_ref && report.current_published_version_ref)
          .map(publicReportDto)
          .filter(Boolean);
        return { status: 200, payload: { ok: true, case_public_ref: row.public_ref, reports } };
      }
      if (op === 'list_my_reports') {
        const reports = state.reports.filter((report) => report.author_wallet === wallet)
          .map((report) => authorizedReportDto(report, wallet, 'author'));
        return { status: 200, payload: { ok: true, actor_role: 'author', reports } };
      }
      if (op === 'list_review_queue') {
        const reports = state.reports
          .filter((report) => report.author_wallet !== wallet)
          .filter((report) => ['submitted', 'in_review'].includes(report.versions[report.versions.length - 1].lifecycle_state))
          .map((report) => authorizedReportDto(report, wallet, 'analyst'));
        return {
          status: 200,
          payload: {
            ok: true, actor_role: 'analyst', actor_roles: ['analyst'], queue_state: 'awaiting_review',
            review_mutations_enabled: reports.some((report) => report.can_cast_analyst_review),
            can_cast_analyst_review: reports.some((report) => report.can_cast_analyst_review),
            can_publish_via_standard_quorum: reports.some((report) => report.can_publish_via_standard_quorum),
            can_publish_via_maintainer_bootstrap: false,
            next_prerequisite: null,
            reports,
          },
        };
      }
      return { status: 400, payload: { ok: false, error: 'bad_op' } };
    }

    if (endpoint === 'osi-v2-report-write') {
      if (op === 'capabilities') {
        const row = findCase(String(body.case_ref || ''));
        return {
          status: 200,
          payload: {
            ok: true,
            report_writes_enabled: true,
            case_eligible: !!row && row.visibility === 'public',
            prerequisite: 'Submit an exact private Report version with a confirmed mainnet Memo.',
          },
        };
      }
      if (op === 'prepare_report') {
        return {
          status: 200,
          payload: {
            ok: true, already_committed: false,
            case_public_ref: String(body.case_ref || ''),
            report_public_ref: REPORT_REF, version_public_ref: VERSION_REF, version_no: 1,
            evidence_manifest_hash: 'b'.repeat(64), nonce: nextNonce('report'),
            payload_hash: 'c'.repeat(64), memo: 'OSI2|CASE_REPORT_VERSION_SUBMITTED|v1',
            expires_at: Math.floor(Date.now() / 1000) + 600, idempotent_replay: false,
          },
        };
      }
      if (op === 'commit_report') {
        state.reports.push({
          public_ref: REPORT_REF,
          case_public_ref: CASE_REF,
          author_wallet: wallet,
          status: 'active',
          current_published_version_ref: null,
          versions: [{
            version_ref: VERSION_REF, version_no: 1, lifecycle_state: 'submitted',
            body_private: String(body.report?.body_private || ''),
            content_public_safe: body.report?.content_public_safe || null,
            created_at: new Date().toISOString(), tx_sig: OPEN_TX, published_at: null, reviews: [],
          }],
        });
        return {
          status: 200,
          payload: {
            ok: true, case_public_ref: CASE_REF, report_public_ref: REPORT_REF,
            version_public_ref: VERSION_REF, version_no: 1, lifecycle_state: 'submitted',
          },
        };
      }
      if (op === 'prepare_review') {
        return { status: 200, payload: { ok: true, nonce: nextNonce('rreview'), message: `OSI2|CASE_REPORT_REVIEW_CAST|${body.review?.version_public_ref}` } };
      }
      if (op === 'commit_review') {
        const found = findVersion(String(body.review?.version_public_ref || ''));
        if (!found) return { status: 404, payload: { ok: false, error: 'report_version_not_available' } };
        found.version.reviews = found.version.reviews.filter((row) => row.reviewer_wallet !== wallet);
        found.version.reviews.push({
          reviewer_wallet: wallet, decision: String(body.review?.decision || 'approve'),
          weight: ANALYST_WEIGHT[wallet] || 1, reason_code: String(body.review?.reason_code || 'evidence_reviewed'),
          public_rationale: String(body.review?.public_rationale || ''), is_active: true,
          created_at: new Date().toISOString(),
        });
        found.version.lifecycle_state = 'in_review';
        return { status: 200, payload: { ok: true, decision: String(body.review?.decision || 'approve'), quorum: quorumFor(found.version) } };
      }
      if (op === 'list_publication_recovery') {
        return { status: 200, payload: { ok: true, candidates: [] } };
      }
      if (op === 'prepare_rejection') {
        const found = findVersion(String(body.version_public_ref || ''));
        if (!found) return { status: 404, payload: { ok: false, error: 'report_version_not_available' } };
        const q = quorumFor(found.version);
        if (!q.reject_ready || q.approve_ready) {
          return { status: 409, payload: { ok: false, error: 'analyst_quorum_not_ready' } };
        }
        const nonce = `${nextNonce('reject')}-${'r'.repeat(25)}`;
        const expires = Math.floor(Date.now() / 1000) + 240;
        return {
          status: 200,
          payload: {
            ok: true, already_committed: false, nonce,
            memo: outcomeMemo('REPORT_REJECTED', 'reject', found.version.version_ref, wallet, nonce, expires),
            expires_at: expires,
          },
        };
      }
      if (op === 'commit_rejection') {
        const found = findVersion(String(body.version_public_ref || ''));
        if (!found) return { status: 404, payload: { ok: false, error: 'report_version_not_available' } };
        const q = quorumFor(found.version);
        // The server refuses whatever the browser believes.
        if (!q.reject_ready || q.approve_ready) {
          return { status: 409, payload: { ok: false, error: 'analyst_quorum_not_ready' } };
        }
        found.version.lifecycle_state = 'rejected';
        state.receipts.push({
          case_public_ref: found.report.case_public_ref, public_ref: found.version.version_ref,
          event_type: 'REPORT_REJECTED', actor_wallet: wallet, actor_role: 'analyst',
          decision: 'reject', occurred_at: new Date().toISOString(), tx_sig: PUBLISH_TX,
        });
        return {
          status: 200,
          payload: { ok: true, version_public_ref: found.version.version_ref, decision_channel: 'standard', lifecycle_state: 'rejected' },
        };
      }
      if (op === 'prepare_publication') {
        const found = findVersion(String(body.version_public_ref || ''));
        if (!found) return { status: 404, payload: { ok: false, error: 'report_version_not_available' } };
        if (!quorumFor(found.version).approve_ready) {
          return { status: 409, payload: { ok: false, error: 'analyst_quorum_not_ready' } };
        }
        const nonce = `${nextNonce('publish')}-${'p'.repeat(24)}`;
        const expires = Math.floor(Date.now() / 1000) + 240;
        return {
          status: 200,
          payload: {
            ok: true, already_committed: false, nonce,
            memo: publicationMemo(found.version.version_ref, wallet, nonce, expires),
            expires_at: expires,
          },
        };
      }
      if (op === 'commit_publication') {
        const found = findVersion(String(body.version_public_ref || ''));
        if (!found) return { status: 404, payload: { ok: false, error: 'report_version_not_available' } };
        // The server refuses to publish a version whose quorum is not ready,
        // whatever the browser believes.
        if (!quorumFor(found.version).approve_ready) {
          return { status: 409, payload: { ok: false, error: 'analyst_quorum_not_ready' } };
        }
        found.version.lifecycle_state = 'published';
        found.version.published_at = new Date().toISOString();
        found.report.current_published_version_ref = found.version.version_ref;
        state.receipts.push({
          case_public_ref: found.report.case_public_ref, public_ref: found.version.version_ref,
          event_type: 'REPORT_PUBLISHED', actor_wallet: wallet, actor_role: 'analyst',
          decision: 'publish', occurred_at: found.version.published_at, tx_sig: PUBLISH_TX,
        });
        return {
          status: 200,
          payload: { ok: true, version_public_ref: found.version.version_ref, decision_channel: 'standard', lifecycle_state: 'published' },
        };
      }
      return { status: 400, payload: { ok: false, error: 'bad_op' } };
    }

    if (endpoint === 'osi-v2-payment') {
      if (op === 'capabilities') {
        return { status: 200, payload: { ok: true, payment_writes_enabled: true, network: 'mainnet-beta', native_sol_only: true, non_custodial: true, atomic_support_max_recipients: 4, solana_pay_enabled: false } };
      }
      return { status: 200, payload: { ok: true } };
    }

    if (endpoint === 'osi-v2-governance-write' && op === 'actor_capabilities') {
      return { status: 200, payload: { ok: true, resolution_lifecycle_writes_enabled: false, challenge_writes_enabled: false } };
    }
    if (endpoint === 'osi-v2-ai-pack' && op === 'capabilities') {
      return { status: 200, payload: { ok: true, ai_pack_writes_enabled: false, ai_pack_review_writes_enabled: false, can_generate: false, ai_pack_access_mode: 'maintainer_only', generation_prerequisite: 'Full maintainer access is required to generate an AI Pack.' } };
    }
    if (endpoint === 'osi-v2-analyst' && op === 'list_public_profiles') {
      return { status: 200, payload: { ok: true, analysts: [] } };
    }
    if (endpoint === 'osi-v2-wire') return { status: 200, payload: { ok: true, reports: [], wire_reports: [], stats: {} } };
    if (endpoint === 'osi-v2-proof') return { status: 200, payload: { ok: true, events: [] } };
    return { status: 200, payload: { ok: true } };
  };

  return api;
}

// ---------------------------------------------------------------------------
// Page harness
// ---------------------------------------------------------------------------

async function boot(page, backend, options = {}) {
  page.__errors = [];
  page.on('pageerror', (error) => page.__errors.push(`page: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 500) page.__errors.push(`http ${response.status()} ${response.url()}`);
  });

  await page.addInitScript(({ wallet, trusted }) => {
    window.__osiWalletCalls = [];
    const record = (name) => { window.__osiWalletCalls.push(name); };
    if (!wallet) {
      Object.defineProperty(window, 'solana', { configurable: true, get() { record('read:window.solana'); return undefined; } });
      Object.defineProperty(window, 'phantom', { configurable: true, get() { record('read:window.phantom'); return undefined; } });
    } else {
      const publicKey = { toString: () => wallet };
      // trusted === false models the ordinary visitor: the silent reconnect
      // finds no authorization, so the wallet only opens on an explicit action.
      const preAuthorized = trusted !== false;
      const provider = {
        isPhantom: true, isConnected: preAuthorized, publicKey: preAuthorized ? publicKey : null,
        connect: async (options) => {
          record('connect');
          if (!preAuthorized && options && options.onlyIfTrusted) throw new Error('not trusted');
          provider.isConnected = true; provider.publicKey = publicKey; return { publicKey };
        },
        disconnect: async () => { provider.isConnected = false; provider.publicKey = null; },
        signMessage: async () => { record('signMessage'); return { signature: new Uint8Array(64).fill(7) }; },
        signAndSendTransaction: async () => { record('sendTransaction'); return { signature: '3'.repeat(88) }; },
        on: () => {}, off: () => {},
      };
      window.solana = provider;
      window.phantom = { solana: provider };
    }
    window.open = function () { record('window.open'); return null; };
    window.confirm = function () { return false; };

    // Minimal stand-in for the CDN web3 bundle. Memo transactions are built and
    // handed to the provider exactly as in production; only the network calls
    // are local, so the wallet-approval path is still the real one.
    class StubPublicKey {
      constructor(value) { this.value = String(value); }
      toString() { return this.value; }
      toBase58() { return this.value; }
    }
    window.solanaWeb3 = {
      PublicKey: StubPublicKey,
      Connection: class {
        async getLatestBlockhash() { return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 }; }
        async getSignatureStatuses() { return { value: [{ confirmationStatus: 'finalized', err: null }] }; }
        async getBalance() { return 0; }
      },
      Transaction: class {
        constructor() { this.instructions = []; }
        add(instruction) { this.instructions.push(instruction); return this; }
      },
      TransactionInstruction: class {
        constructor(config) { Object.assign(this, config || {}); }
      },
      SystemProgram: { transfer: (config) => ({ kind: 'transfer', ...config }) },
    };
  }, { wallet: options.wallet || '', trusted: options.trusted !== false });

  await page.route(/https:\/\/(?:bundle\.run|unpkg\.com|cdn\.jsdelivr\.net)\/.*/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.route('https://api.coingecko.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ solana: { usd: 0, usd_24h_change: 0 } }) }));
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/functions/v1/**', async (route) => {
    const request = route.request();
    const endpoint = new URL(request.url()).pathname.split('/').pop();
    let body = {};
    try { body = JSON.parse(request.postData() || '{}'); } catch (_) { body = {}; }
    const origin = request.headers().origin || new URL(page.url()).origin;
    const result = backend.handle(endpoint, body, origin);
    await route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.payload) });
  });

  await page.goto('/');
  await page.waitForFunction(() => typeof window.osiNavigate === 'function' && typeof window.osiV2OpenCase === 'function');
  if (options.wallet && options.trusted !== false) {
    // `walletPubkey` is a script-scoped binding, not a window property, so the
    // real connect path has to run. The fixture provider resolves it without a
    // prompt, which is what a trusted reconnect does in a live browser.
    await page.evaluate(async () => {
      if (window.OSI_WALLET_READY) await window.OSI_WALLET_READY;
      if (typeof walletPubkey === 'undefined' || !walletPubkey) await toggleWallet();
    });
    await page.waitForFunction((actor) => typeof walletPubkey !== 'undefined' && walletPubkey === actor, options.wallet);
  }
}

async function openCaseDrawer(page, ref = CASE_REF) {
  await page.evaluate((value) => window.osiV2OpenCase(value), ref);
  await expect(page.locator('#osi-case-drawer')).toBeVisible();
  await expect(page.locator('#osi-case-ref')).toHaveText(ref);
}

async function showTab(page, name) {
  await page.locator(`#osi-case-tabs [data-tab="${name}"]`).click();
}

function expectClean(page) {
  expect(page.__errors, `runtime errors: ${page.__errors.join(' | ')}`).toEqual([]);
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

test('the Report form guides toward a public-safe summary without forbidding its absence', async ({ page }) => {
  const backend = createBackend().seedApprovedCase();
  await boot(page, backend, { wallet: AUTHOR });

  await openCaseDrawer(page);
  await page.getByRole('button', { name: 'Submit Report' }).click();
  await expect(page.locator('#osi-report-modal')).toHaveClass(/open/);

  const hint = page.locator('#osi-report-summary-help');
  await expect(hint).toContainText('only part of your Report that the public can ever read');
  // The old copy claimed the opposite on both counts and is what produced a
  // published Report nobody could read.
  await expect(hint).not.toContainText('Optional');
  await expect(hint).not.toContainText('still private in this intake slice');

  // Narrative only, no summary, no acknowledgement: the form stops and says why
  // rather than silently creating another unreadable publication candidate.
  await page.locator('#osi-report-narrative').fill(NARRATIVE);
  await page.locator('#osi-report-safety').check();
  await page.getByRole('button', { name: 'Prepare exact Memo' }).click();
  expect(backend.state.calls.filter((call) => call === 'osi-v2-report-write:prepare_report')).toHaveLength(0);
  await expect(page.locator('#osi-report-summary')).toBeFocused();
  expect(await page.locator('#osi-report-summary').evaluate((node) => node.validationMessage))
    .toContain('tick the box below');

  // A summary that is too short to be a usable finding is also refused.
  await page.locator('#osi-report-summary').fill('Too short.');
  await page.getByRole('button', { name: 'Prepare exact Memo' }).click();
  expect(backend.state.calls.filter((call) => call === 'osi-v2-report-write:prepare_report')).toHaveLength(0);
  expect(await page.locator('#osi-report-summary').evaluate((node) => node.validationMessage))
    .toContain('at least 40 characters');

  expectClean(page);
});

// The Product Constitution calls a missing public-safe summary an honest
// nullable state and explicitly not a publication blocker, so the product must
// still allow it. What it must not do is let it happen by accident.
test('an author may deliberately submit a Report with no public-safe summary', async ({ page }) => {
  const backend = createBackend().seedApprovedCase();
  await boot(page, backend, { wallet: AUTHOR });

  await openCaseDrawer(page);
  await page.getByRole('button', { name: 'Submit Report' }).click();
  await page.locator('#osi-report-narrative').fill(NARRATIVE);
  await page.locator('#osi-report-safety').check();
  await page.locator('#osi-report-no-summary').check();
  await page.getByRole('button', { name: 'Prepare exact Memo' }).click();

  await expect.poll(() => backend.state.reports.length).toBe(1);
  expect(backend.state.reports[0].versions[0].content_public_safe).toBeNull();

  expectClean(page);
});

test('the no-summary acknowledgement is re-affirmed on every open, never inherited from a draft', async ({ page }) => {
  const backend = createBackend().seedApprovedCase();
  await boot(page, backend, { wallet: AUTHOR });

  await openCaseDrawer(page);
  await page.getByRole('button', { name: 'Submit Report' }).click();
  await page.locator('#osi-report-narrative').fill(NARRATIVE);
  await page.locator('#osi-report-no-summary').check();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Submit Report' }).click();
  await expect(page.locator('#osi-report-modal')).toHaveClass(/open/);
  // The narrative comes back from the draft; the waiver does not.
  await expect(page.locator('#osi-report-narrative')).toHaveValue(NARRATIVE);
  await expect(page.locator('#osi-report-no-summary')).not.toBeChecked();

  expectClean(page);
});

test('a submitted Report carries its public-safe summary to the server', async ({ page }) => {
  const backend = createBackend().seedApprovedCase();
  await boot(page, backend, { wallet: AUTHOR });

  await openCaseDrawer(page);
  await page.getByRole('button', { name: 'Submit Report' }).click();
  await page.locator('#osi-report-narrative').fill(NARRATIVE);
  await page.locator('#osi-report-summary').fill(PUBLIC_SUMMARY);
  await page.locator('#osi-report-safety').check();
  await page.getByRole('button', { name: 'Prepare exact Memo' }).click();

  await expect.poll(() => backend.state.reports.length).toBe(1);
  const version = backend.state.reports[0].versions[0];
  expect(version.content_public_safe).toBe(PUBLIC_SUMMARY);
  expect(version.body_private).toBe(NARRATIVE);
  await expect(page.locator('#osi-report-form-status')).toContainText('submitted');

  expectClean(page);
});

test('reaching approve quorum surfaces a ready-to-publish state with the publish action', async ({ page }) => {
  // One approval short of quorum, cast by the other analyst.
  const backend = createBackend().seedApprovedReport(1);
  await boot(page, backend, { wallet: ANALYST_B });

  await page.evaluate(() => window.osiV2OpenReportQueue());
  const version = page.locator(`[data-report-version-ref="${VERSION_REF}"]`);
  await expect(version).toBeVisible();
  // Below quorum there is no ready banner and publishing stays disabled.
  await expect(version.locator('.osi-report-ready')).toHaveCount(0);
  await expect(version.getByRole('button', { name: 'Publish analyst-approved version' })).toBeDisabled();

  await version.locator(`#osi-review-decision-${VERSION_REF}`).selectOption('approve');
  await version.getByRole('button', { name: 'Sign and cast review' }).click();

  const ready = page.locator(`[data-report-version-ref="${VERSION_REF}"] .osi-report-ready`);
  await expect(ready).toBeVisible();
  await expect(ready).toContainText('Approve quorum reached');
  await expect(ready).toContainText('2 / 2 analysts');
  await expect(ready).toContainText('2.00 / 2.00 weight');
  // The honest reason a person still has to act.
  await expect(ready).toContainText('OSI holds no signing key');
  await expect(ready.getByRole('button', { name: 'Publish this version now' })).toBeEnabled();

  expectClean(page);
});

test('publishing from the ready state makes the finding public and readable', async ({ page }) => {
  const backend = createBackend().seedApprovedReport();
  await boot(page, backend, { wallet: ANALYST_B });

  await page.evaluate(() => window.osiV2OpenReportQueue());
  const ready = page.locator(`[data-report-version-ref="${VERSION_REF}"] .osi-report-ready`);
  await expect(ready).toBeVisible();
  await ready.getByRole('button', { name: 'Publish this version now' }).click();

  await expect.poll(() => backend.state.reports[0].current_published_version_ref).toBe(VERSION_REF);
  await expect(page.locator(`#osi-review-status-${VERSION_REF}`)).toContainText('standard analyst-quorum route');

  // Now read it as the public does.
  await page.reload();
  await page.waitForFunction(() => typeof window.osiV2OpenCase === 'function');
  await openCaseDrawer(page);
  await showTab(page, 'reports');

  const card = page.locator(`[data-report-version-public-ref="${VERSION_REF}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('.osi-report-public-body h4')).toHaveText('Published finding');
  await expect(card).toContainText(SUMMARY_P1);
  await expect(card).toContainText(SUMMARY_P2);
  // Both paragraphs survive as separate blocks rather than one run-on string.
  await expect(card.locator('.osi-report-public-body p')).toHaveCount(2);
  await expect(card).not.toContainText(PRIVATE_SENTINEL);
  await expect(card.getByRole('button', { name: 'Support author with SOL' })).toBeVisible();
  await expect(card.getByRole('link', { name: /Verify REPORT_PUBLISHED on Solscan/ })).toBeVisible();

  expectClean(page);
});

test('a published Report reads finding-first and never leaks the restricted body', async ({ page }) => {
  const backend = createBackend().seedPublishedReport();
  await boot(page, backend);

  await openCaseDrawer(page);
  await showTab(page, 'reports');
  const card = page.locator(`[data-report-version-public-ref="${VERSION_REF}"]`);
  await expect(card).toBeVisible();

  // Reading order: the finding sits above the governance numbers, not below.
  const findingTop = await card.locator('.osi-report-public-body').boundingBox();
  const quorumTop = await card.locator('.osi-report-quorum').boundingBox();
  expect(findingTop.y).toBeLessThan(quorumTop.y);

  // The whole page, not just the card, is free of the restricted narrative.
  await expect(page.locator('body')).not.toContainText(PRIVATE_SENTINEL);
  const bodyText = await page.evaluate(() => document.body.innerText);
  expect(bodyText.includes(PRIVATE_SENTINEL)).toBe(false);

  // Typography actually applies: an undefined --mono token used to invalidate
  // the whole font shorthand and drop the designed size with it.
  const font = await card.locator('.osi-report-quorum span').first().evaluate((node) => {
    const style = window.getComputedStyle(node);
    return { family: style.fontFamily, size: style.fontSize };
  });
  expect(font.family).toContain('JetBrains Mono');
  expect(font.size).toBe('12px');

  expectClean(page);
});

test('the Case approval that opened a public investigation is visible to anyone', async ({ page }) => {
  const backend = createBackend().seedPublishedReport();
  await boot(page, backend);

  await openCaseDrawer(page);
  const tab = page.locator('#osi-case-tabs [data-tab="reviews"]');
  await expect(tab).toBeVisible();
  await tab.click();

  const outcome = page.locator('#osi-case-content .osi-state-message');
  await expect(outcome).toContainText('Approved for public investigation');
  await expect(outcome).toContainText('1 eligible analyst');
  await expect(outcome).toContainText('counted analyst weight 1.00');
  await expect(outcome.getByRole('link', { name: /Verify CASE_OPENED on Solscan/ })).toHaveAttribute('href', `https://solscan.io/tx/${OPEN_TX}`);
  // The attributable row itself stays on the page under the summary.
  await expect(page.locator('#osi-case-content')).toContainText('Approve Open');
  await expect(page.locator('#osi-case-content')).toContainText('Reason code: public_scope_clear');

  expectClean(page);
});

test('a Case with a published Report is signposted in the public list', async ({ page }) => {
  const backend = createBackend().seedPublishedReport();
  await boot(page, backend);

  await page.evaluate(() => window.osiNavigate('field'));
  const row = page.locator(`[data-case-ref="${CASE_REF}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('.osi-published-chip')).toHaveText('1 published Report');

  expectClean(page);
});

test('supporting a Report author never shows a version reference as a payable address', async ({ page }) => {
  const backend = createBackend().seedPublishedReport();
  await boot(page, backend, { wallet: OWNER });

  await openCaseDrawer(page);
  await showTab(page, 'reports');
  await page.locator(`[data-report-version-public-ref="${VERSION_REF}"]`).getByRole('button', { name: 'Support author with SOL' }).click();

  const dialog = page.locator('#sol-ask');
  await expect(dialog).toHaveClass(/open/);
  await expect(page.locator('#sol-ask-label')).toContainText('the author of this published Report version');
  // The anonymous projection has no author wallet, so the address slot must be
  // empty rather than rendering OSI-RV-… as if it were payable.
  await expect(page.locator('#sol-ask-addr')).toHaveText('');
  await expect(page.locator('#sol-ask-note')).toContainText(VERSION_REF);
  await expect(page.locator('#sol-ask-note')).toContainText('server derives the exact recipient');

  expectClean(page);
});

// The amount picker used to be raised at a lower z-index than the Case drawer
// it was opened from, so asking for a transfer painted the dialog *behind* the
// drawer: the person saw the page dim and nothing else. Ask the browser what is
// actually on top rather than trusting the declared z-index, because the answer
// depends on the whole stacking context chain, not on one number.
test('the amount picker raised from the Case drawer renders on top of it', async ({ page }) => {
  const backend = createBackend().seedPublishedReport();
  await boot(page, backend, { wallet: OWNER });

  await openCaseDrawer(page);
  await showTab(page, 'reports');
  await page.locator(`[data-report-version-public-ref="${VERSION_REF}"]`).getByRole('button', { name: 'Support author with SOL' }).click();
  await expect(page.locator('#sol-ask')).toHaveClass(/open/);

  const covering = await page.evaluate(() => {
    const card = document.querySelector('#sol-ask .sol-ask-card');
    const rect = card.getBoundingClientRect();
    const probes = [
      [rect.left + rect.width / 2, rect.top + 12],
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + 12, rect.bottom - 12],
    ];
    return probes
      .map(([x, y]) => document.elementFromPoint(x, y))
      .filter((node) => !node || !card.contains(node))
      .map((node) => (node ? node.id || node.className || node.tagName : 'nothing'));
  });
  expect(covering).toEqual([]);

  // Focus does not always stay inside the dialog: the surface underneath can
  // re-render and take it back. A modal that answers Escape only while focus
  // happens to be inside it is one a person can get stuck in, so drop focus
  // first and require the dialog to answer anyway.
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  // Backing out of the amount must not also close the record behind it. Both
  // surfaces listen for Escape, so the picker has to stop the event.
  await page.keyboard.press('Escape');
  await expect(page.locator('#sol-ask')).not.toHaveClass(/open/);
  await expect(page.locator('#osi-case-drawer')).toBeVisible();
  await expect(page.locator('#osi-case-ref')).toHaveText(CASE_REF);

  expectClean(page);
});

// Each leg of this journey acts as a different wallet. Reusing one page would
// carry that leg's read session, drafts and accumulated init scripts into the
// next, so every leg gets its own context. The backend state machine is the
// only thing that persists across them, which is exactly the real situation:
// different people, one server.
test('the full lifecycle runs from private intake to a readable public finding', async ({ browser }) => {
  test.setTimeout(180_000);
  const backend = createBackend();
  const contexts = [];
  const asWallet = async (wallet) => {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await boot(page, backend, wallet ? { wallet } : {});
    return page;
  };

  try {
    // 1. The owner files a private Case.
    const owner = await asWallet(OWNER);
    await owner.evaluate(() => window.fieldOpenForm());
    await owner.locator('#v2-case-title').fill('Unexpected transfer pattern for review');
    await owner.locator('#v2-case-summary').fill('A neutral, public-safe description of the reported transfer pattern for independent review.');
    await owner.locator('#v2-case-category').selectOption('wallet_drain');
    await owner.locator('#v2-case-confirm').check();
    await owner.getByRole('button', { name: 'Review and sign' }).click();
    await expect.poll(() => backend.state.cases.length).toBe(1);
    expect(backend.state.cases[0].visibility).toBe('private');
    await expect(owner.locator('#v2-case-receipt')).toContainText(CASE_REF);
    expectClean(owner);

    // 2. An eligible analyst approves it and anchors the public open.
    const approver = await asWallet(ANALYST_A);
    await openCaseDrawerPrivate(approver, backend);
    await expect.poll(() => backend.state.cases[0].visibility).toBe('public');
    expectClean(approver);

    // 3. A different wallet submits a Report with a public-safe summary.
    const author = await asWallet(AUTHOR);
    await openCaseDrawer(author);
    await author.getByRole('button', { name: 'Submit Report' }).click();
    await expect(author.locator('#osi-report-modal')).toHaveClass(/open/);
    await author.locator('#osi-report-narrative').fill(NARRATIVE);
    await author.locator('#osi-report-summary').fill(PUBLIC_SUMMARY);
    await author.locator('#osi-report-safety').check();
    await author.getByRole('button', { name: 'Prepare exact Memo' }).click();
    await expect.poll(() => backend.state.reports.length).toBe(1);
    expectClean(author);

    // 4. Two independent analysts approve, reaching quorum.
    let lastAnalystPage = null;
    for (const analyst of [ANALYST_A, ANALYST_B]) {
      const reviewer = await asWallet(analyst);
      lastAnalystPage = reviewer;
      await reviewer.evaluate(() => window.osiV2OpenReportQueue());
      const version = reviewer.locator(`[data-report-version-ref="${VERSION_REF}"]`);
      await expect(version).toBeVisible();
      await version.locator(`#osi-review-decision-${VERSION_REF}`).selectOption('approve');
      await version.getByRole('button', { name: /Sign and cast review|Revise my review/ }).click();
      await expect.poll(() => backend.state.reports[0].versions[0].reviews.some((row) => row.reviewer_wallet === analyst)).toBe(true);
    }

    // 5. The second approver publishes from the ready state.
    const ready = lastAnalystPage.locator(`[data-report-version-ref="${VERSION_REF}"] .osi-report-ready`);
    await expect(ready).toBeVisible();
    await ready.getByRole('button', { name: 'Publish this version now' }).click();
    await expect.poll(() => backend.state.reports[0].current_published_version_ref).toBe(VERSION_REF);
    expectClean(lastAnalystPage);

    // 6. An anonymous visitor reads the finding.
    const visitor = await asWallet(null);
    await openCaseDrawer(visitor);
    await showTab(visitor, 'reports');
    const card = visitor.locator(`[data-report-version-public-ref="${VERSION_REF}"]`);
    await expect(card).toContainText(SUMMARY_P1);
    await expect(card).toContainText(SUMMARY_P2);
    await expect(card).toContainText('2 / 2 analysts');
    await expect(card).not.toContainText(PRIVATE_SENTINEL);
    await expect(card.getByRole('button', { name: 'Support author with SOL' })).toBeVisible();
    expectClean(visitor);
  } finally {
    for (const context of contexts) await context.close();
  }
});

// The private intake drawer is reached through the authorized review lane
// rather than the public route, so it gets its own opener.
async function openCaseDrawerPrivate(page, backend) {
  await page.evaluate(() => window.osiV2OpenReviewQueue());
  await page.evaluate((ref) => window.osiV2OpenCase(ref), CASE_REF);
  await expect(page.locator('#osi-case-drawer')).toBeVisible();
  await page.getByRole('button', { name: 'Record review' }).click();
  await page.locator('#osi-review-decision').selectOption('approve_open');
  await page.locator('#osi-review-submit').click();
  await expect.poll(() => backend.state.cases[0].reviews.length).toBe(1);
  await page.getByRole('button', { name: 'Anchor public open' }).click();
}

test('capture each lifecycle stage for release QA', async ({ page }) => {
  test.skip(!process.env.OSI_QA_SCREENSHOT_DIR, 'Screenshot capture is enabled only for release QA.');
  const directory = path.resolve(process.env.OSI_QA_SCREENSHOT_DIR);
  fs.mkdirSync(directory, { recursive: true });
  const capture = async (name) => {
    await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: false });
  };

  // 1. Report intake, with the corrected public-safe summary contract.
  const intake = createBackend().seedApprovedCase();
  await boot(page, intake, { wallet: AUTHOR });
  await openCaseDrawer(page);
  await page.getByRole('button', { name: 'Submit Report' }).click();
  await page.locator('#osi-report-narrative').fill(NARRATIVE);
  await page.locator('#osi-report-summary').fill(PUBLIC_SUMMARY);
  await capture('01-report-intake');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // 2. Approve quorum reached, ready to publish.
  const review = createBackend().seedApprovedReport();
  await boot(page, review, { wallet: ANALYST_B });
  await page.evaluate(() => window.osiV2OpenReportQueue());
  const readyBanner = page.locator(`[data-report-version-ref="${VERSION_REF}"] .osi-report-ready`);
  await expect(readyBanner).toBeVisible();
  await readyBanner.scrollIntoViewIfNeeded();
  await capture('02-quorum-ready-to-publish');

  // 3. The published finding as an anonymous visitor reads it.
  const published = createBackend().seedPublishedReport();
  await boot(page, published);
  await openCaseDrawer(page);
  await showTab(page, 'reports');
  await expect(page.locator(`[data-report-version-public-ref="${VERSION_REF}"]`)).toBeVisible();
  await capture('03-published-finding');

  // 4. The Case approval record.
  await showTab(page, 'reviews');
  await expect(page.locator('#osi-case-content .osi-state-message')).toBeVisible();
  await capture('04-case-approval');

  // 5. The public list, signposting the published Report.
  await page.locator('#osi-case-drawer .osi-case-close').click();
  await page.evaluate(() => window.osiNavigate('field'));
  await expect(page.locator(`[data-case-ref="${CASE_REF}"] .osi-published-chip`)).toBeVisible();
  await capture('05-public-list');

  // 6. The same published finding at 390px.
  await page.setViewportSize({ width: 390, height: 844 });
  await openCaseDrawer(page);
  await showTab(page, 'reports');
  await expect(page.locator(`[data-report-version-public-ref="${VERSION_REF}"]`)).toBeVisible();
  await capture('06-published-finding-mobile');
});

// ---------------------------------------------------------------------------
// The other analyst-quorum outcome
// ---------------------------------------------------------------------------

test('a version whose reject quorum is met offers the rejection, not a dead end', async ({ page }) => {
  const backend = createBackend().seedRejectQuorum();
  await boot(page, backend, { wallet: ANALYST_B });

  await page.evaluate(() => window.osiV2OpenReportQueue());
  const banner = page.locator(`[data-report-version-ref="${VERSION_REF}"] .osi-report-reject-ready`);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Reject quorum reached');
  await expect(banner).toContainText('2 / 2 analysts');
  await expect(banner).toContainText('2.00 / 2.00 weight');
  // Rejection is never a bad-faith finding and never blocks a revision.
  await expect(banner).toContainText('not a finding of bad faith');
  await expect(banner).toContainText('may submit a new revision');
  // Approve-side publication must stay unavailable on the same version.
  await expect(page.locator(`[data-report-version-ref="${VERSION_REF}"] .osi-report-ready`)).toHaveCount(0);
  await expect(banner.getByRole('button', { name: 'Record the rejection now' })).toBeEnabled();

  expectClean(page);
});

test('recording the rejection moves the exact version to rejected and never publishes it', async ({ page }) => {
  const backend = createBackend().seedRejectQuorum();
  await boot(page, backend, { wallet: ANALYST_B });

  await page.evaluate(() => window.osiV2OpenReportQueue());
  const banner = page.locator(`[data-report-version-ref="${VERSION_REF}"] .osi-report-reject-ready`);
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Record the rejection now' }).click();

  await expect.poll(() => backend.state.reports[0].versions[0].lifecycle_state).toBe('rejected');
  // The published pointer never moves on a rejection.
  expect(backend.state.reports[0].current_published_version_ref).toBeNull();
  expect(backend.state.receipts.some((row) => row.event_type === 'REPORT_REJECTED')).toBe(true);
  await expect(page.locator(`#osi-review-status-${VERSION_REF}`)).toContainText('rejected');
  await expect(page.locator(`#osi-review-status-${VERSION_REF}`)).toContainText('may submit a new revision');

  // The anonymous Case surface still shows no published Report.
  await boot(page, backend);
  await openCaseDrawer(page);
  await showTab(page, 'reports');
  await expect(page.locator('#osi-public-reports')).toContainText('No published Reports');
  await expect(page.locator('body')).not.toContainText(PRIVATE_SENTINEL);

  expectClean(page);
});

test('a wallet without an active reject review is told who can record the rejection', async ({ page }) => {
  const backend = createBackend().seedRejectQuorum();
  // The Report author is never an eligible reviewer of their own version.
  await boot(page, backend, { wallet: AUTHOR });

  await page.evaluate(() => window.osiV2OpenReportQueue());
  // The author's own Report never enters their review queue at all.
  await expect(page.locator(`[data-report-version-ref="${VERSION_REF}"]`)).toHaveCount(0);

  expectClean(page);
});

// ---------------------------------------------------------------------------
// Shipped-surface contract
// ---------------------------------------------------------------------------

// index.html once carried two containers, #osi-guard and #rv-drawer, whose
// openers and handlers live in scripts only legacy.html loads. Every control
// inside them threw ReferenceError. Nothing opened those containers so no user
// could reach them, but a dormant control that cannot work is exactly what the
// delivery brief forbids. This walks the real shipped DOM instead of trusting a
// grep, so a handler that stops being loaded fails here.
test('every inline handler in the shipped page resolves to a real function', async ({ page }) => {
  const backend = createBackend().seedPublishedReport();
  await boot(page, backend);

  const missing = await page.evaluate(() => {
    const names = new Set();
    document.querySelectorAll('*').forEach((element) => {
      for (const attribute of element.attributes) {
        if (!/^on[a-z]+$/.test(attribute.name)) continue;
        // Skip method calls: `event.preventDefault()` is not a global.
        const pattern = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
        let match;
        while ((match = pattern.exec(attribute.value))) names.add(match[1]);
      }
    });
    const reserved = new Set(['if', 'return', 'typeof', 'function', 'catch', 'for', 'while', 'switch', 'new']);
    const unresolved = [];
    names.forEach((name) => {
      if (reserved.has(name)) return;
      let resolved = false;
      try { resolved = typeof window[name] === 'function' || typeof eval(name) === 'function'; } catch (_) { resolved = false; }
      if (!resolved) unresolved.push(name);
    });
    return unresolved.sort();
  });
  expect(missing, `unresolved inline handlers: ${missing.join(', ')}`).toEqual([]);

  expectClean(page);
});

test('a Case past Report intake states the closure instead of opening a wallet', async ({ page }) => {
  const backend = createBackend().seedSealedCase();
  await boot(page, backend, { wallet: OWNER });

  // Baseline excludes the harness's own initial connect.
  await page.evaluate(() => { window.__osiWalletCalls.length = 0; });
  await openCaseDrawer(page);
  const actions = page.locator('#osi-case-actions');
  await expect(actions).toContainText('past Report intake');
  // The server accepts intake only while a Case is open, under Report review or
  // reopened. Offering the action anyway spent a wallet prompt to reach a
  // guaranteed capability failure.
  await expect(actions.getByRole('button', { name: 'Submit Report' })).toHaveCount(0);
  const closed = actions.getByRole('button', { name: 'Report intake closed' });
  await expect(closed).toBeDisabled();
  await expect(closed).toHaveAttribute('title', /open only while a Case is in public investigation/);
  // The record stays readable and the closed control reaches no wallet API.
  await expect(actions.getByRole('button', { name: 'Inspect proof' })).toBeEnabled();
  await closed.click({ force: true });
  expect(await page.evaluate(() => window.__osiWalletCalls)).toEqual([]);

  expectClean(page);
});

test('an open Case still offers Report submission', async ({ page }) => {
  const backend = createBackend().seedApprovedCase();
  await boot(page, backend, { wallet: OWNER });

  await openCaseDrawer(page);
  const actions = page.locator('#osi-case-actions');
  await expect(actions.getByRole('button', { name: 'Submit Report' })).toBeEnabled();
  await expect(actions).toContainText('Contribute findings');

  expectClean(page);
});

test('a Phantom failure during Case intake explains itself instead of printing the raw provider error', async ({ page }) => {
  const backend = createBackend();
  await boot(page, backend, { wallet: OWNER });

  // Phantom answers a request it could not handle with a generic internal
  // error. This is the exact failure that left prepared Cases unsigned.
  await page.evaluate(() => {
    window.solana.signAndSendTransaction = async () => {
      const error = new Error('Unexpected error');
      error.code = -32603;
      throw error;
    };
  });

  await page.evaluate(() => window.fieldOpenForm());
  // The intake moves focus to the title 80ms after the form opens. Typing
  // before that timer lands lets the autofocus arrive between a fill's focus
  // and its value write, which redirects the summary text into the title and
  // leaves the summary empty. On the connect-at-intent path the form opens
  // later still, as a deferred callback, which widens the window. Wait for the
  // intake to finish opening and take focus, so each fill goes where this test
  // means it to go.
  await expect(page.locator('#fo-modal')).toHaveClass(/open/);
  await expect(page.locator('#v2-case-title')).toBeFocused();

  await page.locator('#v2-case-title').fill('Unexpected transfer pattern for review');
  await page.locator('#v2-case-summary').fill('A neutral, public-safe description of the reported transfer pattern for independent review.');
  await page.locator('#v2-case-category').selectOption('wallet_drain');
  await page.locator('#v2-case-confirm').check();
  // Settle on the exact field values before submitting: an invalid form returns
  // without a word. Assert the title exactly, so a stray fill landing in it is
  // a failure here rather than a puzzle three lines later.
  await expect(page.locator('#v2-case-title')).toHaveValue('Unexpected transfer pattern for review');
  await expect(page.locator('#v2-case-summary')).toHaveValue(/public-safe description/);
  await page.getByRole('button', { name: 'Review and sign' }).click();

  const status = page.locator('#v2-case-form-status');
  await expect(status).toContainText('Phantom did not answer this request');
  await expect(status).not.toHaveText('Unexpected error');
  // A failed signature must still leave no Case behind.
  expect(backend.state.cases.length).toBe(0);

  expectClean(page);
});

test('a declined signature during Case intake names the decline, and an empty wallet names the fee', async ({ page }) => {
  const backend = createBackend();
  await boot(page, backend, { wallet: OWNER });

  await page.evaluate(() => {
    window.solana.signAndSendTransaction = async () => {
      const error = new Error('User rejected the request.');
      error.code = 4001;
      throw error;
    };
  });

  await page.evaluate(() => window.fieldOpenForm());
  // The intake moves focus to the title 80ms after the form opens. Typing
  // before that timer lands lets the autofocus arrive between a fill's focus
  // and its value write, which redirects the summary text into the title and
  // leaves the summary empty. On the connect-at-intent path the form opens
  // later still, as a deferred callback, which widens the window. Wait for the
  // intake to finish opening and take focus, so each fill goes where this test
  // means it to go.
  await expect(page.locator('#fo-modal')).toHaveClass(/open/);
  await expect(page.locator('#v2-case-title')).toBeFocused();

  await page.locator('#v2-case-title').fill('Unexpected transfer pattern for review');
  await page.locator('#v2-case-summary').fill('A neutral, public-safe description of the reported transfer pattern for independent review.');
  await page.locator('#v2-case-category').selectOption('wallet_drain');
  await page.locator('#v2-case-confirm').check();
  // Settle on the exact field values before submitting: an invalid form returns
  // without a word. Assert the title exactly, so a stray fill landing in it is
  // a failure here rather than a puzzle three lines later.
  await expect(page.locator('#v2-case-title')).toHaveValue('Unexpected transfer pattern for review');
  await expect(page.locator('#v2-case-summary')).toHaveValue(/public-safe description/);
  await page.getByRole('button', { name: 'Review and sign' }).click();
  await expect(page.locator('#v2-case-form-status')).toContainText('You declined the request in Phantom.');

  await page.evaluate(() => {
    window.solana.signAndSendTransaction = async () => {
      throw new Error('Attempt to debit an account but found no record of a prior credit.');
    };
  });
  await page.getByRole('button', { name: 'Review and sign' }).click();
  await expect(page.locator('#v2-case-form-status')).toContainText('does not hold enough SOL');
  expect(backend.state.cases.length).toBe(0);

  expectClean(page);
});

test('a visitor who connects at the signature still files the Case', async ({ page }) => {
  const backend = createBackend();
  // No silent authorization exists, so the wallet opens during the submission
  // itself. That connect must not discard the private session under the action.
  await boot(page, backend, { wallet: OWNER, trusted: false });
  await expect(page.locator('#wbText')).toHaveText('Connect Wallet');

  await page.evaluate(() => window.fieldOpenForm());
  // The intake moves focus to the title 80ms after the form opens. Typing
  // before that timer lands lets the autofocus arrive between a fill's focus
  // and its value write, which redirects the summary text into the title and
  // leaves the summary empty. On the connect-at-intent path the form opens
  // later still, as a deferred callback, which widens the window. Wait for the
  // intake to finish opening and take focus, so each fill goes where this test
  // means it to go.
  await expect(page.locator('#fo-modal')).toHaveClass(/open/);
  await expect(page.locator('#v2-case-title')).toBeFocused();

  await page.locator('#v2-case-title').fill('Unexpected transfer pattern for review');
  await page.locator('#v2-case-summary').fill('A neutral, public-safe description of the reported transfer pattern for independent review.');
  await page.locator('#v2-case-category').selectOption('wallet_drain');
  await page.locator('#v2-case-confirm').check();
  // Settle on the exact field values before submitting: an invalid form returns
  // without a word. Assert the title exactly, so a stray fill landing in it is
  // a failure here rather than a puzzle three lines later.
  await expect(page.locator('#v2-case-title')).toHaveValue('Unexpected transfer pattern for review');
  await expect(page.locator('#v2-case-summary')).toHaveValue(/public-safe description/);
  await page.getByRole('button', { name: 'Review and sign' }).click();

  await expect.poll(() => backend.state.cases.length).toBe(1);
  await expect(page.locator('#v2-case-receipt')).toContainText(CASE_REF);
  expectClean(page);
});

test('a late draft restore never replaces what the author already typed', async ({ page }) => {
  const backend = createBackend();
  await boot(page, backend, { wallet: OWNER, trusted: true });

  // Open once so the intake settles, then type. This is the state a person is
  // in when they start filling the form.
  await page.evaluate(() => window.fieldOpenForm());
  await expect(page.locator('#fo-modal')).toHaveClass(/open/);
  await expect(page.locator('#v2-case-title')).toBeFocused();
  await page.locator('#v2-case-title').fill('Typed by the author');
  await page.locator('#v2-case-summary').fill('A neutral, public-safe summary the author typed by hand.');
  await page.locator('#v2-case-category').selectOption('wallet_drain');

  // Plant an older draft: a half-finished one whose summary and category were
  // saved before the author got that far. Restoring it wholesale is exactly the
  // data loss this guards against, and an empty saved value is the worst case
  // because it clears the field rather than swapping one sentence for another.
  await page.evaluate((wallet) => window.osiV2SaveDraft('case-intake:' + wallet, {
    'v2-case-title': 'Stale draft title',
    'v2-case-summary': '',
    'v2-case-category': '',
    'v2-case-details': 'Stale details that should still land, because that field is blank.',
  }), OWNER);

  // Reopening runs restoreCaseDraft again, now with the fields already filled.
  // This is the same call the connect-at-intent path makes as a late callback.
  await page.evaluate(() => window.fieldOpenForm());

  await expect(page.locator('#v2-case-title')).toHaveValue('Typed by the author');
  await expect(page.locator('#v2-case-summary')).toHaveValue(/public-safe summary the author typed/);
  await expect(page.locator('#v2-case-category')).toHaveValue('wallet_drain');
  // The feature itself still works: a blank field is still filled from the draft.
  await expect(page.locator('#v2-case-details')).toHaveValue(/Stale details that should still land/);
  expectClean(page);
});
