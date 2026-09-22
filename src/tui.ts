import { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";
import { parseOptions } from "./core/options.ts";
import { panelTranscriptFor, tuiTranscriptFor } from "./core/transcript.ts";
import { panelRender, PANEL_NAME, type PanelContent } from "./panel.tsx";

const TUI_COMMAND_ID = "agent-chat.view";

export default Plugin.define({
  id: "opencode-agent-chat",
  setup(context) {
    const options = parseOptions(context.options);
    let registered = false;
    const [panelContent, setPanelContent] = createSignal<PanelContent | null>(null);

    const stopPanel = context.ui.slot({
      append: "session.panel",
      render: panelRender(panelContent),
    });

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
                description: "Windowed transcript notice; `full` opens the full transcript panel",
                group: "Agent Chat",
                slash: { name: "agent-chat", arguments: true },
                palette: true,
                run: async (input?: string) => {
                  const route = context.ui.router.current();
                  if (route.type !== "session") {
                    context.ui.toast.show({ message: "agent-chat: no active session", variant: "warning" });
                    return;
                  }
                  const root = context.data.session.root(route.sessionID);
                  if (input?.trim() !== "full") {
                    let windowed;
                    try {
                      windowed = tuiTranscriptFor(options.chatDir, root);
                    } catch (err) {
                      const reason = err instanceof Error ? err.message : String(err);
                      context.ui.toast.show({ message: `agent-chat: ${reason}`, variant: "error" });
                      return;
                    }
                    if (windowed === null) {
                      context.ui.toast.show({ message: `agent-chat: no chat for this session`, variant: "warning" });
                      return;
                    }
                    await context.client.session.synthetic({
                      sessionID: route.sessionID,
                      text: windowed.label,
                      description: windowed.text,
                      metadata: { source: "agent-chat" },
                      resume: false,
                    });
                    return;
                  }
                  let full;
                  try {
                    full = panelTranscriptFor(options.chatDir, root);
                  } catch (err) {
                    const reason = err instanceof Error ? err.message : String(err);
                    context.ui.toast.show({ message: `agent-chat: ${reason}`, variant: "error" });
                    return;
                  }
                  if (full === null) {
                    context.ui.toast.show({ message: `agent-chat: no chat for this session`, variant: "warning" });
                    return;
                  }
                  setPanelContent({ root, total: full.total, text: full.text });
                  const opened = context.ui.panel.open(PANEL_NAME, { presentation: "fullscreen" });
                  if (!opened) {
                    context.ui.toast.show({ message: "agent-chat: could not open the panel", variant: "error" });
                  }
                },
              },
            ],
          }));
        }
        return null;
      },
    });

    return () => {
      stop();
      stopPanel();
    };
  },
});
