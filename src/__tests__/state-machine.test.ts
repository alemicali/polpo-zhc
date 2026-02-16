import { describe, it, expect } from "vitest";
import {
  VALID_TRANSITIONS,
  isValidTransition,
  assertValidTransition,
} from "../core/state-machine.js";
import type { TaskStatus } from "../core/types.js";

const ALL_STATUSES: TaskStatus[] = ["pending", "awaiting_approval", "assigned", "in_progress", "review", "done", "failed"];

describe("state-machine", () => {
  describe("VALID_TRANSITIONS", () => {
    it("defines transitions for every status", () => {
      for (const status of ALL_STATUSES) {
        expect(VALID_TRANSITIONS).toHaveProperty(status);
      }
    });

    it("pending can go to assigned or awaiting_approval", () => {
      expect(VALID_TRANSITIONS.pending).toEqual(["assigned", "awaiting_approval"]);
    });

    it("awaiting_approval can go to assigned, failed, or done", () => {
      expect(VALID_TRANSITIONS.awaiting_approval).toEqual(["assigned", "failed", "done"]);
    });

    it("assigned can go to in_progress or awaiting_approval", () => {
      expect(VALID_TRANSITIONS.assigned).toEqual(["in_progress", "awaiting_approval"]);
    });

    it("in_progress can go to review, failed, or awaiting_approval", () => {
      expect(VALID_TRANSITIONS.in_progress).toEqual(["review", "failed", "awaiting_approval"]);
    });

    it("review can go to done, failed, or awaiting_approval", () => {
      expect(VALID_TRANSITIONS.review).toEqual(["done", "failed", "awaiting_approval"]);
    });

    it("done is terminal (no transitions)", () => {
      expect(VALID_TRANSITIONS.done).toEqual([]);
    });

    it("failed can go back to pending (retry)", () => {
      expect(VALID_TRANSITIONS.failed).toEqual(["pending"]);
    });
  });

  describe("isValidTransition", () => {
    it("returns true for valid transitions", () => {
      expect(isValidTransition("pending", "assigned")).toBe(true);
      expect(isValidTransition("assigned", "in_progress")).toBe(true);
      expect(isValidTransition("in_progress", "review")).toBe(true);
      expect(isValidTransition("in_progress", "failed")).toBe(true);
      expect(isValidTransition("review", "done")).toBe(true);
      expect(isValidTransition("review", "failed")).toBe(true);
      expect(isValidTransition("failed", "pending")).toBe(true);
    });

    it("returns false for invalid transitions", () => {
      expect(isValidTransition("pending", "done")).toBe(false);
      expect(isValidTransition("pending", "failed")).toBe(false);
      expect(isValidTransition("done", "pending")).toBe(false);
      expect(isValidTransition("done", "failed")).toBe(false);
      expect(isValidTransition("assigned", "done")).toBe(false);
      expect(isValidTransition("review", "pending")).toBe(false);
    });

    it("done cannot transition to anything", () => {
      for (const target of ALL_STATUSES) {
        expect(isValidTransition("done", target)).toBe(false);
      }
    });

    it("failed → pending is the only cycle", () => {
      // Verify that failed→pending is valid
      expect(isValidTransition("failed", "pending")).toBe(true);
      // And no other backward transitions exist
      expect(isValidTransition("assigned", "pending")).toBe(false);
      expect(isValidTransition("in_progress", "assigned")).toBe(false);
      expect(isValidTransition("review", "in_progress")).toBe(false);
      expect(isValidTransition("done", "review")).toBe(false);
    });
  });

  describe("assertValidTransition", () => {
    it("does not throw for valid transitions", () => {
      expect(() => assertValidTransition("pending", "assigned")).not.toThrow();
      expect(() => assertValidTransition("failed", "pending")).not.toThrow();
    });

    it("throws for invalid transitions with descriptive message", () => {
      expect(() => assertValidTransition("pending", "done"))
        .toThrow("Invalid transition: pending → done (allowed: assigned, awaiting_approval)");
    });

    it("throws for terminal state transitions with empty allowed list", () => {
      expect(() => assertValidTransition("done", "pending"))
        .toThrow("Invalid transition: done → pending (allowed: none)");
    });
  });
});
