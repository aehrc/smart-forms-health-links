import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The one way this app says "working on it".
 *
 * Every surface that reads through the proxy shows this while the read is outstanding, so that
 * no screen is ever briefly blank and no two screens say it differently (Nielsen heuristic 1).
 * @param root0 the component props
 * @param root0.children what is being waited for, in words
 * @param root0.className extra classes, for surfaces that need less vertical space
 * @returns the status line
 * @author John Grimes
 */
export function Loading({
  children,
  className,
}: Readonly<{ children: React.ReactNode; className?: string }>) {
  return (
    <p
      className={cn(
        "flex items-center gap-2 py-8 text-sm text-slate-500 dark:text-slate-400",
        className,
      )}
      role="status"
    >
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {children}
    </p>
  );
}
