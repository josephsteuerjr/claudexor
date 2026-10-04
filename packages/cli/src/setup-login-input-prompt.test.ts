import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { promptLoginInput } from "./setup-login-input-prompt.js";

describe("real readline sign-in prompt", () => {
  it("reads one line without storing or echoing its value on a pipe", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk) => written.push(String(chunk)));
    const value = promptLoginInput("Code: ", new AbortController().signal, { input, output });
    input.write("one-time-secret\n");
    expect(await value).toBe("one-time-secret");
    expect(written.join("")).toBe("Code: ");
    expect(input.listenerCount("data")).toBe(0);
    input.destroy();
    output.destroy();
  });

  it.each(["abort", "eof"])("settles and detaches its reader on %s", async (action) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    const value = promptLoginInput("Code: ", controller.signal, { input, output });
    if (action === "abort") controller.abort();
    else input.end();
    expect(await value).toBeNull();
    expect(input.listenerCount("data")).toBe(0);
    input.destroy();
    output.destroy();
  });

  it("hands a real terminal Ctrl-C to the follower's detach handler", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const controller = new AbortController();
    let interrupted = false;
    const detach = () => {
      interrupted = true;
      controller.abort();
    };
    process.once("SIGINT", detach);
    try {
      const value = promptLoginInput("Code: ", controller.signal, { input, output });
      input.write("\u0003");
      expect(await value).toBeNull();
      expect(interrupted).toBe(true);
      // Node retains its shared keypress decoder on terminal streams; the
      // readline consumer itself must have detached.
      expect(input.listenerCount("keypress")).toBe(0);
    } finally {
      process.removeListener("SIGINT", detach);
      input.destroy();
      output.destroy();
    }
  });
});
