import { AlertTriangle, Info } from "lucide-react";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 *
 * @param root0
 * @param root0.tone
 * @param root0.title
 * @param root0.children
 * @param root0.className
 */
export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: "info" | "warning" | "error";
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
    warning:
      "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
    error:
      "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
  } as const;

  const Icon = tone === "info" ? Info : AlertTriangle;

  return (
    <div
      className={cn(
        "flex gap-3 rounded-md border p-3 text-sm",
        tones[tone],
        className,
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? (
          <div className={cn(title && "mt-1")}>{children}</div>
        ) : null}
      </div>
    </div>
  );
}
