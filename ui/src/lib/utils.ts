import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * tailwind-merge, told about the theme's own scales (index.css): without it `text-h1` or
 * `text-label` would read as a text colour and `cn("text-h1", "text-muted-foreground")` would drop
 * one of them.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["display", "h1", "h2", "h3", "body", "small", "caption", "micro"],
      leading: ["display", "h1", "h2", "h3", "body", "small", "caption", "micro"],
      tracking: ["heading", "label"],
      shadow: ["card", "raised"],
    },
    classGroups: {
      "font-size": ["text-label"],
      "font-family": ["font-heading"],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
