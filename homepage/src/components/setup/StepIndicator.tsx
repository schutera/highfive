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
    <div className="w-full max-w-2xl mx-auto px-4 py-4">
      {/* Desktop: full labels */}
      <div className="hidden md:flex items-center justify-between">
        {steps.map((step, i) => {
          const stepNum = i + 1;
          const isCompleted = stepNum < currentStep;
          const isCurrent = stepNum === currentStep;
          return (
            <div key={i} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold transition-all duration-300 ${
                    isCompleted
                      ? 'bg-amber-500 text-white'
                      : isCurrent
                        ? 'bg-amber-500 text-white ring-4 ring-amber-200'
                        : 'bg-gray-200 text-gray-400'
                  }`}
                >
                  {isCompleted ? (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <span className="w-5 h-5 flex items-center justify-center">{step.icon}</span>
                  )}
                </div>
                <span
                  className={`mt-2 text-xs font-medium transition-colors ${
                    isCurrent ? 'text-amber-600' : isCompleted ? 'text-amber-500' : 'text-gray-400'
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div
                  className={`flex-1 h-0.5 mx-3 mt-[-1.25rem] transition-colors duration-300 ${
                    stepNum < currentStep ? 'bg-amber-500' : 'bg-gray-200'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Mobile: compact circles + current label */}
      <div className="md:hidden">
        <div className="flex items-center justify-center gap-2 mb-2">
          {steps.map((_, i) => {
            const stepNum = i + 1;
            const isCompleted = stepNum < currentStep;
            const isCurrent = stepNum === currentStep;
            return (
              <div key={i} className="flex items-center gap-2">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300 ${
                    isCompleted
                      ? 'bg-amber-500 text-white'
                      : isCurrent
                        ? 'bg-amber-500 text-white ring-2 ring-amber-200'
                        : 'bg-gray-200 text-gray-400'
                  }`}
                >
                  {isCompleted ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    stepNum
                  )}
                </div>
                {i < steps.length - 1 && (
                  <div className={`w-4 h-0.5 ${stepNum < currentStep ? 'bg-amber-500' : 'bg-gray-200'}`} />
                )}
              </div>
            );
          })}
        </div>
        <p className="text-center text-sm font-medium text-amber-600">
          {steps[currentStep - 1]?.label}
        </p>
      </div>
    </div>
  );
}
