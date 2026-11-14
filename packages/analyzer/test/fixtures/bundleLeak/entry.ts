// Positive control for the isolation test: a module that reaches a directory named like a forbidden location.
import { secret } from "./evaluation/secret.js";
export const leaked = secret;