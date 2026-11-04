// bb-plugin-slackoff — frontend entry.
//
// Three surfaces, all kept current by the server's change signal:
// - the sidebar footer panel: Slackoff on/off, connection, mirrored threads and options;
// - the thread header: mirror this thread, and open it in Slack;
// - the settings page: step-by-step Slack app setup.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { SetupSection } from "./ui/setup-section.tsx";
import { SidebarPanel } from "./ui/sidebar-panel.tsx";
import { ThreadToggle } from "./ui/thread-toggle.tsx";

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "slackoff",
    label: "Slackoff",
    icon: "slackoff/mirror",
    component: SidebarPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "slack-mirror",
    title: "Slack mirror",
    component: ({ threadId }) => <ThreadToggle threadId={threadId} />,
  });
  app.slots.settingsSection({
    id: "setup",
    title: "Set up Slack",
    description: "Connect Slackoff to a Slack app you own. It takes about two minutes.",
    component: SetupSection,
  });
});
