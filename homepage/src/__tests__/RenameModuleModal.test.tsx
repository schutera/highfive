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
      login: vi.fn(),
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
  // The modal renders the rename input directly (needsKey starts false,
  // assuming the operator already holds a session cookie — #142 / ADR-019).
  // The 401 test below drives the api into the AdminKeyForm login branch.
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

  it('shows the admin-key form on 401 and retries after login succeeds', async () => {
    // Retry flow at the *modal* layer: the user types a name and clicks
    // Save, `api.renameModule` rejects with `Error('unauthorized')` (no
    // session cookie), the modal flips to AdminKeyForm, the user submits a
    // key, `api.login` succeeds (the server sets the cookie), and the modal
    // auto-retries `performRename` with the unchanged draft.
    //
    // Auth state lives entirely server-side now (#142 / ADR-019): the modal
    // never touches sessionStorage. We mock both api methods and assert the
    // login-then-retry sequence.
    (api.renameModule as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('unauthorized'))
      .mockResolvedValueOnce(undefined);
    (api.login as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(
      <LanguageProvider>
        <RenameModuleModal module={mockModule} onClose={onClose} onSaved={onSaved} />
      </LanguageProvider>,
    );

    // First attempt — the api stub rejects with 'unauthorized'.
    await userEvent.type(screen.getByLabelText(/display name/i), 'Garden Bee');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    // Modal flips to the AdminKeyForm branch on the message-string match.
    const keyInput = await screen.findByPlaceholderText(/enter admin key/i);
    await userEvent.type(keyInput, 'hf_dev_key_2026');
    await userEvent.click(screen.getByRole('button', { name: /unlock/i }));

    // submitAdminKey logged in (api.login), then auto-retried performRename
    // with the unchanged draft. A refactor that dropped the login call or the
    // auto-retry would break these assertions.
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith('Garden Bee');
      expect(onClose).toHaveBeenCalled();
    });
    expect(api.login).toHaveBeenCalledWith('hf_dev_key_2026');
    expect(api.renameModule).toHaveBeenCalledTimes(2);
    expect(api.renameModule).toHaveBeenNthCalledWith(2, mockModule.id, 'Garden Bee');
  });

  // --- Escape closes the modal -----------------------------------------

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(<RenameModuleModal module={mockModule} onClose={onClose} onSaved={vi.fn()} />);

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });
});
