// Positive control for the adapter isolation test: a module that reaches a process API and a file-write API.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
export const leak = (): void => {
  writeFileSync("x", execSync("echo"));
};