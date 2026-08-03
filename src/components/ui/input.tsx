import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm',
          'placeholder:text-slate-400',
          'focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none',
          className
        )}
        {...props}
      />
    );
  }
);
