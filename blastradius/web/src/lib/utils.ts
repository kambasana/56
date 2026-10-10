import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * The type scale tokens (text-title … text-eyebrow in index.css) are font sizes. Without this,
 * tailwind-merge reads `text-label` as a colour and drops e.g. `text-primary-foreground` from a
 * Button given `className="text-label"`, leaving dark text on a dark button.
 */
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["title", "heading", "body", "label", "caption", "eyebrow"] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
