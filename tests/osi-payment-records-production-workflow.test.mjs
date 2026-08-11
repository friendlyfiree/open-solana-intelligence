import assert from "node:assert/strict";
import fs from "node:fs";

const path = new URL(
  "../.github/workflows/osi-payment-records-production.yml",
  import.meta.url,
);
const source = fs.readFileSync(path, "utf8");
let passed = 0;

function has(name, pattern) {
  assert.match(source, pattern, name);
  passed += 1;
}

function before(name, first, second) {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  assert.ok(a >= 0 && b > a, name);
  passed += 1;
}

has("manual production dispatch", /^on:\n  workflow_dispatch:/m);
has(
  "exact project confirmation",
  /DEPLOY-PAYMENT-RECORDS-afibxpniwfnavdobecrn/,
);
has(
  "only verified regional pooler generations",
  /aws-0-ap-southeast-2\.pooler\.supabase\.com aws-1-ap-southeast-2\.pooler\.supabase\.com/,
);
has(
  "fallback probe receives the full exact database identity",
  /PGHOST="\$candidate" PGPORT="\$PGPORT" PGUSER="\$PGUSER"[\s\S]*PGDATABASE="\$PGDATABASE" PGPASSWORD="\$PGPASSWORD"[\s\S]*psql -Atqc 'select 1'/,
);
has(
  "dry-run uses the resolved explicit route",
  /supabase db push[\s\S]*--db-url "postgresql:\/\/\$\{PGUSER\}@\$\{PGHOST\}:\$\{PGPORT\}\/\$\{PGDATABASE\}"[\s\S]*--include-all --dry-run/,
);
has(
  "apply uses the same resolved explicit route",
  /supabase db push[\s\S]*--include-all --yes/,
);
before(
  "rollback marker precedes the independently committed migration apply",
  "echo 'MIGRATION_APPLY_STARTED=true'",
  '--password "$SUPABASE_DB_PASSWORD" --include-all --yes',
);
before(
  "full rollout marker follows the Vercel asset smoke",
  "Wait for the exact merged Vercel assets",
  "echo 'ROLLOUT_COMPLETE=true'",
);
has(
  "any incomplete apply fails both payment surfaces closed",
  /if: failure\(\) && env\.MIGRATION_APPLY_STARTED == 'true' && env\.ROLLOUT_COMPLETE != 'true'[\s\S]*OSI_V2_MAINTAINER_SUPPORT_ENABLED','OSI_V2_SOLANA_PAY_ENABLED/,
);
has(
  "receipt exposes start and completion state",
  /migration_apply_started=\$\{MIGRATION_APPLY_STARTED\}[\s\S]*rollout_complete=\$\{ROLLOUT_COMPLETE\}/,
);

console.log(`passed ${passed}`);
