import { Group, Panel, Separator } from "react-resizable-panels";
import { cn } from "@/lib/utils";

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof Group>) {
  return <Group className={cn("h-full w-full", className)} {...props} />;
}

function ResizablePanel(props: React.ComponentProps<typeof Panel>) {
  return <Panel {...props} />;
}

function ResizableHandle({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      className={cn(
        "relative group/handle bg-transparent hover:bg-primary/8 [&[data-separator=active]]:bg-primary/12 transition-colors",
        className,
      )}
      {...props}
    >
      {/* Thin vertical line — grows on hover/drag */}
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border group-hover/handle:w-[3px] group-hover/handle:bg-primary/30 [[data-separator=active]_&]:w-[3px] [[data-separator=active]_&]:bg-primary/50 rounded-full transition-all pointer-events-none" />
      {/* Center dot cluster — subtle drag affordance */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-[3px] opacity-0 group-hover/handle:opacity-100 [[data-separator=active]_&]:opacity-100 transition-opacity pointer-events-none">
        <span className="block h-1 w-1 rounded-full bg-muted-foreground/40" />
        <span className="block h-1 w-1 rounded-full bg-muted-foreground/40" />
        <span className="block h-1 w-1 rounded-full bg-muted-foreground/40" />
      </div>
    </Separator>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
