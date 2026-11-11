// CLI for the version-pinning check. Run from the repository root: npm run check:pins
// Tooling only; not imported by src/index.ts.

import { checkRepository } from "./versionPinning.js";

const result = checkRepository(process.cwd());
for (const f of result.findings) console.error(`FAIL [${f.kind}] ${f.message}`);
if (result.ok) {
  console.log(`Version pins OK: ${result.checked} manifest dependencies match docs/version-pinning.json and are verified.`);
} else {
  console.error(`Version pin check failed: ${result.findings.length} finding(s).`);
  process.exitCode = 1;
}
