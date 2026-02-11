"use client";

import { useParams } from "next/navigation";
import { OrchestraProvider } from "@orchestra/react";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { ProjectHeader } from "@/components/layout/project-header";
import { CommandPalette } from "@/components/layout/command-palette";
import { ORCHESTRA_URL, API_KEY } from "@/lib/orchestra";

export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  return (
    <OrchestraProvider
      baseUrl={ORCHESTRA_URL}
      projectId={projectId}
      apiKey={API_KEY}
    >
      <SidebarProvider>
        <AppSidebar projectId={projectId} />
        <SidebarInset>
          <ProjectHeader projectId={projectId} />
          <main className="flex-1 overflow-auto p-6">{children}</main>
        </SidebarInset>
        <CommandPalette />
      </SidebarProvider>
    </OrchestraProvider>
  );
}
