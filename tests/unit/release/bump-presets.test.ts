import { describe, expect, it } from 'bun:test';
import {
  BumpError,
  bumpPath,
  bumpPreset,
  bumpPresetNames,
  normalizeVersion,
} from '../../../src/lib/release/bump-presets';

function apply(type: Parameters<typeof bumpPreset>[0], path: string, content: string, version = '2.0.0'): string {
  return bumpPreset(type).apply(path, content, version).content;
}

describe('bump presets', () => {
  describe('shared rules', () => {
    it('should REFUSE to create an absent field rather than write one', () => {
      // Arrange — a manifest with no version at all.
      const content = '{\n  "name": "thing"\n}\n';

      // Act
      const act = () => apply('node-version', 'package.json', content);

      // Assert — introducing a version field is a project-shape change.
      expect(act).toThrow(BumpError);
      expect(act).toThrow(/declares no .*version/);
      expect(act).toThrow(/package\.json/);
    });

    it('should REFUSE an ambiguous field rather than take the first match', () => {
      // Arrange — two <Version> properties, no way to know which is the project's.
      const content = '<Project>\n  <Version>1.0.0</Version>\n  <Version>1.0.0</Version>\n</Project>\n';

      // Act
      const act = () => apply('dotnet-version', 'Version.props', content);

      // Assert — first-match-wins is how a glob silently picks the wrong file.
      expect(act).toThrow(BumpError);
      expect(act).toThrow(/2 times/);
    });

    it('should refuse a version that would deform the host document', () => {
      // Act
      const act = () => apply('node-version', 'package.json', '{\n  "version": "1.0.0"\n}\n', 'not a version');

      // Assert
      expect(act).toThrow(BumpError);
      expect(act).toThrow(/not a usable version/);
    });

    it('should strip a single leading v, matching the scripts it replaces', () => {
      // Assert — a tag-shaped v1.2.3 written verbatim is invalid semver for npm.
      expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
      // Not a version-looking v, so it is left alone.
      expect(normalizeVersion('valpha')).toBe('valpha');
      expect(normalizeVersion('1.2.3')).toBe('1.2.3');
    });

    it('should report the previous value and leave every other byte untouched', () => {
      // Arrange
      const content = '{\n  "name": "thing",\n  "version": "1.0.0",\n  "private": true\n}\n';

      // Act
      const outcome = bumpPreset('node-version').apply('package.json', content, '2.0.0');

      // Assert
      expect(outcome.from).toBe('1.0.0');
      expect(outcome.content).toBe('{\n  "name": "thing",\n  "version": "2.0.0",\n  "private": true\n}\n');
    });
  });

  describe('node-version', () => {
    it('should bump the top-level version and ignore a nested one', () => {
      // Arrange — a dependency carrying its own version must not be mistaken
      // for the manifest's, which is why the pattern anchors to one indent.
      const content =
        '{\n  "version": "1.0.0",\n  "dependencies": {\n    "dep": {\n      "version": "9.9.9"\n    }\n  }\n}\n';

      // Act
      const actual = apply('node-version', 'package.json', content);

      // Assert
      expect(actual).toContain('"version": "2.0.0"');
      expect(actual).toContain('"version": "9.9.9"');
    });
  });

  describe('dart-version', () => {
    it('should bump a top-level pubspec version', () => {
      // Act
      const actual = apply('dart-version', 'pubspec.yaml', 'name: thing\nversion: 1.0.0\nhomepage: x\n');

      // Assert
      expect(actual).toBe('name: thing\nversion: 2.0.0\nhomepage: x\n');
    });

    it('should bump a quoted pubspec version', () => {
      // Act
      const actual = apply('dart-version', 'pubspec.yaml', "name: thing\nversion: '1.0.0'\n");

      // Assert
      expect(actual).toBe("name: thing\nversion: '2.0.0'\n");
    });
  });

  describe('dotnet-version', () => {
    it('should bump a single Version property', () => {
      // Act
      const actual = apply('dotnet-version', 'Version.props', '<Project>\n  <Version>1.0.0</Version>\n</Project>\n');

      // Assert
      expect(actual).toBe('<Project>\n  <Version>2.0.0</Version>\n</Project>\n');
    });
  });

  describe('plain-version — the fourth preset', () => {
    it('should replace the whole version line and preserve the trailing newline', () => {
      // Act
      const outcome = bumpPreset('plain-version').apply('VERSION', '1.0.0\n', 'v2.0.0');

      // Assert — the v is stripped and the file stays a bare version plus newline.
      expect(outcome.from).toBe('1.0.0');
      expect(outcome.content).toBe('2.0.0\n');
    });

    it('should preserve a file with no trailing newline', () => {
      // Act
      const actual = apply('plain-version', 'VERSION', '1.0.0');

      // Assert
      expect(actual).toBe('2.0.0');
    });

    it('should treat a blank file as ABSENT rather than write a version into it', () => {
      // Act — the shared never-create rule, mapped onto a file with no syntax.
      const act = () => apply('plain-version', 'VERSION', '\n \n');

      // Assert
      expect(act).toThrow(BumpError);
      expect(act).toThrow(/declares no/);
    });

    it('should treat a multi-line file as AMBIGUOUS rather than pick a line', () => {
      // Act
      const act = () => apply('plain-version', 'VERSION', '1.0.0\nsomething-else\n');

      // Assert
      expect(act).toThrow(BumpError);
      expect(act).toThrow(/2 times/);
    });
  });

  describe('path resolution', () => {
    it('should use the built-in default when no file is named', () => {
      // Assert
      expect(bumpPath('node-version', null)).toBe('package.json');
      expect(bumpPath('plain-version', null)).toBe('VERSION');
    });

    it('should prefer an override, which is the NON-ROOT case dart-lib needs', () => {
      // Assert — dart-lib's pubspec is at packages/<name>/, not the repo root,
      // so override-as-normal is the design rather than an exception.
      expect(bumpPath('dart-version', 'packages/diene_dart_lib/pubspec.yaml')).toBe(
        'packages/diene_dart_lib/pubspec.yaml',
      );
    });

    it('should REFUSE dotnet-version with no file, because no default can be correct', () => {
      // Act
      const act = () => bumpPath('dotnet-version', null);

      // Assert — the version lives in a different file in every dotnet tree
      // measured, so a default would write to the wrong one rather than complain.
      expect(act).toThrow(BumpError);
      expect(act).toThrow(/must name one explicitly/);
    });

    it('should reject an unknown bump type', () => {
      // Act
      const act = () => bumpPreset('nope' as 'node-version');

      // Assert
      expect(act).toThrow(BumpError);
    });
  });

  it('should expose exactly the four shipped preset names', () => {
    // Assert — a name added without a preset, or a preset without a name, shows here.
    expect([...bumpPresetNames()].sort()).toEqual(['dart-version', 'dotnet-version', 'node-version', 'plain-version']);
  });
});
