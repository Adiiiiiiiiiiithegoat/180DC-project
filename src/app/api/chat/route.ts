import {
  APICallError,
  createAgentUIStream,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { createAssistant } from "@/lib/assistant";
import { unauthorized } from "@/lib/http";
import { sessionUserId } from "@/lib/session";

/**
 * The assistant. A route handler, so the model call, the Groq key and every
 * tool execution happen here on the server; the browser only ever receives
 * the streamed messages. The user id comes from the session cookie and is
 * handed to createAssistant, which binds it into the tools — nothing the
 * browser sends can name a different account.
 */
export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const body = (await request.json().catch(() => null)) as { messages?: unknown } | null;
  if (!Array.isArray(body?.messages)) {
    return Response.json({ error: "invalid_input", message: "messages must be an array" }, { status: 400 });
  }
  const uiMessages = body.messages;

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Rate-limit waits go to the browser as transient parts: shown while
      // they matter, never saved into the conversation.
      const agent = createAssistant(userId, (busy) =>
        writer.write({ type: "data-busy", data: busy, transient: true }),
      );
      writer.merge(await createAgentUIStream({ agent, uiMessages, abortSignal: request.signal }));
    },
    onError: (error) => {
      if (APICallError.isInstance(error) && error.statusCode === 429) {
        return "The free-tier model has hit its usage limit for now. Wait a minute or two and ask again.";
      }
      console.error(error);
      return "Something went wrong reaching the model. Try again.";
    },
  });
  return createUIMessageStreamResponse({ stream });
}
