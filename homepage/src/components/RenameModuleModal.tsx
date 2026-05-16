import { useEffect, useRef, useState } from 'react';
import type { Module } from '@highfive/contracts';
import { api, RenameConflictError } from '../services/api';
import AdminKeyForm from './AdminKeyForm';

const ADMIN_KEY_STORAGE = 'hf_admin_key';

function hasAdminKey(): boolean {
  if (typeof window === 'undefined') return false;
  return !!sessionStorage.getItem(ADMIN_KEY_STORAGE);
}

interface RenameModuleModalProps {
  module: Pick<Module, 'id' | 'name' | 'displayName'>;
  onClose: () => void;
  // Called after a successful PATCH so the caller can update its local
  // module list without a full refetch. `displayName` is the new value
  // (null when the operator cleared the override).
  onSaved: (displayName: string | null) => void;
}

// Lightweight modal: input + Save + Cancel. Surfaces 409 collision errors
// inline. Empty input clears the override (sends `display_name: null`).
//
// Reuses the existing `hf_admin_key` sessionStorage plumbing via
// `api.renameModule`. If no key is stored when the user hits Save, the
// inline AdminKeyForm prompts for it and the rename retries automatically.
// See ADR-011 and issue #93.
export default function RenameModuleModal({ module, onClose, onSaved }: RenameModuleModalProps) {
  // Pre-fill with current displayName (or empty string when null) so the
  // operator sees what they're editing rather than the firmware name.
  const [draft, setDraft] = useState<string>(module.displayName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsKey, setNeedsKey] = useState<boolean>(!hasAdminKey());
  const [keyError, setKeyError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [needsKey]);

  // Close on Escape so the modal is keyboard-friendly. Bound on mount
  // and torn down on unmount — never leaks past the modal lifetime.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const performRename = async () => {
    setBusy(true);
    setError(null);
    setKeyError(null);
    try {
      const trimmed = draft.trim();
      const value = trimmed === '' ? null : trimmed;
      await api.renameModule(module.id, value);
      onSaved(value);
      onClose();
    } catch (err) {
      if (err instanceof RenameConflictError) {
        // Leading 4 hex (matches the disambiguator subtitle elsewhere).
        // Trailing 4 would collide for same-batch hardware.
        const macLabel = err.conflictingModuleId.slice(0, 4).toUpperCase();
        setError(
          `Name "${err.displayName}" is already used by module ${macLabel}. Pick a different name.`,
        );
      } else if (err instanceof Error && err.message === 'unauthorized') {
        // api.renameModule already cleared the key from sessionStorage.
        setNeedsKey(true);
        setKeyError('Invalid admin key. Try again.');
      } else {
        setError('Save failed. Please try again.');
        // eslint-disable-next-line no-console
        console.error('rename failed:', err);
      }
    } finally {
      setBusy(false);
    }
  };

  const submitAdminKey = (key: string) => {
    if (typeof window === 'undefined') return;
    sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
    setNeedsKey(false);
    setKeyError(null);
    // Retry the save now that the key is in place.
    void performRename();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (needsKey) return; // The AdminKeyForm handles its own submit.
    void performRename();
  };

  const currentLabel = module.displayName ?? module.name;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Rename module"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-lg w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Rename module</h2>
        <p className="text-xs text-gray-500 font-mono mb-4">
          {module.id} &middot; currently shown as{' '}
          <span className="font-semibold">{currentLabel}</span>
        </p>

        {needsKey ? (
          <AdminKeyForm onSubmit={submitAdminKey} onCancel={onClose} busy={busy} error={keyError} />
        ) : (
          <form onSubmit={handleSubmit}>
            <label htmlFor="rename-input" className="block text-sm font-medium text-gray-700 mb-1">
              Display name
            </label>
            <input
              id="rename-input"
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={100}
              placeholder="Leave empty to clear the override"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none mb-1"
            />
            <p className="text-xs text-gray-400 mb-3">
              Leave empty and save to fall back to the firmware-reported name.
            </p>
            {error && <p className="text-red-600 text-xs mb-3">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800"
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="px-4 py-2 text-sm font-medium bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300 text-white rounded-lg transition-colors"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
