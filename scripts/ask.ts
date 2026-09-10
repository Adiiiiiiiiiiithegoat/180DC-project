/**
 * Ask the assistant one question from the terminal and print what it did:
 * every tool call with its input, token usage per model call, the answer.
 * The same createAssistant the chat route uses — same model, same tools,
 * same instructions — bound to the demo account.
 *
 *   npx tsx --conditions=react-server scripts/ask.ts --env .env.development.local "what's running low?"
 *
 * Add --approve to approve a proposed updateProductSettings call and let the
 * turn finish; without it the script stops at the approval request, which is
 * exactly where the chat UI shows its Approve / Decline card.
 *
 * --conditions=react-server lets tsx load a file marked `server-only`.
 */
import "./env";
import { sql } from "drizzle-orm";
import type { ModelMessage, ToolApprovalResponse } from "ai";
import { db, pool } from "../src/db";
import { createAssistant } from "../src/lib/assistant";
import { DEMO } from "./seed-account";

const args = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--env");
const question = args.join(" ");
const approve = process.argv.includes("--approve");

async function main() {
  const [user] = (await db.execute<{ id: string }>(sql`SELECT id FROM users WHERE email = ${DEMO.email}`)).rows;
  const agent = createAssistant(user.id, (busy) =>
    console.log(busy.state === "waiting" ? `  [busy: rate limited, retrying in ${busy.seconds}s]` : "  [resumed]"),
  );

  const messages: ModelMessage[] = [{ role: "user", content: question }];
  console.log(`\nQ: ${question}\n`);

  for (let turn = 0; turn < 2; turn++) {
    const result = await agent.generate({ messages });
    for (const [i, step] of result.steps.entries()) {
      console.log(`  step ${i + 1}: ${step.usage.inputTokens} in / ${step.usage.outputTokens} out tokens`);
      for (const call of step.toolCalls) console.log(`    -> ${call.toolName}(${JSON.stringify(call.input)})`);
      for (const r of step.toolResults) console.log(`    <- ${r.toolName}: ${JSON.stringify(r.output).slice(0, 300)}`);
    }
    messages.push(...result.response.messages);

    const approvals = result.content.filter((p) => p.type === "tool-approval-request");
    if (approvals.length === 0) {
      console.log(`\nA: ${result.text}\n`);
      break;
    }
    for (const a of approvals) {
      console.log(`\n  APPROVAL REQUESTED: ${a.toolCall.toolName}(${JSON.stringify(a.toolCall.input)})`);
    }
    if (result.text) console.log(`\nA (before approval): ${result.text}`);
    if (!approve) {
      console.log("  (stopping: nothing is written until someone approves)\n");
      break;
    }
    console.log("  --approve given: approving\n");
    messages.push({
      role: "tool",
      content: approvals.map(
        (a): ToolApprovalResponse => ({ type: "tool-approval-response", approvalId: a.approvalId, approved: true }),
      ),
    });
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
