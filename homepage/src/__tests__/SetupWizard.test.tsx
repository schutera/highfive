import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../i18n/LanguageContext';

// Mock api — useSetupWizard imports it.
vi.mock('../services/api', () => ({
  api: {
    getAllModules: vi.fn().mockResolvedValue([]),
    getModuleById: vi.fn(),
    getModuleLogs: vi.fn().mockResolvedValue([]),
    updateModuleStatus: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue({ status: 'ok', timestamp: '' }),
  },
}));

// esptool-js touches Web Serial APIs that don't exist in jsdom.
vi.mock('esptool-js', () => ({
  ESPLoader: vi.fn().mockImplementation(() => ({
    main: vi.fn(),
    writeFlash: vi.fn(),
    eraseFlash: vi.fn(),
  })),
  Transport: vi.fn().mockImplementation(() => ({})),
}));

// Stub the flash module too, since it loads the firmware blob over fetch
// at module init.
vi.mock('../components/setup/flashEsp', () => ({
  flashEsp: vi.fn().mockResolvedValue(undefined),
}));

import SetupWizard from '../pages/SetupWizard';

describe('SetupWizard smoke', () => {
  it('renders step 1 (Connect Your Module) on first load', () => {
    render(
      <LanguageProvider>
        <MemoryRouter>
          <SetupWizard />
        </MemoryRouter>
      </LanguageProvider>,
    );

    // Step 1 heading from translations.en.step1.title
    expect(screen.getByText(/Connect Your Module/i)).toBeInTheDocument();
  });
});
