import { fauxProvider, fauxAssistantMessage, getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FakeRegistry } from "./index-fixture.js";

/** Offline deployed-loader fixture. No credentials or remote requests. */
export default function (pi: ExtensionAPI): void {
  const registry = new FakeRegistry();
  const provider = fauxProvider({ provider: "cap-test", models: [{ id: "model", contextWindow: 400000, maxTokens: 64000, reasoning: true }] });
  provider.setResponses(Array.from({ length: 100 }, () => async (context, options, _state, model) => {
    const tools = getCurrentTools(context.messages);
    if (tools.some((tool) => tool.name === "submit_checkpoint" || tool.name === "submit_verdict")) {
      return registry.complete(model, { messages: context.messages.filter((message) => message.role !== "system"), tools }, options);
    }
    return fauxAssistantMessage("Incomplete native draft", { stopReason: "length" });
  }));
  pi.registerProvider(provider.provider);
  pi.registerCommand("cap-reload", {
    description: "Reload the isolated test runtime",
    handler: async (_args, ctx) => { await ctx.reload(); },
  });
}
