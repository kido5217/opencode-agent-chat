import { Plugin } from "@opencode/plugin/tui";
import { parseOptions } from "./core/options.ts";
import { transcriptFor } from "./core/transcript.ts";

const TUI_COMMAND_ID = "agent-chat.view";

export default Plugin.define({
  id: "opencode-agent-chat",
  setup(context) {
    const options = parseOptions(context.options);
    let registered = false;

    const stop = context.ui.slot({
      append: "app",
      render: () => {
        if (!registered) {
          registered = true;
          context.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: TUI_COMMAND_ID,
                title: "View the agent chat",
                group: "Agent Chat",
                slash: { name: "agent-chat" },
                run: async () => {
                  const route = context.ui.router.current();
                  if (route.type !== "session") {
                    context.ui.toast.show({ message: "agent-chat: no active session", variant: "warning" });
                    return;
                  }
                  const root = context.data.session.root(route.sessionID);
                  let text: string | null;
                  try {
                    text = transcriptFor(options.chatDir, root);
                  } catch (err) {
                    const reason = err instanceof Error ? err.message : String(err);
                    context.ui.toast.show({ message: `agent-chat: ${reason}`, variant: "error" });
                    return;
                  }
                  if (text === null) {
                    context.ui.toast.show({ message: `agent-chat: no chat for this session`, variant: "warning" });
                    return;
                  }
                  await context.client.session.synthetic({
                    sessionID: route.sessionID,
                    text: `agent-chat transcript for ${root}`,
                    description: text,
                    metadata: { source: "agent-chat" },
                    resume: false,
                  });
                },
              },
            ],
          }));
        }
        return null;
      },
    });

    return () => stop();
  },
});
