/** The desktop's proportions for the viewer ("1600x900" → "1600 / 900"); undefined: the default 16/10. */
export function desktopAspect(size: string | undefined): string | undefined {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(size ?? "");
  return m ? `${m[1]} / ${m[2]}` : undefined;
}
