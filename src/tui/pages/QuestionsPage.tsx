/**
 * QuestionsPage — full-screen interactive question form.
 *
 * Shows horizontal tabs (one per question), each with checkbox options
 * and a "Other..." custom text entry as the last item.
 *
 * Navigation:
 *   Tab/Shift+Tab  switch between questions
 *   ↑↓             navigate options (including "Other..." at bottom)
 *   Space          toggle option checkbox
 *   typing         when on "Other...", type custom answer
 *   Enter          submit all answers
 *   Esc            cancel
 */

import { Box, Text, useInput, useStdout } from "ink";
import { useState } from "react";
import { useStore, type Page } from "../store.js";
import type { UserAnswer } from "../../llm/mission-generator.js";

interface AnswerState {
  selected: Set<number>;
  custom: string;
}

export function QuestionsPage() {
  const page = useStore((s) => s.page) as Extract<Page, { id: "questions" }>;
  const { title, questions, onSubmit, onCancel } = page;
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 40;
  const termCols = stdout?.columns ?? 80;

  const [activeTab, setActiveTab] = useState(0);
  const [answers, setAnswers] = useState<Map<number, AnswerState>>(() => {
    const m = new Map<number, AnswerState>();
    for (let i = 0; i < questions.length; i++) {
      m.set(i, { selected: new Set(), custom: "" });
    }
    return m;
  });
  const [optionIdx, setOptionIdx] = useState(0);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  const q = questions[activeTab];
  const ans = answers.get(activeTab)!;
  // "Other..." is the last item (index === q.options.length)
  const customIdx = q.options.length;
  const onCustom = optionIdx === customIdx;

  // Count unanswered questions
  const unansweredCount = [...answers.values()].filter(
    a => a.selected.size === 0 && !a.custom
  ).length;

  const doSubmit = () => {
    const result: UserAnswer[] = [];
    for (let i = 0; i < questions.length; i++) {
      const a = answers.get(i)!;
      const selectedLabels = [...a.selected].map(idx => questions[i].options[idx].label);
      result.push({
        questionId: questions[i].id,
        selected: selectedLabels,
        customText: a.custom || undefined,
      });
    }
    onSubmit(result);
  };

  useInput((input, key) => {
    // ── Esc ──
    if (key.escape) {
      if (confirmSubmit) { setConfirmSubmit(false); return; }
      onCancel();
      return;
    }

    // ── Confirm submit (second Enter) ──
    if (confirmSubmit && key.return) {
      doSubmit();
      return;
    }
    if (confirmSubmit) {
      setConfirmSubmit(false);
    }

    // ── Enter → submit (or confirm if unanswered) ──
    if (key.return && !onCustom) {
      if (unansweredCount > 0) {
        setConfirmSubmit(true);
      } else {
        doSubmit();
      }
      return;
    }

    // ── Tab / Shift+Tab → switch question tabs ──
    if (key.tab) {
      if (key.shift) {
        setActiveTab(t => Math.max(0, t - 1));
      } else {
        setActiveTab(t => Math.min(questions.length - 1, t + 1));
      }
      setOptionIdx(0);
      return;
    }

    // ── ↑↓ → navigate options (0..options.length = custom) ──
    if (key.upArrow) {
      setOptionIdx(i => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setOptionIdx(i => Math.min(customIdx, i + 1));
      return;
    }

    // ── When on a regular option ──
    if (!onCustom) {
      // Space → toggle checkbox
      if (input === " ") {
        setAnswers(prev => {
          const next = new Map(prev);
          const a = { ...next.get(activeTab)! };
          const s = new Set(a.selected);
          if (s.has(optionIdx)) {
            s.delete(optionIdx);
          } else {
            if (!q.multiSelect) s.clear();
            s.add(optionIdx);
          }
          a.selected = s;
          next.set(activeTab, a);
          return next;
        });
        return;
      }
      return; // ignore other chars on regular options
    }

    // ── When on "Other..." (custom text) ──
    if (key.backspace || key.delete) {
      setAnswers(prev => {
        const next = new Map(prev);
        const a = { ...next.get(activeTab)! };
        a.custom = a.custom.slice(0, -1);
        next.set(activeTab, a);
        return next;
      });
      return;
    }
    if (key.return) {
      // Enter on custom with text → accept and move up
      setOptionIdx(0);
      return;
    }
    // Type characters into custom field
    if (input && !key.ctrl && !key.meta) {
      setAnswers(prev => {
        const next = new Map(prev);
        const a = { ...next.get(activeTab)! };
        a.custom = a.custom + input;
        next.set(activeTab, a);
        return next;
      });
    }
  });

  // ── Render ──
  const tabWidth = Math.max(12, Math.floor((termCols - 4) / questions.length) - 3);

  return (
    <Box flexDirection="column" height={termRows} paddingX={2}>
      {/* Title */}
      <Text bold color="cyan">{title}</Text>
      <Box height={1} />

      {/* Tab bar */}
      <Box>
        {questions.map((qt, i) => {
          const isActive = i === activeTab;
          const a = answers.get(i)!;
          const answered = a.selected.size > 0 || a.custom.length > 0;
          const label = qt.question.length > tabWidth
            ? qt.question.slice(0, tabWidth - 1) + "…"
            : qt.question;
          return (
            <Box key={qt.id} marginRight={1}>
              <Text
                color={isActive ? "cyan" : "gray"}
                bold={isActive}
                inverse={isActive}
              >
                {" "}{answered ? "✓ " : "  "}{label}{" "}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Text color="gray">{"─".repeat(Math.min(termCols - 4, 60))}</Text>
      <Box height={1} />

      {/* Question text */}
      <Text bold color="white">{q.question}</Text>
      {q.multiSelect && <Text color="gray">(select multiple)</Text>}
      <Box height={1} />

      {/* Options + "Other..." */}
      <Box flexDirection="column" flexGrow={1}>
        {q.options.map((opt, i) => {
          const checked = ans.selected.has(i);
          const highlighted = i === optionIdx;
          return (
            <Box key={i}>
              <Text color={highlighted ? "cyan" : "white"}>
                {highlighted ? "❯ " : "  "}
                {checked ? "☑ " : "☐ "}
              </Text>
              <Text bold={highlighted} color={highlighted ? "white" : "gray"}>
                {opt.label}
              </Text>
              {opt.description && (
                <Text color="gray"> — {opt.description}</Text>
              )}
            </Box>
          );
        })}

        {/* "Other..." custom text entry — last item */}
        <Box>
          <Text color={onCustom ? "cyan" : "white"}>
            {onCustom ? "❯ " : "  "}
          </Text>
          <Text color={onCustom ? "cyan" : "gray"} bold={onCustom}>
            {"Other: "}
          </Text>
          <Text color={onCustom ? "white" : "gray"}>
            {ans.custom ? ans.custom : (onCustom ? "" : "...")}
            {onCustom ? "█" : ""}
          </Text>
        </Box>
      </Box>

      {/* Unanswered warning */}
      {confirmSubmit && (
        <Text color="yellow" bold>
          {unansweredCount} unanswered question{unansweredCount > 1 ? "s" : ""}. Press Enter again to submit anyway, Esc to go back.
        </Text>
      )}

      {/* Status bar */}
      <Box>
        <Text color="gray">
          {activeTab + 1}/{questions.length} questions
          {" │ "}
          {[...answers.values()].filter(a => a.selected.size > 0 || a.custom).length} answered
        </Text>
      </Box>

      {/* Hint bar */}
      <Text color="gray">
        {onCustom
          ? "Type your answer  ↑ back to options  Enter done  Esc cancel"
          : "Tab/Shift+Tab questions  ↑↓ select  Space toggle  Enter submit  Esc cancel"}
      </Text>
    </Box>
  );
}
