// Positive control: a non-relative import that the Source_Bundler must not have, and a README.md import.
import { readFileSync } from "node:fs";
import "./docs/README.md";
export const read = readFileSync;