import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/osi-payment-function-production.yml', 'utf8');
let passed = 0;
const ok = (name, condition) => {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log(`PASS: ${name}`);
};

ok('release is manual, main-only, and pinned to the exact production project',
  workflow.includes('workflow_dispatch:')
  && workflow.includes('DEPLOY-PAYMENT-FUNCTION-afibxpniwfnavdobecrn')
  && workflow.includes('CONFIRM_INPUT: ${{ github.event.inputs.confirm }}')
  && workflow.includes('[ "$CONFIRM_INPUT" = "DEPLOY-PAYMENT-FUNCTION-${EXPECTED_PROJECT_REF}" ]')
  && workflow.includes('[ "${GITHUB_REF}" = "refs/heads/main" ]')
  && workflow.includes('EXPECTED_PROJECT_REF: afibxpniwfnavdobecrn'));

ok('release proves dispatched HEAD is current origin/main',
  (workflow.match(/git rev-parse HEAD/g) || []).length >= 2
  && (workflow.match(/git rev-parse origin\/main/g) || []).length >= 2);

ok('validation runs the payment, UI, i18n, XSS, workflow, and Deno checks',
  ['osi-v2-payment.test.mjs', 'osi-v2-case-ui.test.js', 'osi-i18n.test.mjs',
    'osi-payment-function-production-workflow.test.mjs', 'xss-escaping.test.js',
    'deno check supabase/functions/osi-v2-payment/index.ts']
    .every((marker) => workflow.includes(marker)));

ok('remote Deno dependency validation has a bounded transient retry',
  workflow.includes('for attempt in $(seq 1 3); do')
  && workflow.includes('if deno check supabase/functions/osi-v2-payment/index.ts; then')
  && workflow.includes('[ "$attempt" -lt 3 ]'));

ok('deploy targets only the payment Edge Function and exact project',
  (workflow.match(/supabase functions deploy osi-v2-payment/g) || []).length === 1
  && (workflow.match(/supabase functions deploy/g) || []).length === 1
  && !workflow.includes('functions deploy osi-v2-analyst')
  && !workflow.includes('supabase db push')
  && !workflow.includes('supabase migration')
  && !workflow.includes('supabase link')
  && !workflow.includes('supabase secrets set')
  && !workflow.includes('supabase secrets unset')
  && !workflow.includes('supabase functions delete')
  && workflow.includes('--project-ref "$EXPECTED_PROJECT_REF" --no-verify-jwt --use-api'));

const actionRefs = [...workflow.matchAll(/^\s*uses:\s+([^\s#]+)/gm)].map((match) => match[1]);
ok('every third-party action is pinned to an exact commit',
  actionRefs.length >= 3 && actionRefs.every((ref) => /@[0-9a-f]{40}$/.test(ref)));

ok('smoke distinguishes the strict Solana Pay recovery operation from bad_op',
  workflow.includes('"op":"recover_solana_pay"')
  && workflow.includes('[ "$status" = "400" ]')
  && workflow.includes('"error":"bad_wallet"'));

ok('compatible frontend is proven before the backend deploy begins',
  workflow.includes('${WEB_URL}/assets/js/v2-case-integration.js?release=${GITHUB_SHA}')
  && workflow.includes('recover_solana_pay')
  && workflow.includes('Expired: do not scan')
  && workflow.includes('[[ "$asset" == *"recover_solana_pay"*')
  && !workflow.includes('echo "$asset" | grep -q')
  && workflow.indexOf('Prove the compatible frontend is already live')
    < workflow.indexOf('Deploy only osi-v2-payment'));

ok('database routing uses only the verified pinned regional poolers',
  workflow.includes('aws-0-ap-southeast-2.pooler.supabase.com aws-1-ap-southeast-2.pooler.supabase.com')
  && workflow.includes("PGCONNECT_TIMEOUT=8 psql -Atqc 'select 1'")
  && !workflow.includes('/config/database/pooler')
  && !workflow.includes('python3 -c'));

ok('release deploy and backend smoke have bounded step budgets',
  /- name: Deploy only osi-v2-payment\n\s+timeout-minutes: 4/.test(workflow)
  && /- name: Smoke strict recovery operation\n\s+id: backend_smoke\n\s+timeout-minutes: 4/.test(workflow));

ok('cleanup is scoped to an attempted but incomplete backend mutation',
  workflow.includes("steps.mutation.outputs.attempted == 'true'")
  && workflow.includes("steps.backend_smoke.outputs.complete != 'true'")
  && workflow.includes("needs.deploy.outputs.deploy_attempted == 'true'")
  && workflow.includes("needs.deploy.outputs.backend_complete != 'true'"));

ok('failed or cancelled mutation has in-job and separate fail-closed paths',
  workflow.includes("if: ${{ always() && needs.validate.result == 'success' }}")
  && workflow.includes('(failure() || cancelled())')
  && workflow.includes('needs: deploy')
  && workflow.includes("needs.deploy.result == 'failure'")
  && workflow.includes("needs.deploy.result == 'cancelled'")
  && workflow.includes('Fail closed after an incomplete function mutation')
  && workflow.includes('Disable Solana Pay after an interrupted mutation'));

ok('failure handling disables only the dedicated QR flag and verifies capabilities',
  (workflow.match(/update public\.osi_config set value='false'[^\n]+where key='OSI_V2_SOLANA_PAY_ENABLED'/g) || []).length === 2
  && !workflow.includes('OSI_V2_PAYMENT_WRITES_ENABLED')
  && !workflow.includes('git checkout --detach')
  && workflow.includes('"solana_pay_enabled":false')
  && workflow.includes('immutable_payment_rows=unchanged'));

ok('workflow cannot silently add broader or destructive database mutations',
  (workflow.match(/\bupdate\s+public\.osi_config\b/gi) || []).length === 3
  && (workflow.match(/\bupdate\s+/gi) || []).length === 3
  && !/\b(delete\s+from|truncate|drop\s+(table|schema|function)|alter\s+table)\b/i.test(workflow));

ok('a safe rerun can re-enable only Solana Pay after the strict route is live',
  workflow.indexOf('"error":"bad_wallet"')
    < workflow.indexOf("set value='true'")
  && (workflow.match(/set value='true'[^\n]+key='OSI_V2_SOLANA_PAY_ENABLED'/g) || []).length === 1
  && workflow.indexOf("set value='true'")
    < workflow.indexOf('"solana_pay_enabled":true'));

ok('backend completion is marked only after the strict operation smoke',
  workflow.indexOf("echo 'BACKEND_SMOKE_COMPLETE=true'")
    > workflow.indexOf('grep -q \'"error":"bad_wallet"\''));

if (!process.exitCode) console.log(`\n${passed} payment function production workflow checks passed.`);
