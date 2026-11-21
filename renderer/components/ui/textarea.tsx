import * as React from "react";
import { cn } from "../../lib/cn";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

/** A multi-line `Input`: the same field, so a prompt box and a name box read as one family. */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn(
        "block min-h-[74px] w-full resize-y rounded-md border border-line-strong bg-field",
        "px-2.5 py-2 text-footnote text-fg placeholder:text-gray-a8",
        "transition-colors focus:outline-none focus:border-focus focus:ring-1 focus:ring-focus",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";
