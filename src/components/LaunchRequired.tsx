/**
 * What a surface shows in place of an action that needs a session.
 *
 * Two shapes for two positions. {@link LaunchRequired} replaces a whole panel - the send button and
 * everything around it - when nothing on it can work without a session. {@link LaunchRequiredNote}
 * is the inline version, for a surface that is otherwise usable and has one action that is not.
 *
 * Neither offers a sign-in control of its own, and that is deliberate. Choosing a server to launch
 * against is `Connect`'s job, it needs the issuer registry to do it, and duplicating that choice in
 * every corner of the app would give somebody two different-looking ways to do the same thing. These
 * say what is missing and why; the header says how to fix it.
 */

import type { ReactNode } from "react";

import { Alert } from "@/components/ui/alert";
import { LAUNCH_REQUIRED_MESSAGE } from "@/lib/config";

/**
 * A panel-sized explanation that this needs a session.
 * @param props.title what cannot be done
 * @param root0
 * @param root0.title
 * @param props.children the explanation, defaulting to the shared message
 * @param root0.children
 * @returns the alert
 */
export function LaunchRequired({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return <Alert title={title}>{children ?? LAUNCH_REQUIRED_MESSAGE}</Alert>;
}

/**
 * An inline explanation that one action here needs a session.
 * @param props.children the explanation, defaulting to the shared message
 * @param root0
 * @param root0.children
 * @returns the note
 */
export function LaunchRequiredNote({ children }: { children?: ReactNode }) {
  return (
    <p className="text-sm text-slate-500 dark:text-slate-400">
      {children ?? LAUNCH_REQUIRED_MESSAGE}
    </p>
  );
}
