import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../i18n/LanguageContext';
import AssemblyGuide from '../pages/AssemblyGuide';

describe('AssemblyGuide smoke', () => {
  it('renders without crashing and shows the hero title', () => {
    render(
      <LanguageProvider>
        <MemoryRouter>
          <AssemblyGuide />
        </MemoryRouter>
      </LanguageProvider>,
    );

    // assembly.heroTitle = "Assemble Your Hive Module"
    expect(screen.getByText(/Assemble Your Hive Module/i)).toBeInTheDocument();
    // First step from the steps array
    expect(screen.getByText(/Prepare the Wooden Parts/i)).toBeInTheDocument();
  });
});
