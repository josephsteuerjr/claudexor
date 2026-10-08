import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DaemonTransportError } from "../../daemon/src/client-errors.js";
import { DaemonControlApiServer } from "./daemon-server.js";
import type { DaemonFacadeClient } from "./run-record.js";

/** Exercise both body-resolution/preflight catches and the enqueue boundary. */
describe("run-start transport and problem preservation", () => {
  it.each(["body", "preflight", "enqueue"])(
    "keeps %s transport errors 503 and validation 400",
    async (stage) => {
      let fail = true;
      let reads = 0;
      const daemon: DaemonFacadeClient = {
        list: async () => {
          reads++;
          if (
            fail &&
            ((stage === "body" && reads === 1) || (stage === "preflight" && reads === 2))
          ) {
            throw new DaemonTransportError("claudexor.list", "timeout");
          }
          return [
            {
              id: "job-old",
              runId: "run-old",
              state: "failed",
              params: { mode: "ask", scope: { kind: "none" } },
            },
          ];
        },
        enqueue: async () => {
          if (fail && stage === "enqueue")
            throw new DaemonTransportError("claudexor.enqueue", "unavailable");
          return { id: "job-next", state: "queued" };
        },
        status: async () => ({
          id: "job-next",
          state: "running",
          runId: "run-next",
          runDir: process.env.CLAUDEXOR_CONFIG_DIR!,
          taskId: "task-next",
          params: {},
        }),
        cancel: async () => ({}),
      };
      await withServer(daemon, async (post) => {
        const failed = await post({ continueFrom: "run-old", prompt: "continue" });
        expect(failed.status).toBe(503);
        expect(await failed.json()).toMatchObject({
          code: stage === "enqueue" ? "daemon_unavailable" : "daemon_busy",
          retryable: true,
        });
        fail = false;
        expect((await post({ prompt: " " })).status).toBe(400);
        expect((await post({ continueFrom: "run-old", prompt: "continue" })).status).toBe(200);
      });
    },
  );

  it.each([404, 409])("keeps a daemon-authored %i and its head at enqueue", async (status) => {
    const code = status === 404 ? "predecessor_unknown" : "continuation_superseded";
    const daemon: DaemonFacadeClient = {
      list: async () => [],
      enqueue: async () => {
        throw Object.assign(new Error("typed refusal"), {
          status,
          code,
          retryable: false,
          context: { head: "run-head" },
          requiredActions: ["continue_head"],
        });
      },
      status: async () => ({ id: "job", state: "queued" }),
      cancel: async () => ({}),
    };
    await withServer(daemon, async (post) => {
      const response = await post({ mode: "ask", scope: { kind: "none" }, prompt: "explain" });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({
        code,
        retryable: false,
        context: { head: "run-head" },
        requiredActions: ["continue_head"],
      });
    });
  });
});

async function withServer(
  daemon: DaemonFacadeClient,
  run: (post: (body: unknown) => Promise<Response>) => Promise<void>,
) {
  const token = randomUUID();
  const server = new DaemonControlApiServer({ token, daemon, pollMs: 5 });
  const { host, port } = await server.start();
  try {
    await run((body) =>
      fetch(`http://${host}:${port}/v2/runs`, {
        method: "POST",
        headers: {
          authorization: ["Bearer", token].join(" "),
          "content-type": "application/json",
          "X-Claudexor-Protocol-Major": "3",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify(body),
      }),
    );
  } finally {
    await server.stop();
  }
}
