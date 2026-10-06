import { MessageResponse } from "@/components/ai-elements/message";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTheme } from "@/hooks/use-theme";
import "./mermaid-file-preview.css";
import { mermaidCodeBlock } from "./mermaid-code-block";

function DiagramError({ error }: { error: string }) {
  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <p className="font-medium">Unable to render this Mermaid diagram</p>
      <p className="mt-1 text-muted-foreground">Open Source to inspect the syntax or download the original file.</p>
      <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{error}</pre>
    </div>
  );
}

const mermaidOptions = {
  config: { securityLevel: "strict" as const, startOnLoad: false, suppressErrorRendering: true },
  errorComponent: DiagramError,
};
const darkMermaidOptions = { ...mermaidOptions, config: { ...mermaidOptions.config, theme: "dark" as const } };
const controls = { mermaid: { download: true, copy: true, fullscreen: true, panZoom: true } };

export function MermaidFilePreview({ content }: { content: string }) {
  const { resolved } = useTheme();
  return (
    <Tabs defaultValue="diagram" className="flex h-full flex-col gap-0">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/40 px-4 py-2">
        <TabsList aria-label="Mermaid file view">
          <TabsTrigger value="diagram">Diagram</TabsTrigger>
          <TabsTrigger value="source">Source</TabsTrigger>
        </TabsList>
        <span className="text-xs text-muted-foreground">Mermaid · zoom, pan and export</span>
      </div>
      <TabsContent value="diagram" className="m-0 min-h-0 flex-1 overflow-auto bg-muted/10 p-4 sm:p-6">
        {!content.trim() ? (
          <p role="status" className="text-sm text-muted-foreground">This Mermaid file is empty.</p>
        ) : content.length > 50_000 ? (
          <p role="status" className="text-sm text-muted-foreground">This diagram is too large to render safely. Open Source or download the file.</p>
        ) : (
          <MessageResponse key={resolved} className="mermaid-file-canvas" mode="static" mermaid={resolved === "dark" ? darkMermaidOptions : mermaidOptions} controls={controls}>
            {mermaidCodeBlock(content)}
          </MessageResponse>
        )}
      </TabsContent>
      <TabsContent value="source" className="m-0 min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        <pre aria-label="Mermaid source" className="font-mono text-xs leading-relaxed sm:text-sm"><code>{content}</code></pre>
      </TabsContent>
    </Tabs>
  );
}
