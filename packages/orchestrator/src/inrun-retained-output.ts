/** Evidence survives answer resets; rejected session output is never evidence. */
import { acceptedTryOutput, type AnswerAssembly } from "@claudexor/core";
import type { ContinuityIdentityCheck } from "@claudexor/schema";

export class RetainedAttemptOutput {
  private readonly tries: string[] = [];

  add(answer: AnswerAssembly, errored: boolean, identity: ContinuityIdentityCheck): void {
    if (identity === "mismatch_before_effects" || identity === "mismatch_after_possible_effects")
      return;
    const text = errored && !answer.hasFinal() ? answer.text() : acceptedTryOutput(answer, errored);
    if (text) this.tries.push(text);
  }

  text(): string {
    return this.tries.join("\n\n");
  }
}
