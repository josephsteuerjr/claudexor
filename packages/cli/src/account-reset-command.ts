import { flagStr, type ParsedArgs } from "./args.js";
import { print, printJson } from "./cli-io.js";
import { renderCliFailure } from "./cli-error.js";
import { accountResourceQuery, parseAccountTarget } from "./account-resource-query.js";

export async function accountResetCommand(args: ParsedArgs, json: boolean): Promise<number> {
  try {
    const operation = flagStr(args, "operation");
    if (
      operation &&
      (args._[1] ||
        flagStr(args, "offer") ||
        flagStr(args, "grant") ||
        flagStr(args, "idempotency-key"))
    )
      throw new Error("--operation cannot be combined with a reset request");
    const value = operation
      ? await accountResourceQuery("reset", { operation_id: operation })
      : await accountResourceQuery("reset", {
          target: parseAccountTarget(args._[1] ?? ""),
          offer_id: flagStr(args, "offer") ?? "",
          grant_id: flagStr(args, "grant"),
          idempotency_key: flagStr(args, "idempotency-key") ?? "",
        });
    if (json) printJson(value);
    else
      print(
        `${value.id}: ${value.outcome}; resource readback: ${value.readback.state}${value.detail ? ` (${value.detail})` : ""}`,
      );
    return ["unknown", "already_used", "unavailable"].includes(value.outcome) ? 1 : 0;
  } catch (error) {
    return renderCliFailure(json, error, { messagePrefix: "claudexor account-reset:" });
  }
}
