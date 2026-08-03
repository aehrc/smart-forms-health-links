import type { ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Alert({
  tone = 'info',
  title,
  children,
  className
}: {
  tone?: 'info' | 'warning' | 'error';
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: 'border-slate-200 bg-slate-50 text-slate-700',
    warning: 'border-amber-300 bg-amber-50 text-amber-900',
    error: 'border-red-300 bg-red-50 text-red-900'
  } as const;

  const Icon = tone === 'info' ? Info : AlertTriangle;

  return (
    <div className={cn('flex gap-3 rounded-md border p-3 text-sm', tones[tone], className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn(title && 'mt-1')}>{children}</div> : null}
      </div>
    </div>
  );
}
