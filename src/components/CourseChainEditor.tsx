"use client";

import { useState } from "react";
import {
  makeExclusiveFork,
  newArmId,
  type CourseDef,
  type CourseStep,
} from "@/lib/courseDef";

function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length || from === to) return arr;
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function forkSummary(step: Extract<CourseStep, { type: "fork" }>): string {
  const parts = step.arms.map((a) => {
    const codes = a.steps
      .filter((s): s is { type: "control"; code: string } => s.type === "control")
      .map((s) => s.code);
    if (codes.length === 0) return a.label;
    if (codes.length === 1 && codes[0] === a.label) return a.label;
    return codes.length === 1 ? codes[0] : `${a.label}:${codes.join("·")}`;
  });
  return parts.join("|");
}

interface Props {
  def: CourseDef;
  controlCodes: string[];
  onChange: (def: CourseDef) => void;
}

export default function CourseChainEditor({
  def,
  controlCodes,
  onChange,
}: Props) {
  const [expandedForkId, setExpandedForkId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [dragSpine, setDragSpine] = useState<number | null>(null);
  const [dragArm, setDragArm] = useState<{
    forkId: string;
    armId: string;
    index: number;
  } | null>(null);

  const setSteps = (steps: CourseStep[]) => onChange({ ...def, steps });

  const reorderSpine = (from: number, to: number) => {
    setSteps(moveItem(def.steps, from, to));
  };

  return (
    <div className="space-y-2">
      {/* Compact course chain */}
      <div className="flex flex-wrap items-center gap-y-1.5 gap-x-0.5">
        {def.steps.length === 0 && (
          <span className="text-xs text-forest-500 italic mr-2">
            Empty — add controls
          </span>
        )}
        {def.steps.map((step, si) => (
          <div key={step.type === "fork" ? step.id : `c-${si}-${step.code}`} className="contents">
            {si > 0 && (
              <span className="text-forest-300 text-xs px-0.5 select-none" aria-hidden>
                →
              </span>
            )}
            {step.type === "control" ? (
              <span
                draggable={editing}
                onDragStart={() => setDragSpine(si)}
                onDragOver={(e) => {
                  if (dragSpine == null) return;
                  e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragSpine == null) return;
                  reorderSpine(dragSpine, si);
                  setDragSpine(null);
                }}
                onDragEnd={() => setDragSpine(null)}
                className={`inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0.5 text-xs font-mono ${
                  editing
                    ? "border-forest-300 bg-white cursor-grab active:cursor-grabbing"
                    : "border-forest-200 bg-forest-50"
                } ${dragSpine === si ? "opacity-50" : ""}`}
              >
                {editing && (
                  <span className="flex flex-col -ml-0.5 mr-0.5 text-[8px] leading-none text-forest-400">
                    <button
                      type="button"
                      className="hover:text-forest-700 disabled:opacity-20 px-0.5"
                      disabled={si === 0}
                      aria-label="Move earlier"
                      onClick={() => reorderSpine(si, si - 1)}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="hover:text-forest-700 disabled:opacity-20 px-0.5"
                      disabled={si >= def.steps.length - 1}
                      aria-label="Move later"
                      onClick={() => reorderSpine(si, si + 1)}
                    >
                      ▼
                    </button>
                  </span>
                )}
                {step.code}
                {editing && (
                  <button
                    type="button"
                    className="text-forest-400 hover:text-red-600 ml-0.5"
                    aria-label={`Remove ${step.code}`}
                    onClick={() =>
                      setSteps(def.steps.filter((_, k) => k !== si))
                    }
                  >
                    ×
                  </button>
                )}
              </span>
            ) : (
              <button
                type="button"
                draggable={editing}
                onDragStart={() => setDragSpine(si)}
                onDragOver={(e) => {
                  if (dragSpine == null) return;
                  e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragSpine == null) return;
                  reorderSpine(dragSpine, si);
                  setDragSpine(null);
                }}
                onDragEnd={() => setDragSpine(null)}
                onClick={() => {
                  setEditing(true);
                  setExpandedForkId(
                    expandedForkId === step.id ? null : step.id
                  );
                }}
                className={`inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0.5 text-xs font-mono ${
                  expandedForkId === step.id
                    ? "border-amber-500 bg-amber-100 text-amber-950"
                    : "border-amber-300 bg-amber-50 text-amber-900"
                } ${editing ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"} ${
                  dragSpine === si ? "opacity-50" : ""
                }`}
                title="Edit fork"
              >
                {editing && (
                  <span
                    className="flex flex-col -ml-0.5 mr-0.5 text-[8px] leading-none text-amber-600"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="hover:text-amber-900 disabled:opacity-20 px-0.5"
                      disabled={si === 0}
                      aria-label="Move fork earlier"
                      onClick={() => reorderSpine(si, si - 1)}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="hover:text-amber-900 disabled:opacity-20 px-0.5"
                      disabled={si >= def.steps.length - 1}
                      aria-label="Move fork later"
                      onClick={() => reorderSpine(si, si + 1)}
                    >
                      ▼
                    </button>
                  </span>
                )}
                <span className="text-amber-700/80">(</span>
                {forkSummary(step)}
                <span className="text-amber-700/80">)</span>
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={`rounded px-2 py-0.5 text-[11px] border ${
            editing
              ? "border-forest-700 bg-forest-800 text-white"
              : "border-forest-200 text-forest-700 hover:bg-forest-50"
          }`}
          onClick={() => {
            setEditing((e) => !e);
            if (editing) setExpandedForkId(null);
          }}
        >
          {editing ? "Done" : "Edit chain"}
        </button>
        {editing && (
          <>
            <span className="text-forest-300 text-xs">|</span>
            {controlCodes.map((code) => (
              <button
                key={`add-${code}`}
                type="button"
                className="rounded border border-forest-200 px-1.5 py-0.5 text-[11px] font-mono hover:bg-forest-50"
                onClick={() =>
                  setSteps([...def.steps, { type: "control", code }])
                }
              >
                +{code}
              </button>
            ))}
            <button
              type="button"
              className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-900 hover:bg-amber-100"
              onClick={() => {
                const fork = makeExclusiveFork(
                  `Fork ${def.steps.filter((s) => s.type === "fork").length + 1}`
                );
                setSteps([...def.steps, fork]);
                if (fork.type === "fork") setExpandedForkId(fork.id);
              }}
            >
              +Fork
            </button>
          </>
        )}
      </div>

      {/* Expanded fork editor (only one at a time) */}
      {editing &&
        expandedForkId &&
        (() => {
          const si = def.steps.findIndex(
            (s) => s.type === "fork" && s.id === expandedForkId
          );
          const step = def.steps[si];
          if (!step || step.type !== "fork") return null;
          return (
            <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-2.5 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider font-semibold text-amber-800">
                  Fork
                </span>
                <input
                  className="rounded border border-amber-200 bg-white px-1.5 py-0.5 text-xs w-28"
                  value={step.label ?? ""}
                  placeholder="Name"
                  onChange={(e) => {
                    const label = e.target.value;
                    setSteps(
                      def.steps.map((s, k) =>
                        k === si && s.type === "fork" ? { ...s, label } : s
                      )
                    );
                  }}
                />
                <button
                  type="button"
                  className="text-[11px] text-amber-900 hover:underline"
                  onClick={() =>
                    setSteps(
                      def.steps.map((s, k) => {
                        if (k !== si || s.type !== "fork") return s;
                        return {
                          ...s,
                          arms: [
                            ...s.arms,
                            {
                              id: newArmId(),
                              label: String.fromCharCode(65 + s.arms.length),
                              steps: [],
                            },
                          ],
                        };
                      })
                    )
                  }
                >
                  + Arm
                </button>
                <button
                  type="button"
                  className="text-[11px] text-red-600 hover:underline ml-auto"
                  onClick={() => {
                    setSteps(def.steps.filter((_, k) => k !== si));
                    setExpandedForkId(null);
                  }}
                >
                  Remove fork
                </button>
                <button
                  type="button"
                  className="text-[11px] text-forest-600 hover:underline"
                  onClick={() => setExpandedForkId(null)}
                >
                  Collapse
                </button>
              </div>

              <div className="space-y-1.5">
                {step.arms.map((arm, ai) => (
                  <div
                    key={arm.id}
                    className="flex flex-wrap items-center gap-1.5 rounded border border-amber-100 bg-white/90 px-2 py-1.5"
                  >
                    <input
                      className="rounded border border-forest-200 px-1 py-0.5 text-xs font-mono w-14 shrink-0"
                      value={arm.label}
                      onChange={(e) => {
                        const label = e.target.value;
                        setSteps(
                          def.steps.map((s, k) => {
                            if (k !== si || s.type !== "fork") return s;
                            return {
                              ...s,
                              arms: s.arms.map((a, j) =>
                                j === ai ? { ...a, label } : a
                              ),
                            };
                          })
                        );
                      }}
                    />
                    <span className="text-forest-300 text-xs">:</span>
                    {arm.steps.map((as, asi) =>
                      as.type === "control" ? (
                        <span
                          key={`${arm.id}-${asi}`}
                          draggable
                          onDragStart={() =>
                            setDragArm({
                              forkId: step.id,
                              armId: arm.id,
                              index: asi,
                            })
                          }
                          onDragOver={(e) => {
                            if (
                              !dragArm ||
                              dragArm.forkId !== step.id ||
                              dragArm.armId !== arm.id
                            )
                              return;
                            e.preventDefault();
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (
                              !dragArm ||
                              dragArm.forkId !== step.id ||
                              dragArm.armId !== arm.id
                            )
                              return;
                            setSteps(
                              def.steps.map((s, k) => {
                                if (k !== si || s.type !== "fork") return s;
                                return {
                                  ...s,
                                  arms: s.arms.map((a, j) =>
                                    j === ai
                                      ? {
                                          ...a,
                                          steps: moveItem(
                                            a.steps,
                                            dragArm.index,
                                            asi
                                          ),
                                        }
                                      : a
                                  ),
                                };
                              })
                            );
                            setDragArm(null);
                          }}
                          onDragEnd={() => setDragArm(null)}
                          className="inline-flex items-center gap-0.5 rounded border border-forest-200 bg-forest-50 px-1.5 py-0.5 text-xs font-mono cursor-grab"
                        >
                          <span className="flex flex-col text-[7px] leading-none text-forest-400">
                            <button
                              type="button"
                              className="disabled:opacity-20"
                              disabled={asi === 0}
                              onClick={() =>
                                setSteps(
                                  def.steps.map((s, k) => {
                                    if (k !== si || s.type !== "fork") return s;
                                    return {
                                      ...s,
                                      arms: s.arms.map((a, j) =>
                                        j === ai
                                          ? {
                                              ...a,
                                              steps: moveItem(
                                                a.steps,
                                                asi,
                                                asi - 1
                                              ),
                                            }
                                          : a
                                      ),
                                    };
                                  })
                                )
                              }
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              className="disabled:opacity-20"
                              disabled={asi >= arm.steps.length - 1}
                              onClick={() =>
                                setSteps(
                                  def.steps.map((s, k) => {
                                    if (k !== si || s.type !== "fork") return s;
                                    return {
                                      ...s,
                                      arms: s.arms.map((a, j) =>
                                        j === ai
                                          ? {
                                              ...a,
                                              steps: moveItem(
                                                a.steps,
                                                asi,
                                                asi + 1
                                              ),
                                            }
                                          : a
                                      ),
                                    };
                                  })
                                )
                              }
                            >
                              ▼
                            </button>
                          </span>
                          {as.code}
                          <button
                            type="button"
                            className="text-forest-400 hover:text-red-600"
                            onClick={() =>
                              setSteps(
                                def.steps.map((s, k) => {
                                  if (k !== si || s.type !== "fork") return s;
                                  return {
                                    ...s,
                                    arms: s.arms.map((a, j) =>
                                      j === ai
                                        ? {
                                            ...a,
                                            steps: a.steps.filter(
                                              (_, m) => m !== asi
                                            ),
                                          }
                                        : a
                                    ),
                                  };
                                })
                              )
                            }
                          >
                            ×
                          </button>
                        </span>
                      ) : null
                    )}
                    {controlCodes.map((code) => (
                      <button
                        key={`${arm.id}+${code}`}
                        type="button"
                        className="rounded border border-dashed border-forest-200 px-1 py-0.5 text-[10px] font-mono text-forest-500 hover:bg-forest-50"
                        onClick={() =>
                          setSteps(
                            def.steps.map((s, k) => {
                              if (k !== si || s.type !== "fork") return s;
                              return {
                                ...s,
                                arms: s.arms.map((a, j) =>
                                  j === ai
                                    ? {
                                        ...a,
                                        steps: [
                                          ...a.steps,
                                          { type: "control", code },
                                        ],
                                      }
                                    : a
                                ),
                              };
                            })
                          )
                        }
                      >
                        +{code}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="text-[10px] text-red-500 disabled:opacity-30 ml-auto"
                      disabled={step.arms.length <= 2}
                      onClick={() =>
                        setSteps(
                          def.steps.map((s, k) => {
                            if (k !== si || s.type !== "fork") return s;
                            return {
                              ...s,
                              arms: s.arms.filter((_, j) => j !== ai),
                            };
                          })
                        )
                      }
                    >
                      ×arm
                    </button>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
    </div>
  );
}
