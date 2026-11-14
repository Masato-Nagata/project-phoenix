// Positive control: a non-relative import that the Comparator must not have.
import { readFileSync } from "node:fs";
export const read = readFileSync;