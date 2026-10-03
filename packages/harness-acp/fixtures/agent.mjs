// Offline protocol peer. None of these scenarios contacts Copilot or spends credits.
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import { AcpServer } from "@claudexor/acp-server";
import { createFakeHarness } from "@claudexor/harness-fake";
import { HarnessRunSpec } from "@claudexor/schema";

const [mode, fixture, log] = process.argv.slice(2);
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const note = (value) => {
  if (log) appendFileSync(log, `${JSON.stringify(value)}\n`);
};
const fake = createFakeHarness("fake-success");
const runFake = async (params, hooks) => {
  if (params.mode === "__acp_session_new") return { sessionId: "native", cwd: params.repoPath };
  for await (const event of fake.run(
    HarnessRunSpec.parse({
      session_id: "native",
      cwd: process.cwd(),
      prompt: params.prompt,
      intent: "explain",
    }),
  ))
    hooks?.onEvent?.({ type: "harness.event", payload: event });
  return { status: "succeeded", output: { kind: "text", text: "Done from harness-fake." } };
};
if (mode === "server") {
  await new AcpServer({
    runner: runFake,
    transport: { read: process.stdin, write: process.stdout },
  }).serve();
} else if (mode === "fake") {
  const connection = acp
    .agent({ name: "offline-fake" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
    }))
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "native" }))
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      for await (const event of fake.run(
        HarnessRunSpec.parse({
          session_id: "native",
          cwd: process.cwd(),
          prompt: params.prompt[0].text,
          intent: "explain",
        }),
      )) {
        if (event.type === "message")
          await client.notify(acp.methods.client.session.update, {
            sessionId: "native",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: event.text },
            },
          });
      }
      return { stopReason: "end_turn" };
    })
    .connect(
      acp.ndJsonStream(
        (await import("node:stream")).Writable.toWeb(process.stdout),
        (await import("node:stream")).Readable.toWeb(process.stdin),
      ),
    );
  await connection.closed;
} else {
  const lines = fixture ? readFileSync(fixture, "utf8").trimEnd().split("\n") : [];
  const pending = new Map();
  const sendRecord = async (line, id) => {
    const frame = JSON.parse(line);
    if (frame.method === "session/request_permission") {
      const done = new Promise((resolve) => pending.set(frame.id, resolve));
      process.stdout.write(`${line}\n`);
      await done;
    } else if (frame.id !== undefined) write({ ...frame, id });
    else process.stdout.write(`${line}\n`);
  };
  const dispatch = async (message) => {
    note({ method: message.method, params: message.params, result: message.result });
    if (!message.method) {
      pending.get(message.id)?.();
      pending.delete(message.id);
      return;
    }
    if (message.method === "initialize") {
      if (mode === "protocol")
        return write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 9000 } });
      await sendRecord(
        lines[0] ??
          JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: 1, agentInfo: { name: "fixture", version: "1.0.91" } },
          }),
        message.id,
      );
    } else if (message.method === "session/new") {
      if (mode === "auth")
        return write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "Authentication required" },
        });
      await sendRecord(
        lines[1] ?? '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"native"}}',
        message.id,
      );
    } else if (message.method === "session/prompt") {
      if (mode === "disconnect") return process.exit(7);
      if (mode === "oversize") return process.stdout.write("x".repeat(8 * 1024 * 1024 + 1));
      if (mode === "malformed") return process.stdout.write("{broken}\n");
      if (mode === "hang") {
        process.on("SIGINT", () => {});
        const child = spawn(
          process.execPath,
          ["-e", 'process.on("SIGINT",()=>{});setInterval(()=>{},1000)'],
          { stdio: "ignore" },
        );
        note({ pid: process.pid, child: child.pid });
        return;
      }
      if (mode === "environment")
        write({ jsonrpc: "2.0", method: "fixture/environment", params: process.env });
      for (const line of lines.slice(2)) await sendRecord(line, message.id);
    }
  };
  const reader = createInterface({ input: process.stdin });
  for await (const line of reader) void dispatch(JSON.parse(line));
}
