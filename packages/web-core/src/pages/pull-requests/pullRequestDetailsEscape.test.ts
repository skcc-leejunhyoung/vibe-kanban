import { describe, expect, it, vi } from 'vitest';
import { handlePullRequestDetailsEscape } from './pullRequestDetailsEscape';

function createEscapeEvent(defaultPrevented = false) {
  return {
    key: 'Escape',
    defaultPrevented,
    preventDefault: vi.fn(),
  };
}

describe('handlePullRequestDetailsEscape', () => {
  it('blurs a focused control without closing the details panel', () => {
    const event = createEscapeEvent();
    const blur = vi.fn();
    const closeDetails = vi.fn();

    handlePullRequestDetailsEscape(
      event,
      {
        closest: () => ({}) as Element,
        blur,
      },
      closeDetails
    );

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(blur).toHaveBeenCalledOnce();
    expect(closeDetails).not.toHaveBeenCalled();
  });

  it('closes the details panel when no control has focus', () => {
    const event = createEscapeEvent();
    const closeDetails = vi.fn();

    handlePullRequestDetailsEscape(
      event,
      {
        closest: () => null,
        blur: vi.fn(),
      },
      closeDetails
    );

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(closeDetails).toHaveBeenCalledOnce();
  });

  it('leaves an already handled Escape event alone', () => {
    const event = createEscapeEvent(true);
    const closeDetails = vi.fn();

    handlePullRequestDetailsEscape(event, null, closeDetails);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(closeDetails).not.toHaveBeenCalled();
  });
});
