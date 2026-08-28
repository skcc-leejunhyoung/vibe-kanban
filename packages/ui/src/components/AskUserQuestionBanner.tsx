import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { AskUserQuestionItem, QuestionAnswer } from 'shared/types';
import { QuestionIcon } from '@phosphor-icons/react';

export interface AskUserQuestionBannerHandle {
  /** Submit a custom free-text answer for the current question (triggered by Cmd+Enter in the editor) */
  submitCustomAnswer: (text: string) => void;
  /** Confirm the current question's selection: advance, or submit on the last question */
  confirmSelection: () => void;
}

interface AskUserQuestionBannerProps {
  questions: AskUserQuestionItem[];
  onSubmitAnswers: (answers: QuestionAnswer[]) => void;
  isSubmitting: boolean;
  isTimedOut: boolean;
  error: string | null;
}

export const AskUserQuestionBanner = forwardRef<
  AskUserQuestionBannerHandle,
  AskUserQuestionBannerProps
>(function AskUserQuestionBanner(
  { questions, onSubmitAnswers, isSubmitting, isTimedOut, error },
  ref
) {
  const { t } = useTranslation('common');

  // Selected labels per question text. Selecting never advances by itself;
  // Cmd+Enter (or the confirm button) confirms and moves on, so single- and
  // multi-select share the same select→confirm semantics and answered
  // questions can be revisited with Cmd+←/→ and changed.
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Entry streaming rebuilds the questions array each patch, so detect a truly
  // new question set by content, not reference, and reset during render.
  const questionsKey = questions.map((q) => q.question).join('\n');
  const [prevKey, setPrevKey] = useState(questionsKey);
  if (prevKey !== questionsKey) {
    setPrevKey(questionsKey);
    setSelections({});
    setCurrentIndex(0);
    setSubmitted(false);
    setFocusedIndex(0);
  }

  const currentQuestion =
    currentIndex < questions.length ? questions[currentIndex] : null;
  const currentSelection = currentQuestion
    ? (selections[currentQuestion.question] ?? [])
    : [];
  const isLastQuestion = currentIndex >= questions.length - 1;
  const disabled = isSubmitting || isTimedOut;

  const toQuestionAnswers = useCallback(
    (rec: Record<string, string[]>): QuestionAnswer[] =>
      questions
        .filter((q) => (rec[q.question] ?? []).length > 0)
        .map((q) => ({ question: q.question, answer: rec[q.question] })),
    [questions]
  );

  const submitAll = useCallback(
    (rec: Record<string, string[]>) => {
      setSubmitted(true);
      onSubmitAnswers(toQuestionAnswers(rec));
    },
    [onSubmitAnswers, toQuestionAnswers]
  );

  // Select (or toggle, for multi-select) an option — never advances
  const handleSelectOption = useCallback(
    (label: string) => {
      if (disabled || !currentQuestion) return;
      setSelections((prev) => {
        const cur = prev[currentQuestion.question] ?? [];
        const next = currentQuestion.multiSelect
          ? cur.includes(label)
            ? cur.filter((l) => l !== label)
            : [...cur, label]
          : [label];
        return { ...prev, [currentQuestion.question]: next };
      });
    },
    [disabled, currentQuestion]
  );

  // Confirm the current selection: next question, or submit on the last one
  const confirmSelection = useCallback(() => {
    if (disabled || !currentQuestion) return;
    if ((selections[currentQuestion.question] ?? []).length === 0) return;
    if (isLastQuestion) {
      submitAll(selections);
    } else {
      setCurrentIndex((i) => i + 1);
    }
  }, [disabled, currentQuestion, isLastQuestion, selections, submitAll]);

  const navigateQuestion = useCallback(
    (delta: number) => {
      setCurrentIndex((i) =>
        Math.min(Math.max(i + delta, 0), questions.length - 1)
      );
    },
    [questions.length]
  );

  useImperativeHandle(
    ref,
    () => ({
      submitCustomAnswer: (text: string) => {
        if (disabled || !currentQuestion || !text.trim()) return;
        const next = {
          ...selections,
          [currentQuestion.question]: [text.trim()],
        };
        setSelections(next);
        if (isLastQuestion) {
          submitAll(next);
        } else {
          setCurrentIndex((i) => i + 1);
        }
      },
      confirmSelection,
    }),
    [
      disabled,
      currentQuestion,
      selections,
      isLastQuestion,
      submitAll,
      confirmSelection,
    ]
  );

  // Focus the selected (or first) option when a question arrives or the user
  // navigates between questions. Deferred a frame so it wins over the chat
  // editor's own mount autofocus (Lexical AutoFocusPlugin) when question mode
  // remounts the editor in the same commit.
  useEffect(() => {
    if (!currentQuestion || disabled) return;
    const sel = selections[currentQuestion.question] ?? [];
    const idx = Math.max(
      0,
      currentQuestion.options.findIndex((o) => sel.includes(o.label))
    );
    setFocusedIndex(idx);
    const raf = requestAnimationFrame(() => optionRefs.current[idx]?.focus());
    return () => cancelAnimationFrame(raf);
    // Refocus only on question changes — not while toggling selections.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, questionsKey]);

  // A failed submit should surface the question again so it can be retried.
  useEffect(() => {
    if (error) setSubmitted(false);
  }, [error]);

  // Roving-focus arrows, Cmd+Enter confirm, Cmd+←/→ question navigation.
  // Bound to the banner subtree only, so editor focus keeps native macOS
  // line-start/end behavior for Cmd+←/→.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!currentQuestion) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        confirmSelection();
        return;
      }
      if (mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        navigateQuestion(e.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      if (mod) return;
      const delta =
        e.key === 'ArrowRight' || e.key === 'ArrowDown'
          ? 1
          : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
            ? -1
            : 0;
      if (delta !== 0) {
        e.preventDefault();
        const count = currentQuestion.options.length;
        if (count === 0) return;
        const next = (focusedIndex + delta + count) % count;
        setFocusedIndex(next);
        optionRefs.current[next]?.focus();
      }
    },
    [currentQuestion, confirmSelection, navigateQuestion, focusedIndex]
  );

  if (submitted && !isSubmitting && !error) return null;

  return (
    <div className="border-b">
      {/* Header */}
      <div className="flex items-center gap-base px-double py-base">
        <QuestionIcon className="h-4 w-4 text-brand flex-shrink-0" />
        <span className="text-sm text-normal flex-1">
          {t('askQuestion.title')}
          {questions.length > 1 && (
            <span className="text-low ml-1">
              ({Math.min(currentIndex + 1, questions.length)}/{questions.length}
              )
            </span>
          )}
        </span>
      </div>

      {/* Current question */}
      {currentQuestion && !submitted && (
        <div className="px-double pb-base" onKeyDown={handleKeyDown}>
          <div className="flex items-center gap-base mb-base">
            <span className="text-xs font-medium text-low bg-secondary px-1 py-0.5 rounded">
              {currentQuestion.header}
            </span>
            {currentQuestion.multiSelect && (
              <span className="text-xs text-low">
                {t('askQuestion.selectMultiple')}
              </span>
            )}
          </div>
          <p className="text-sm font-medium text-normal mb-base">
            {currentQuestion.question}
          </p>
          <div
            role={currentQuestion.multiSelect ? 'group' : 'radiogroup'}
            aria-label={currentQuestion.question}
            className="flex flex-wrap gap-base"
          >
            {currentQuestion.options.map((opt, index) => {
              const isSelected = currentSelection.includes(opt.label);
              return (
                <button
                  key={opt.label}
                  ref={(el) => {
                    optionRefs.current[index] = el;
                  }}
                  type="button"
                  role={currentQuestion.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={isSelected}
                  tabIndex={index === focusedIndex ? 0 : -1}
                  disabled={disabled}
                  onFocus={() => setFocusedIndex(index)}
                  onClick={() => handleSelectOption(opt.label)}
                  className={`
                    group relative rounded-md border px-2.5 py-1.5 text-xs transition-all
                    ${
                      isSelected
                        ? 'border-brand bg-brand/10 text-normal'
                        : 'border-border text-low hover:border-brand/40 hover:text-normal hover:bg-accent'
                    }
                    ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                  `}
                  title={opt.description}
                >
                  <span className="font-medium">{opt.label}</span>
                </button>
              );
            })}
          </div>
          {/* Confirm current selection (Cmd+Enter) */}
          {currentSelection.length > 0 && (
            <button
              type="button"
              disabled={disabled}
              onClick={confirmSelection}
              className="mt-2 rounded-md bg-brand px-3 py-1 text-xs font-medium text-white hover:bg-brand/90 transition-colors disabled:opacity-50"
            >
              {isLastQuestion
                ? t('askQuestion.submitAnswers')
                : t('askQuestion.confirmSelection')}
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="px-double pb-base text-sm text-error">{error}</div>
      )}

      {isSubmitting && (
        <div className="px-double pb-base text-sm text-low">
          {t('askQuestion.submitting')}
        </div>
      )}
    </div>
  );
});
