// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Sheet } from './BillingUi';

afterEach(cleanup);
function Fixture() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Edit billing</button><a href="/overview">Background link</a>
    {open && <Sheet title="Edit billing details" onClose={() => setOpen(false)}><label>Name<input /></label><button>Save details</button></Sheet>}
  </>;
}
it('keeps keyboard focus inside the billing dialog and returns it to its opener', () => {
  render(<Fixture />);
  const opener = screen.getByRole('button', { name: 'Edit billing' });
  opener.focus(); fireEvent.click(opener);
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Edit billing details' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save details' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
});
