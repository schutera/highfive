import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../i18n/LanguageContext';
import HiveModule from '../pages/HiveModule';

describe('HiveModule smoke', () => {
  it('renders the parts list with ESP32-CAM and PV Module rows', () => {
    render(
      <LanguageProvider>
        <MemoryRouter>
          <HiveModule />
        </MemoryRouter>
      </LanguageProvider>,
    );

    // From translations: hiveModule.electronicsTitle = "Electronics You'll Need"
    expect(screen.getByText(/Electronics You'?ll Need/i)).toBeInTheDocument();
    // Specific parts from the table — "ESP32-CAM" appears in both the row name
    // and its description, so allow multiple matches.
    expect(screen.getAllByText(/ESP32-CAM/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/PV Module/i)).toBeInTheDocument();
    expect(screen.getByText(/Boost Converter/i)).toBeInTheDocument();
  });
});
