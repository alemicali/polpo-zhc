import Link from "next/link";
import { OrchestraClient } from "@orchestra/react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ORCHESTRA_URL, API_KEY } from "@/lib/orchestra";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  let projects: Awaited<ReturnType<typeof OrchestraClient.listProjects>> = [];
  let error: string | null = null;

  try {
    projects = await OrchestraClient.listProjects(ORCHESTRA_URL, API_KEY);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to connect to Orchestra server";
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="mb-12 text-center">
        <h1 className="mb-2 text-4xl font-bold tracking-tight">Orchestra</h1>
        <p className="text-muted-foreground">AI Agent Mission Control</p>
      </div>

      {error ? (
        <Card className="w-full max-w-md border-destructive">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">{error}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Make sure <code>orchestra serve</code> is running at {ORCHESTRA_URL}
            </p>
          </CardContent>
        </Card>
      ) : projects.length === 0 ? (
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-sm text-muted-foreground">No projects found.</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Start a project with <code>orchestra serve</code>
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid w-full max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link key={project.id} href={`/projects/${project.id}`}>
              <Card className="transition-colors hover:border-primary/50">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{project.name}</CardTitle>
                    <Badge
                      variant={
                        project.status === "running" ? "default" :
                        project.status === "idle" ? "secondary" : "destructive"
                      }
                    >
                      {project.status}
                    </Badge>
                  </div>
                  <CardDescription className="truncate font-mono text-xs">
                    {project.workDir}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-4 text-sm text-muted-foreground">
                    <span>{project.taskCount} tasks</span>
                    <span>{project.agentCount} agents</span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <div className="mt-8 text-xs text-muted-foreground">
        Connected to <code>{ORCHESTRA_URL}</code>
      </div>
    </div>
  );
}
