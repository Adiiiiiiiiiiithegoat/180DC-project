import { Chat } from "@/components/chat";
import { card } from "@/components/ui";
import { requireUserId } from "@/lib/session";

export default async function AssistantPage() {
  await requireUserId();
  return (
    <section className={card}>
      <h1 className="text-lg font-semibold">Assistant</h1>
      <p className="mb-4 text-sm text-stone-500">
        Answers come from your shop&apos;s data. It can change reorder points, prices and whether a product is
        active, only after you approve each change. It can never change stock.
      </p>
      <Chat />
    </section>
  );
}
