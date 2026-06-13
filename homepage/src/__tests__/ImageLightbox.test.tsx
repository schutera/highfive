import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import ImageLightbox from '../components/ImageLightbox';

// Shared by the admin gallery (caption carries module info + Delete) and
// the public module panel (caption carries label + timestamp). The close
// affordances — Escape, backdrop click, close button — live here; the
// caption content is entirely the caller's, so the component itself must
// never grow a destructive action.

const renderLightbox = (props: Partial<React.ComponentProps<typeof ImageLightbox>> = {}) => {
  const onClose = vi.fn();
  render(
    <ImageLightbox
      src="http://localhost:3002/api/images/esp_capture_1781234567890.jpg"
      alt="Latest capture from Garden Bee"
      onClose={onClose}
      {...props}
    />,
  );
  return onClose;
};

describe('ImageLightbox', () => {
  it('renders the image as an accessible dialog', () => {
    renderLightbox();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByAltText('Latest capture from Garden Bee')).toHaveAttribute(
      'src',
      'http://localhost:3002/api/images/esp_capture_1781234567890.jpg',
    );
  });

  it('closes on Escape', () => {
    const onClose = renderLightbox();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop click but not on clicks inside the content', () => {
    const onClose = renderLightbox();
    fireEvent.click(screen.getByAltText('Latest capture from Garden Bee'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes via the close button, honouring a custom label', () => {
    const onClose = renderLightbox({ closeLabel: 'Schließen' });
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders caller-provided caption content', () => {
    renderLightbox({ caption: <span>11 Jun 2026, 10:30 AM</span> });
    expect(screen.getByText('11 Jun 2026, 10:30 AM')).toBeInTheDocument();
  });

  it('has no Delete affordance of its own (admin passes it via caption)', () => {
    renderLightbox();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});
