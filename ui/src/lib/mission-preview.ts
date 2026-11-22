/**
 * A create_mission preview card (Polpo's proposal) → the mission it creates when approved: every
 * field of the proposal, the budget included, so "Execute" / "Save as draft" create exactly what
 * the card showed.
 */

export interface MissionProposal {
  name: string;
  prompt?: string;
  /** Spending limit in USD for the whole mission. */
  budgetUsd?: number;
}

export interface MissionCreateRequest {
  data: string;
  name: string;
  prompt?: string;
  status: "draft";
  budgetUsd?: number;
}

/** The request that creates the proposed mission (as a draft; executing it is a second call). */
export function missionRequestOf(proposal: MissionProposal, data: string): MissionCreateRequest {
  const budget = proposal.budgetUsd;
  return {
    data,
    name: proposal.name,
    ...(proposal.prompt ? { prompt: proposal.prompt } : {}),
    status: "draft",
    ...(typeof budget === "number" && Number.isFinite(budget) && budget > 0 ? { budgetUsd: budget } : {}),
  };
}

/** "$12.50" for a budget, as the card shows it. */
export function budgetText(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}
