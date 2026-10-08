import { expect, it } from "vitest";
import { effectiveNodeHeapArgs } from "./node-heap-args.js";

it("reports only the effective heap setting, with command-line precedence and Node aliases", () => {
  expect(effectiveNodeHeapArgs([], "--trace-warnings")).toEqual([]);
  expect(effectiveNodeHeapArgs([], '--trace-warnings --max-old-space-size="2048"')).toEqual([
    "--max-old-space-size=2048",
  ]);
  expect(
    effectiveNodeHeapArgs(
      ["--max_old_space_size", "4096", "--max-old-space-size=8192"],
      "--max-old-space-size=2048",
    ),
  ).toEqual(["--max-old-space-size=8192"]);
  expect(effectiveNodeHeapArgs([], '"--max-old-space-size=3072"')).toEqual([
    "--max-old-space-size=3072",
  ]);
});
