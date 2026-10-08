import { expect, it } from "vitest";
import { selectDaemonHeap } from "./daemon-heap.js";

const GiB = 2 ** 30;
it.each([
  [128, 0, 4, ["--max-old-space-size=16384"], "physical"],
  [16, 0, 4, ["--max-old-space-size=8192"], "physical"],
  [8, 0, 3, ["--max-old-space-size=4096"], "physical"],
  [8, 0, 4, [], "physical"],
  [128, 2, 4, [], "cgroup"],
  [128, 16, 4, ["--max-old-space-size=8192"], "cgroup"],
  // A cgroup limit at or above physical memory is no constraint.
  [8, 8, 2, ["--max-old-space-size=4096"], "physical"],
] as const)(
  "selects capacity for host=%s GiB, cgroup=%s GiB, default=%s GiB",
  (host, cgroup, baseline, args, source) => {
    expect(
      selectDaemonHeap({
        physicalMemoryBytes: host * GiB,
        constrainedMemoryBytes: cgroup * GiB,
        defaultHeapLimitBytes: baseline * GiB,
      }),
    ).toEqual({
      nodeArgs: args,
      basis: { memoryBytes: (source === "cgroup" ? cgroup : host) * GiB, source },
    });
  },
);

it("reads an unlimited Linux cgroup (UINT64_MAX) as no constraint", () => {
  expect(
    selectDaemonHeap({
      physicalMemoryBytes: 8 * GiB,
      constrainedMemoryBytes: 2 ** 64,
      defaultHeapLimitBytes: 2 * GiB,
    }),
  ).toEqual({
    nodeArgs: ["--max-old-space-size=4096"],
    basis: { memoryBytes: 8 * GiB, source: "physical" },
  });
});

it.each([
  "--max-old-space-size=2048",
  "--max-old-space-size 2048",
  "--max_old_space_size=2048",
  '--trace-warnings "--max-old-space-size=2048"',
])("honors operator NODE_OPTIONS %s", (nodeOptions) => {
  const input = {
    physicalMemoryBytes: 128 * GiB,
    constrainedMemoryBytes: 0,
    defaultHeapLimitBytes: 4 * GiB,
  };
  expect(selectDaemonHeap({ ...input, nodeOptions }).nodeArgs).toEqual([]);
  expect(selectDaemonHeap({ ...input, nodeOptions: "--trace-warnings" }).nodeArgs).toEqual([
    "--max-old-space-size=16384",
  ]);
});
