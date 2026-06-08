import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// The admin gate is now a real server-side session (#142 / ADR-019). These
// tests pin the LoginGate behaviour: it calls `api.login()` (NOT the old
// `fetch('/api/health')` no-op), shows an error on a wrong key, and reveals
// the admin surface only after a successful login or an existing session
// (`api.checkSession()`). The api is fully mocked so no network is touched.

// vi.hoisted so the object exists when the hoisted vi.mock factory runs.
const mockApi = vi.hoisted(() => ({
  checkSession: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  getAllModules: vi.fn(),
  getImages: vi.fn(),
  getImageUrl: vi.fn((f: string) => `/api/images/${f}`),
  deleteModule: vi.fn(),
  deleteImage: vi.fn(),
}));

vi.mock('../services/api', () => ({ api: mockApi }));

import AdminPage from '../pages/AdminPage';
import { parseModuleId, type Module } from '@highfive/contracts';

function makeModule(location: { lat: number; lng: number }): Module {
  return {
    id: parseModuleId('aabbccddeeff'),
    name: 'fierce-apricot-specht',
    displayName: null,
    location,
    status: 'online',
    lastApiCall: '2026-05-16T20:00:00.000Z',
    batteryLevel: 88,
    firstOnline: '2026-05-16',
    totalHatches: 0,
    imageCount: 0,
    email: null,
    updatedAt: '2026-05-16T20:00:00.000Z',
    lastSeenAt: '2026-05-16T20:00:00.000Z',
    latestHeartbeat: null,
  };
}

function renderAdmin() {
  return render(
    <MemoryRouter>
      <AdminPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.logout.mockResolvedValue(undefined);
  mockApi.getAllModules.mockResolvedValue([]);
  mockApi.getImages.mockResolvedValue({ images: [], total: 0 });
});

describe('AdminPage login gate', () => {
  it('shows the login form when there is no session', async () => {
    mockApi.checkSession.mockResolvedValue(false);
    renderAdmin();

    expect(await screen.findByText(/admin access/i)).toBeInTheDocument();
    expect(mockApi.getAllModules).not.toHaveBeenCalled();
  });

  it('logs in via api.login() and reveals the admin surface on success', async () => {
    mockApi.checkSession.mockResolvedValue(false);
    mockApi.login.mockResolvedValue(true);
    renderAdmin();

    const input = await screen.findByPlaceholderText(/api key/i);
    await userEvent.type(input, 'hf_dev_key_2026');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(mockApi.login).toHaveBeenCalledWith('hf_dev_key_2026');
    // Admin surface loads its data once authenticated.
    await waitFor(() => expect(mockApi.getAllModules).toHaveBeenCalled());
  });

  it('shows an error and stays on the form when the key is wrong', async () => {
    mockApi.checkSession.mockResolvedValue(false);
    mockApi.login.mockResolvedValue(false);
    renderAdmin();

    const input = await screen.findByPlaceholderText(/api key/i);
    await userEvent.type(input, 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/invalid api key/i)).toBeInTheDocument();
    expect(mockApi.getAllModules).not.toHaveBeenCalled();
  });

  it('skips the form when an existing session cookie is present', async () => {
    mockApi.checkSession.mockResolvedValue(true);
    renderAdmin();

    await waitFor(() => expect(mockApi.getAllModules).toHaveBeenCalled());
    expect(screen.queryByText(/admin access/i)).not.toBeInTheDocument();
  });
});

describe('AdminPage coordinate display (issue #145, ADR-020)', () => {
  it('renders module coordinates at 2 dp, never finer', async () => {
    // The wire is already generalized server-side (see backend
    // coarsen-location.test). This pins the admin table as the last line of
    // defence: even fed a precise value it must render ~1 km / 2 dp — admins
    // get no finer precision than anyone else ("coarsen for everyone").
    mockApi.checkSession.mockResolvedValue(true);
    mockApi.getAllModules.mockResolvedValue([makeModule({ lat: 47.808612, lng: 9.643301 })]);
    renderAdmin();

    // Coords are rendered as two adjacent text nodes ("47.81", "9.64").
    expect(await screen.findByText(/47\.81/)).toBeInTheDocument();
    expect(screen.getByText(/9\.64/)).toBeInTheDocument();
    // The precise low-order digits must never reach the DOM.
    expect(screen.queryByText(/47\.8086/)).not.toBeInTheDocument();
  });
});
