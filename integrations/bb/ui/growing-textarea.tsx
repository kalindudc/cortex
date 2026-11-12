import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, type ComponentProps } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import "./knowledge-editor.css";

type GrowingTextareaProps = Omit<ComponentProps<typeof Textarea>, "value" | "rows"> & { value: string; open?: boolean };

export const GrowingTextarea = forwardRef<HTMLTextAreaElement, GrowingTextareaProps>(
  ({ value, open = true, className, ...props }, ref) => {
    const element = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => element.current!, []);
    const measure = useCallback(() => {
      const field = element.current;
      if (!field) return;
      field.style.height = "auto";
      const style = window.getComputedStyle(field);
      const border = (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0);
      const minimum = Number.parseFloat(style.minHeight) || 0;
      const maximum = style.maxHeight === "none" || style.maxHeight === "" ? Infinity : Number.parseFloat(style.maxHeight);
      field.style.height = `${Math.max(minimum, Math.min(field.scrollHeight + border, maximum))}px`;
    }, []);
    useLayoutEffect(() => {
      if (open) measure();
    }, [value, open, measure]);
    useLayoutEffect(() => {
      const field = element.current;
      if (!open || !field) return;
      window.addEventListener("resize", measure);
      window.visualViewport?.addEventListener("resize", measure);
      let width = field.getBoundingClientRect().width;
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(entries => {
        const nextWidth = entries[0]?.contentRect.width;
        // Height changes are our own; only width changes need another wrapping measurement.
        if (nextWidth !== undefined && nextWidth !== width) {
          width = nextWidth;
          measure();
        }
      });
      observer?.observe(field);
      return () => {
        window.removeEventListener("resize", measure);
        window.visualViewport?.removeEventListener("resize", measure);
        observer?.disconnect();
      };
    }, [open, measure]);
    return <Textarea {...props} ref={element} value={value} rows={6} className={cn("cortex-growing-textarea", className)} />;
  },
);
GrowingTextarea.displayName = "GrowingTextarea";
