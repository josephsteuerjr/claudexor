import { describe, expect, it } from "vitest";
import { spawnProcess } from "./proc.js";

const limits = { stdoutFrameBytes: 64, queuedFrames: 2, stderrBytes: 16 };
const capture = async (source: string) => {
  const events = [];
  for await (const event of spawnProcess(process.execPath, ["-e", source], {
    streamLimits: limits,
  }))
    events.push(event);
  return events;
};
describe("bounded process frames", () => {
  it("preserves CRLF and drains a bounded stderr tail", async () => {
    const events = await capture(
      'process.stdout.write("{}\\r\\n"); process.stderr.write("x".repeat(100)+"tail")',
    );
    expect(events.find((e) => e.type === "stdout")).toMatchObject({ line: "{}\r", wire: "{}\r\n" });
    expect(events.find((e) => e.type === "stderr")).toMatchObject({ line: "xxxxxxxxxxxxtail" });
  });
  it.each([
    ['process.stdout.write("x".repeat(65))', "exceeds byte limit"],
    ['process.stdout.write("{}")', "truncated frame"],
    ["process.stdout.write(Buffer.from([255,10]))", "not valid"],
  ])("rejects invalid framing: %s", async (source, error) => {
    await expect(capture(source)).rejects.toThrow(error);
  });
  it("backpressures a burst without losing frames", async () => {
    const iterator = spawnProcess(
      process.execPath,
      ["-e", 'for(let i=0;i<200;i++) process.stdout.write(i+"\\n")'],
      { streamLimits: limits },
    );
    const lines = [];
    for await (const event of iterator) {
      if (event.type === "stdout") lines.push(event.line);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(lines).toEqual(Array.from({ length: 200 }, (_, i) => String(i)));
  });
});
