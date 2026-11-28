/**
 * Tools whose effect leaves the instance (a message to a person): in a chat a person confirms them
 * before they run (the same list Polpo's chat uses: src/llm/orchestrator-tools.ts).
 *
 * run_with_vault follows bash's policy: not gated (a command on the run's own computer, as the
 * runtime's own shell), and not read-only (the runtime never runs it in parallel).
 */
export const SIDE_EFFECT_GATED_TOOLS: ReadonlySet<string> = new Set(["whatsapp_send", "whatsapp_send_file", "email_send"]);
