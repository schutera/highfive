interface Step {
  label: string;
  icon: React.ReactNode;
}

interface StepIndicatorProps {
  currentStep: number;
  steps: Step[];
}

export default function StepIndicator({ currentStep, steps }: StepIndicatorProps) {
  return (
    <nav className="w-full max-w-2xl mx-auto px-4 py-4" aria-label="Setup progress">
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
                  className={`w-10 h-10 rounded-full flex items-center justify-center text-hf-sm font-bold transition-all duration-300 ${
                    isCompleted
                      ? 'bg-hf-honey-500 text-white'
                      : isCurrent
                        ? 'bg-hf-honey-500 text-white ring-4 ring-hf-honey-200'
                        : 'bg-hf-fg/10 text-hf-fg-mute'
                  }`}
                >
                  {isCompleted ? (
                    <svg
                      className="w-5 h-5"
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
                    <span className="w-5 h-5 flex items-center justify-center" aria-hidden="true">
                      {step.icon}
                    </span>
                  )}
                </div>
                <span
                  className={`mt-2 text-hf-xs font-medium transition-colors ${
                    isCurrent
                      ? 'text-hf-honey-700'
                      : isCompleted
                        ? 'text-hf-honey-600'
                        : 'text-hf-fg-mute'
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div
                  className={`flex-1 h-0.5 mx-3 mt-[-1.25rem] transition-colors duration-300 ${
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
        <ol className="flex items-center justify-center gap-2 mb-2">
          {steps.map((_, i) => {
            const stepNum = i + 1;
            const isCompleted = stepNum < currentStep;
            const isCurrent = stepNum === currentStep;
            return (
              <li key={i} className="flex items-center gap-2">
                <div
                  aria-current={isCurrent ? 'step' : undefined}
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-hf-xs font-bold transition-all duration-300 ${
                    isCompleted
                      ? 'bg-hf-honey-500 text-white'
                      : isCurrent
                        ? 'bg-hf-honey-500 text-white ring-2 ring-hf-honey-200'
                        : 'bg-hf-fg/10 text-hf-fg-mute'
                  }`}
                >
                  {isCompleted ? (
                    <svg
                      className="w-4 h-4"
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
                    className={`w-4 h-0.5 ${stepNum < currentStep ? 'bg-hf-honey-500' : 'bg-hf-fg/10'}`}
                    aria-hidden="true"
                  />
                )}
              </li>
            );
          })}
        </ol>
        <p className="text-center text-hf-sm font-medium text-hf-honey-700">
          {steps[currentStep - 1]?.label}
        </p>
      </div>
    </nav>
  );
}
