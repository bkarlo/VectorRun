/**
 * Course definition AST: ordered steps with exclusive forks (and reserved modes).
 * Linear courses are simply steps of type "control" only.
 */

export type ForkMode = "exclusive" | "sequence" | "any_order";

export type CourseStep =
  | { type: "control"; code: string }
  | {
      type: "fork";
      id: string;
      label?: string;
      mode: ForkMode;
      arms: CourseArm[];
    };

export type CourseArm = {
  id: string;
  label: string;
  steps: CourseStep[];
};

export type CourseDef = {
  version: 1;
  steps: CourseStep[];
};

/** Edge in the course used to build analysis legs. */
export type CourseLegTemplate = {
  fromCode: string;
  toCode: string;
  forkId?: string;
  forkLabel?: string;
  armId?: string;
  armLabel?: string;
};

export type RealizedPath = {
  codes: string[];
  forks: Record<string, string>;
};

export function emptyCourseDef(): CourseDef {
  return { version: 1, steps: [] };
}

export function courseDefFromCodes(codes: string[]): CourseDef {
  return {
    version: 1,
    steps: codes.map((code) => ({ type: "control" as const, code })),
  };
}

/** All control codes appearing anywhere in the def (spine + arms). */
export function collectAllCodes(def: CourseDef): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  function walk(steps: CourseStep[]) {
    for (const s of steps) {
      if (s.type === "control") {
        if (!seen.has(s.code)) {
          seen.add(s.code);
          out.push(s.code);
        }
      } else {
        for (const arm of s.arms) walk(arm.steps);
      }
    }
  }
  walk(def.steps);
  return out;
}

/** Top-level spine codes only (forks omitted). */
export function spineCodes(def: CourseDef): string[] {
  return def.steps
    .filter((s): s is { type: "control"; code: string } => s.type === "control")
    .map((s) => s.code);
}

export function courseHasForks(def: CourseDef | null | undefined): boolean {
  if (!def) return false;
  return def.steps.some((s) => s.type === "fork");
}

export function parseCourseDef(raw: unknown): CourseDef | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { version?: number; steps?: unknown };
  if (obj.version !== 1 || !Array.isArray(obj.steps)) return null;
  const steps = obj.steps.map(parseStep).filter(Boolean) as CourseStep[];
  if (steps.length !== obj.steps.length) return null;
  return { version: 1, steps };
}

function parseStep(raw: unknown): CourseStep | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s.type === "control" && typeof s.code === "string" && s.code.trim()) {
    return { type: "control", code: s.code.trim() };
  }
  if (s.type === "fork" && typeof s.id === "string" && Array.isArray(s.arms)) {
    const mode =
      s.mode === "sequence" || s.mode === "any_order" || s.mode === "exclusive"
        ? s.mode
        : "exclusive";
    const arms: CourseArm[] = [];
    for (const a of s.arms) {
      if (!a || typeof a !== "object") return null;
      const arm = a as Record<string, unknown>;
      if (typeof arm.id !== "string" || typeof arm.label !== "string") return null;
      if (!Array.isArray(arm.steps)) return null;
      const armSteps = arm.steps.map(parseStep).filter(Boolean) as CourseStep[];
      if (armSteps.length !== arm.steps.length) return null;
      arms.push({
        id: arm.id,
        label: arm.label,
        steps: armSteps,
      });
    }
    return {
      type: "fork",
      id: s.id,
      label: typeof s.label === "string" ? s.label : undefined,
      mode,
      arms,
    };
  }
  return null;
}

export function validateCourseDef(
  def: CourseDef,
  geoCodes: Set<string>
): string | null {
  if (def.steps.length === 0) return "Course has no steps";
  let controlCount = 0;
  const walk = (steps: CourseStep[], allowFork: boolean): string | null => {
    for (const s of steps) {
      if (s.type === "control") {
        if (!s.code.trim()) return "Empty control code";
        if (!geoCodes.has(s.code)) {
          return `Control "${s.code}" is missing or has no GPS`;
        }
        controlCount += 1;
      } else {
        if (!allowFork) return "Nested forks are not supported yet";
        if (s.mode === "any_order") {
          return "Free-order forks are not supported yet";
        }
        if (s.arms.length < 2) return "Each fork needs at least two arms";
        for (const arm of s.arms) {
          if (!arm.label.trim()) return "Fork arm needs a label";
          if (arm.steps.length === 0) {
            return `Fork arm "${arm.label}" has no controls`;
          }
          const err = walk(arm.steps, false);
          if (err) return err;
        }
      }
    }
    return null;
  };
  const err = walk(def.steps, true);
  if (err) return err;
  if (controlCount < 2) return "Course needs at least two controls";
  return null;
}

/**
 * Build leg templates: common spine edges once; fork transitions per arm
 * (e.g. S→1A, S→1B, 1A→2, 1B→2).
 */
export function legTemplatesFromCourse(def: CourseDef): CourseLegTemplate[] {
  const legs: CourseLegTemplate[] = [];
  type Frontier = {
    code: string;
    forkId?: string;
    forkLabel?: string;
    armId?: string;
    armLabel?: string;
  };
  let frontier: Frontier[] = [];

  for (const step of def.steps) {
    if (step.type === "control") {
      for (const f of frontier) {
        legs.push({
          fromCode: f.code,
          toCode: step.code,
          forkId: f.forkId,
          forkLabel: f.forkLabel,
          armId: f.armId,
          armLabel: f.armLabel,
        });
      }
      frontier = [{ code: step.code }];
      continue;
    }

    // Fork: each arm continues from current frontier
    const nextFrontier: Frontier[] = [];
    for (const arm of step.arms) {
      let armFront: Frontier[] = frontier.map((f) => ({
        ...f,
        forkId: step.id,
        forkLabel: step.label,
        armId: arm.id,
        armLabel: arm.label,
      }));
      for (const armStep of arm.steps) {
        if (armStep.type !== "control") continue;
        for (const f of armFront) {
          legs.push({
            fromCode: f.code,
            toCode: armStep.code,
            forkId: step.id,
            forkLabel: step.label,
            armId: arm.id,
            armLabel: arm.label,
          });
        }
        armFront = [
          {
            code: armStep.code,
            forkId: step.id,
            forkLabel: step.label,
            armId: arm.id,
            armLabel: arm.label,
          },
        ];
      }
      nextFrontier.push(...armFront);
    }
    frontier = nextFrontier;
  }

  return legs;
}

export function newForkId(): string {
  return `fork_${Math.random().toString(36).slice(2, 10)}`;
}

export function newArmId(): string {
  return `arm_${Math.random().toString(36).slice(2, 10)}`;
}

/** Default exclusive fork with two empty-ish arms (caller adds codes). */
export function makeExclusiveFork(label = "Fork"): CourseStep {
  return {
    type: "fork",
    id: newForkId(),
    label,
    mode: "exclusive",
    arms: [
      { id: newArmId(), label: "A", steps: [] },
      { id: newArmId(), label: "B", steps: [] },
    ],
  };
}
