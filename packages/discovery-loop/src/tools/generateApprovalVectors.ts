// Writes the Approval_Store golden vectors to a directory (task 1.16). Tooling only; not part of the runtime.
// Usage (inside the pinned toolchain container): node dist/tools/generateApprovalVectors.js <output-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateApprovalVectors } from "../approval/vectors.js";

const out = process.argv[2];
if (out === undefined || out === "") {
  process.stderr.write("usage: generateApprovalVectors <output-dir>\n");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
for (const [name, content] of Object.entries(generateApprovalVectors())) {
  // 2-space JSON, LF, one trailing newline. Line endings do not matter for the data (all text is inside JSON strings).
  writeFileSync(join(out, name), `${JSON.stringify(content, null, 2)}\n`, "utf8");
}
