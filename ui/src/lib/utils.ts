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
      shadow: ["control", "card", "raised", "dialog", "glow", "glow-strong", "button-primary", "button-primary-hover"],
      radius: ["card", "control", "badge", "pill", "avatar", "dialog"],
      blur: ["surface", "overlay", "glow"],
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
