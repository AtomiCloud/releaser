import { describe, expect, it } from 'bun:test';
import { unifiedDiff } from '../../../src/lib/release/line-diff';

describe('line diff', () => {
  it('should return the empty string for byte-identical bodies', () => {
    // Arrange
    const body = '# Title\n\nalpha\n';

    // Act
    const actual = unifiedDiff(body, body);

    // Assert
    expect(actual).toBe('');
  });

  it('should treat an empty body and an unterminated body as distinct from a terminated one', () => {
    // Act — the three splitting cases, observed through the public surface so
    // the module keeps a single export and knip stays clean.
    const fromEmpty = unifiedDiff('', 'a\n');
    const unterminated = unifiedDiff('a\nb', 'a\nb\n');
    const terminated = unifiedDiff('a\nb\n', 'a\nb\n');

    // Assert
    expect(fromEmpty).toContain('+a');
    expect(unterminated).toContain('\\ expected has no newline at end of file');
    expect(terminated).toBe('');
  });

  it('should detect a body that differs only by an appended newline', () => {
    // Arrange
    const expectedBody = 'alpha\n';
    const actualBody = 'alpha';

    // Act
    const actual = unifiedDiff(expectedBody, actualBody);

    // Assert
    expect(actual).toContain('(lines are identical; only the trailing newline differs)');
    expect(actual).toContain('\\ actual has no newline at end of file');
  });

  it('should note when the expected side is the one missing a trailing newline', () => {
    // Act
    const actual = unifiedDiff('alpha', 'alpha\n');

    // Assert
    expect(actual).toContain('\\ expected has no newline at end of file');
  });

  it('should render a pure addition against an empty expected body', () => {
    // Act
    const actual = unifiedDiff('', 'alpha\n');

    // Assert
    expect(actual).toContain('@@ -0,0 +1,1 @@');
    expect(actual).toContain('+alpha');
  });

  it('should render a pure deletion against an empty actual body', () => {
    // Act
    const actual = unifiedDiff('alpha\n', '');

    // Assert
    expect(actual).toContain('@@ -1,1 +0,0 @@');
    expect(actual).toContain('-alpha');
  });

  it('should render deletions, additions and context with custom labels', () => {
    // Arrange
    const expectedBody = 'alpha\nbravo\ncharlie\n';
    const actualBody = 'alpha\nBRAVO\ncharlie\n';

    // Act
    const actual = unifiedDiff(expectedBody, actualBody, {
      expectedLabel: 'generated',
      actualLabel: 'on disk',
    });

    // Assert
    expect(actual).toContain('--- generated');
    expect(actual).toContain('+++ on disk');
    expect(actual).toContain('-bravo');
    expect(actual).toContain('+BRAVO');
    expect(actual).toContain(' alpha');
    expect(actual).toContain(' charlie');
  });

  it('should merge two nearby change regions into a single hunk', () => {
    // Arrange
    const expectedBody = 'a\nb\nc\nd\ne\n';
    const actualBody = 'X\nb\nc\nY\ne\n';

    // Act
    const actual = unifiedDiff(expectedBody, actualBody, { context: 1 });

    // Assert
    expect(actual.split('\n').filter(line => line.startsWith('@@'))).toHaveLength(1);
  });

  it('should keep two distant change regions in separate hunks', () => {
    // Arrange
    const expectedBody = 'a\nb\nc\nd\ne\nf\ng\n';
    const actualBody = 'X\nb\nc\nd\ne\nf\nY\n';

    // Act
    const actual = unifiedDiff(expectedBody, actualBody, { context: 0 });

    // Assert
    expect(actual.split('\n').filter(line => line.startsWith('@@'))).toHaveLength(2);
    expect(actual).toContain('-a');
    expect(actual).toContain('+X');
    expect(actual).toContain('-g');
    expect(actual).toContain('+Y');
  });

  it('should render trailing insertions when the actual body is longer', () => {
    // Act
    const actual = unifiedDiff('a\n', 'a\nb\nc\n');

    // Assert
    expect(actual).toContain('+b');
    expect(actual).toContain('+c');
  });

  it('should degrade to a summary when the diff table would be too large', () => {
    // Arrange
    const expectedBody = 'a\nb\nc\nd\n';
    const actualBody = 'a\nZ\nc\nd\n';

    // Act
    const actual = unifiedDiff(expectedBody, actualBody, { maxCells: 4 });

    // Assert
    expect(actual).toContain('too large to diff: 4 expected lines vs 4 actual lines');
    expect(actual).toContain('first difference at line 2');
  });

  it('should report the first differing line past the shorter body when one is a prefix', () => {
    // Act
    const actual = unifiedDiff('a\nb\n', 'a\nb\nc\nd\n', { maxCells: 4 });

    // Assert
    expect(actual).toContain('first difference at line 3');
  });
});
