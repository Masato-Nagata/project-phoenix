import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    // Measured on 2026-11-15 (16 logical CPUs, about 3.8 GB memory in the toolchain container): with the default worker count, three full
    // runs in a row had 1 to 2 tests exceed the 5 s default timeout (different tests each time, each passing alone in 1 to 1.5 s);
    // with 4 workers, two full runs in a row passed all tests. Test time added up to about 285 s with the default and about 102 s
    // with 4 workers. Whether CPU or memory is the dominant limit is NOT established. The test timeout is left at its default.
    maxWorkers: 4,
  },
});
