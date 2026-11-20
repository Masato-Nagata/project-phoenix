// Deterministic identifiers of one Run (task 4.4, unit U6a; R22.2).
//
// `createIdCounters()` builds the counters of ONE Run. There is no module state: two factories share nothing, and the same call order gives the
// same sequence. Formats (design, "Identifiers (R22.2)"):
//   hypothesis   hyp-<n>          no padding (hyp-1, hyp-2)
//   claim        clm-<nnnn>       the counter with 4 digits and leading zeros (clm-0001); assigned in order of appearance by the caller
//   experiment   exp-<iteration>-<n>   `n` restarts at 1 for each iteration
//   evidence     evd-<n>          no padding
// Claim REVISION ids (`<claimId>-r<n>`) are NOT produced here: only `EvidenceStore.createClaimRevision` makes them.
// Every produced id matches the common Id pattern `^[a-z][a-z0-9-]{0,63}$`.

/** The text of the one throw of this file: an iteration that is not a non-negative safe integer is a defect of the caller. */
export const INVALID_ITERATION_MESSAGE = "invalid iteration number";

export interface IdCounters {
  nextHypothesisId(): string;
  nextClaimId(): string;
  /** `iteration` must be a non-negative safe integer (throws a fixed-text RangeError otherwise). */
  nextExperimentId(iteration: number): string;
  nextEvidenceId(): string;
}

export function createIdCounters(): IdCounters {
  let hypothesis = 0;
  let claim = 0;
  let evidence = 0;
  const experiments = new Map<number, number>();
  return Object.freeze({
    nextHypothesisId(): string {
      hypothesis += 1;
      return `hyp-${hypothesis}`;
    },
    nextClaimId(): string {
      claim += 1;
      return `clm-${String(claim).padStart(4, "0")}`;
    },
    nextExperimentId(iteration: number): string {
      if (typeof iteration !== "number" || !Number.isSafeInteger(iteration) || iteration < 0) throw new RangeError(INVALID_ITERATION_MESSAGE);
      const n = (experiments.get(iteration) ?? 0) + 1;
      experiments.set(iteration, n);
      return `exp-${iteration}-${n}`;
    },
    nextEvidenceId(): string {
      evidence += 1;
      return `evd-${evidence}`;
    },
  });
}
