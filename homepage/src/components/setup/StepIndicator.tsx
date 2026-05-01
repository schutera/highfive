interface Step {
  label: string;
  icon?: React.ReactNode;
}

interface StepIndicatorProps {
  currentStep: number;
  steps: Step[];
}

// Skill rule: "At most 2 prominent elements per section. Counting decorations."
// The indicator is chrome — it must not compete with the step content. Numbers
// over icons; no ring halo on the current step; thinner connector. Hierarchy
// comes from weight + color, not from added decoration.
export default function StepIndicator({ currentStep, steps }: StepIndicatorProps) {
  return (
    <nav className="w-full max-w-2xl mx-auto px-4 py-3" aria-label="Setup progress">
      <p className="sr-only">
        Step {currentStep} of {steps.length}: {steps[currentStep - 1]?.label}
      </p>
      {/* Desktop: full labels */}
      <ol className="hidden md:flex items-center justify-between">
        {steps.map((step, i) => {
          const stepNum = i + 1;
          const isCompleted = stepNum < currentStep;
          const isCurrent = stepNum === currentStep;
          return (
            <li key={i} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center">
                <div
                  aria-current={isCurrent ? 'step' : undefined}
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-hf-xs font-semibold transition-colors duration-200 ${
                    isCompleted
                      ? 'bg-hf-honey-500 text-white'
                      : isCurrent
                        ? 'bg-hf-honey-500 text-white'
                        : 'bg-hf-fg/8 text-hf-fg-mute'
                  }`}
                >
                  {isCompleted ? (
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2.5}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  ) : (
                    stepNum
                  )}
                </div>
                <span
                  className={`mt-1.5 text-hf-xs transition-colors ${
                    isCurrent
                      ? 'text-hf-fg font-semibold'
                      : isCompleted
                        ? 'text-hf-fg-soft'
                        : 'text-hf-fg-mute'
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div
                  className={`flex-1 h-px mx-2 mt-[-1rem] transition-colors duration-200 ${
                    stepNum < currentStep ? 'bg-hf-honey-500' : 'bg-hf-fg/10'
                  }`}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>

      {/* Mobile: compact circles + current label */}
      <div className="md:hidden">
        <ol className="flex items-center justify-center gap-1.5 mb-1.5">
          {steps.map((_, i) => {
            const stepNum = i + 1;
            const isCompleted = stepNum < currentStep;
            const isCurrent = stepNum === currentStep;
            return (
              <li key={i} className="flex items-center gap-1.5">
                <div
                  aria-current={isCurrent ? 'step' : undefined}
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold transition-colors duration-200 ${
                    isCompleted
                      ? 'bg-hf-honey-500 text-white'
                      : isCurrent
                        ? 'bg-hf-honey-500 text-white'
                        : 'bg-hf-fg/8 text-hf-fg-mute'
                  }`}
                >
                  {isCompleted ? (
                    <svg
                      className="w-3 h-3"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2.5}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  ) : (
                    stepNum
                  )}
                </div>
                {i < steps.length - 1 && (
                  <div
                    className={`w-3 h-px ${stepNum < currentStep ? 'bg-hf-honey-500' : 'bg-hf-fg/10'}`}
                    aria-hidden="true"
                  />
                )}
              </li>
            );
          })}
        </ol>
        <p className="text-center text-hf-xs font-semibold text-hf-fg">
          {steps[currentStep - 1]?.label}
        </p>
      </div>
    </nav>
  );
}
