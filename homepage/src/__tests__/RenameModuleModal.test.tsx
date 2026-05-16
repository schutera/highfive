import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parseModuleId } from '@highfive/contracts';
import { LanguageProvider } from '../i18n/LanguageContext';

// Mock the api before importing the modal — vitest hoists vi.mock so
// the real api module is never loaded. We import RenameConflictError
// from the same path so `err instanceof RenameConflictError` inside
// the modal still works against this mock.
vi.mock('../services/api', async () => {
  // Re-export the real RenameConflictError class so the modal's
  // `err instanceof` check evaluates correctly. Everything else is a
  // stub.
  class RenameConflictError extends Error {
    constructor(
      public readonly displayName: string,
      public readonly conflictingModuleId: string,
    ) {
      super(`display_name "${displayName}" already in use by module ${conflictingModuleId}`);
      this.name = 'RenameConflictError';
    }
  }
  return {
    api: {
      renameModule: vi.fn(),
    },
    RenameConflictError,
  };
});

import RenameModuleModal from '../components/RenameModuleModal';
import { api, RenameConflictError } from '../services/api';

const mockModule = {
  id: parseModuleId('e89fa9f23a08'),
  name: 'fierce-apricot-specht',
  displayName: null as string | null,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: admin key present so the input form renders directly.
  // Individual tests can clear sessionStorage to exercise the
  // AdminKeyForm prompt branch.
  if (typeof window !== 'undefined') {
    sessionStorage.setItem('hf_admin_key', 'hf_dev_key_2026');
  }
});

describe('RenameModuleModal', () => {
  // --- happy path -------------------------------------------------------

  it('calls api.renameModule on submit and invokes onSaved + onClose', async () => {
    (api.renameModule as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(
      <LanguageProvider>
        <RenameModuleModal module={mockModule} onClose={onClose} onSaved={onSaved} />
      </LanguageProvider>,
    );

    const input = screen.getByLabelText(/display name/i);
    await userEvent.type(input, 'Garden Bee');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(api.renameModule).toHaveBeenCalledWith(mockModule.id, 'Garden Bee');
      expect(onSaved).toHaveBeenCalledWith('Garden Bee');
      expect(onClose).toHaveBeenCalled();
    });
  });

  // --- empty input clears the override ---------------------------------

  it('treats an empty input as a clear (sends null)', async () => {
    (api.renameModule as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(
      <LanguageProvider>
        <RenameModuleModal
          module={{ ...mockModule, displayName: 'Existing' }}
          onClose={onClose}
          onSaved={onSaved}
        />
      </LanguageProvider>,
    );

    const input = screen.getByLabelText(/display name/i);
    await userEvent.clear(input);
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(api.renameModule).toHaveBeenCalledWith(mockModule.id, null);
      expect(onSaved).toHaveBeenCalledWith(null);
    });
  });

  // --- 409 collision: inline error, modal stays open --------------------

  it('renders an inline error on 409 RenameConflictError and stays open', async () => {
    (api.renameModule as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new RenameConflictError('Garden Bee', '00112233beef'),
    );
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(
      <LanguageProvider>
        <RenameModuleModal module={mockModule} onClose={onClose} onSaved={onSaved} />
      </LanguageProvider>,
    );

    await userEvent.type(screen.getByLabelText(/display name/i), 'Garden Bee');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    // Error text references the leading 4 hex of the conflicting MAC
    // (0011 → '0011'); trailing-4 ('BEEF') would be the wrong choice
    // because same-batch hardware shares its trailing octets.
    await waitFor(() => {
      expect(screen.getByText(/already used by module 0011/i)).toBeInTheDocument();
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // --- 401: AdminKeyForm appears, retry succeeds ------------------------

  it('shows the admin-key form on 401 and retries after the key is submitted', async () => {
    // Real retry flow: the modal opens with a stored key, user types a
    // name and clicks Save, the first api call rejects with
    // 'unauthorized' (and api.renameModule has already cleared the key
    // from sessionStorage by then), the modal flips to AdminKeyForm,
    // user submits a fresh key, the modal auto-retries with the same
    // draft and succeeds.
    (api.renameModule as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('unauthorized'))
      .mockResolvedValueOnce(undefined);
    // The real api.renameModule clears the key on 401; the mock above
    // does not, so simulate that side-effect here by clearing in a
    // mockImplementation wrapper for the first call only.
    const firstCall = (api.renameModule as ReturnType<typeof vi.fn>).getMockImplementation();
    let calls = 0;
    (api.renameModule as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        sessionStorage.removeItem('hf_admin_key');
        throw new Error('unauthorized');
      }
      return undefined;
    });
    void firstCall;

    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(
      <LanguageProvider>
        <RenameModuleModal module={mockModule} onClose={onClose} onSaved={onSaved} />
      </LanguageProvider>,
    );

    // First attempt with the stored key — rejects with 'unauthorized'.
    await userEvent.type(screen.getByLabelText(/display name/i), 'Garden Bee');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    // Modal should now be showing the AdminKeyForm.
    const keyInput = await screen.findByPlaceholderText(/enter admin key/i);
    await userEvent.type(keyInput, 'hf_dev_key_2026');
    await userEvent.click(screen.getByRole('button', { name: /unlock/i }));

    // Retry fired with the same draft and succeeded.
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith('Garden Bee');
      expect(onClose).toHaveBeenCalled();
    });
    expect(api.renameModule).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem('hf_admin_key')).toBe('hf_dev_key_2026');
  });

  // --- Escape closes the modal -----------------------------------------

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(<RenameModuleModal module={mockModule} onClose={onClose} onSaved={vi.fn()} />);

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });
});
