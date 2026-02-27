import { describe, it, expect } from 'vitest';
import { isHtmlPreviewCompletion } from '../src/agent-loop.js';

describe('isHtmlPreviewCompletion', () => {
  it('treats empty html_preview completion as terminal', () => {
    expect(isHtmlPreviewCompletion(true, true, 'html_preview')).toBe(true);
  });

  it('does not treat other tool completions as terminal', () => {
    expect(isHtmlPreviewCompletion(true, true, 'write_file')).toBe(false);
    expect(isHtmlPreviewCompletion(true, false, 'html_preview')).toBe(false);
    expect(isHtmlPreviewCompletion(false, true, 'html_preview')).toBe(false);
  });
});
