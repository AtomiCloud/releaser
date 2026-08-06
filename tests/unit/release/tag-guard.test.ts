import { describe, expect, it } from 'bun:test';
import { renderRefusal, TagGuard } from '../../../src/lib/release/tag-guard';
import { FakeTagReader } from '../../helpers/fakes';

function guard(all: string[], visible: string[] = [], mutate: (reader: FakeTagReader) => void = () => {}): TagGuard {
  const reader = new FakeTagReader();
  reader.all = all;
  reader.visible = visible;
  mutate(reader);
  return new TagGuard(reader);
}

/** The `tag-not-visible` message names the highest unreachable tag. */
async function highestUnreachable(all: string[]): Promise<string> {
  const refusal = await guard(all).checkVisibility();
  return refusal?.message ?? 'NO REFUSAL';
}

describe('tag guard', () => {
  describe('checkVersion', () => {
    it('should refuse a version whose tag already exists, prefixed or bare', async () => {
      // Act
      const prefixed = await guard(['v1.0.1']).checkVersion('1.0.1', 'v1.0.1');
      const bare = await guard(['1.0.1']).checkVersion('v1.0.1', 'v1.0.1');

      // Assert
      for (const refusal of [prefixed, bare]) {
        expect(refusal?.code).toBe('tag-collision');
        expect(refusal?.message).toContain('already taken');
      }
    });

    it('should refuse regardless of who minted the tag, because it cannot know', async () => {
      // Arrange — the port exposes no tagger, so the two cases are the SAME
      // call. This asserts the interface shape; the SIT arms mint real
      // annotated tags as two identities to prove the behaviour.
      const reader = new FakeTagReader();
      reader.all = ['v1.0.1'];

      // Assert — no member of the port can carry identity.
      expect(Object.keys(reader).filter(key => /tagger|committer|author|date|message/i.test(key))).toEqual([]);
      expect(await new TagGuard(reader).checkVersion('1.0.1', 'v1.0.1')).not.toBeNull();
    });

    it('should allow a free version — the must-differ control', async () => {
      // Act
      const actual = await guard(['v1.0.0', 'v1.0.1']).checkVersion('1.0.2', 'v1.0.2');

      // Assert — without this a guard that refused unconditionally would pass.
      expect(actual).toBeNull();
    });

    it('should refuse a collision on a NON-DEFAULT tag format', async () => {
      // Arrange — `tagFormat` is configurable, so the concrete ref the release
      // would create is the thing that must be free. Guessing `1.0.0`/`v1.0.0`
      // from the bare version would never look for this tag at all.
      const custom = await guard(['release-1.0.0']).checkVersion('1.0.0', 'release-1.0.0');
      const free = await guard(['release-0.9.0']).checkVersion('1.0.0', 'release-1.0.0');

      // Assert
      expect(custom?.code).toBe('tag-collision');
      expect(custom?.message).toContain('release-1.0.0');
      expect(free).toBeNull();
    });

    it('should refuse an unparseable version rather than guess what to check', async () => {
      // Act
      const actual = await guard([]).checkVersion('not-a-version', 'not-a-version');

      // Assert
      expect(actual?.code).toBe('invalid-version');
    });

    it('should refuse a MALFORMED version rather than accept it as a release', async () => {
      // Arrange — a separator with nothing after it, and a leading-zero
      // component, are not versions. Accepting them would let the guard report
      // a release version it could never have computed.
      for (const malformed of ['1.2.3-', '1.2.3+', '01.2.3', '1.2.3-rc..1', '1.02.3']) {
        // Act
        const actual = await guard([]).checkVersion(malformed, malformed);

        // Assert
        expect(actual?.code).toBe('invalid-version');
      }
    });

    it('should still accept every well-formed version — the must-differ control', async () => {
      // Arrange — the tightened grammar must not reject what it accepted
      // before. Without this arm a grammar that rejected everything would pass
      // the malformed cases above.
      for (const wellFormed of ['1.2.3', 'v1.2.3', 'v1.2.3-rc.1', '1.2.3+build.4', '1.0.0+build-4', '0.0.0']) {
        // Act
        const actual = await guard([]).checkVersion(wellFormed, wellFormed);

        // Assert — parsed, so it reaches the collision test and finds it free.
        expect(actual).toBeNull();
      }
    });
  });

  describe('checkVisibility', () => {
    it('should refuse when a version tag exists that HEAD cannot reach', async () => {
      // Act — this is the measured incident: tags exist, none are reachable.
      const actual = await guard(['v1.0.0', 'v1.0.1'], []).checkVisibility();

      // Assert
      expect(actual?.code).toBe('tag-not-visible');
      expect(actual?.message).toContain('v1.0.1');
      expect(actual?.message).toContain('committed release with no tag');
    });

    it('should pass when every version tag is reachable — the must-differ control', async () => {
      // Act
      const actual = await guard(['v1.0.0', 'v1.0.1'], ['v1.0.0', 'v1.0.1']).checkVisibility();

      // Assert
      expect(actual).toBeNull();
    });

    it('should ignore floating major and minor tags that move by design', async () => {
      // Arrange — semantic-release-major-tag mints and MOVES v3 and v3.1.
      // Counting them would make every release refuse itself.
      const actual = await guard(['v3', 'v3.1'], []).checkVisibility();

      // Assert
      expect(actual).toBeNull();
    });

    it('should not count a MALFORMED tag as a blocking version tag', async () => {
      // Arrange — these are unreachable and version-shaped enough to be
      // mistaken for versions. Counting them would refuse a release over a tag
      // that is not a version at all.
      const actual = await guard(['1.2.3-', '1.2.3+', '01.2.3'], []).checkVisibility();

      // Assert
      expect(actual).toBeNull();
    });

    it('should still count a well-formed unreachable tag beside malformed ones', async () => {
      // Arrange — the population control for the arm above: the same call DOES
      // refuse when a real version tag is present, so the null there means
      // "not counted" rather than "checkVisibility stopped working".
      const actual = await guard(['1.2.3-', '01.2.3', 'v2.0.0'], []).checkVisibility();

      // Assert — only the well-formed tag is named.
      expect(actual?.code).toBe('tag-not-visible');
      expect(actual?.message).toContain('highest: v2.0.0');
      expect(actual?.message).toContain('1 version tag(s)');
    });

    it('should name the highest unreachable tag across every ordering rule', async () => {
      // Assert — each case drives a different comparison branch.
      expect(await highestUnreachable(['1.0.0', '2.0.0'])).toContain('highest: 2.0.0');
      expect(await highestUnreachable(['1.1.0', '1.0.0'])).toContain('highest: 1.1.0');
      expect(await highestUnreachable(['1.0.1', '1.0.0'])).toContain('highest: 1.0.1');
      // A release outranks its own prerelease, in both argument orders.
      expect(await highestUnreachable(['1.0.0', '1.0.0-rc.1'])).toContain('highest: 1.0.0');
      expect(await highestUnreachable(['1.0.0-rc.1', '1.0.0'])).toContain('highest: 1.0.0');
      // Two prereleases of the same release compare lexically.
      expect(await highestUnreachable(['1.0.0-rc.1', '1.0.0-rc.2'])).toContain('highest: 1.0.0-rc.2');
      // Equal precedence keeps the first.
      expect(await highestUnreachable(['1.0.0-rc.1', 'v1.0.0-rc.1'])).toContain('highest: 1.0.0-rc.1');
    });

    it('should not read a dash inside build metadata as a prerelease', async () => {
      // Arrange — `1.0.0+build-4` is a RELEASE. Recovering the prerelease by
      // scanning for the first dash would read it as `4` and rank it below
      // plain `1.0.0`, naming the wrong tag as highest.
      const actual = await highestUnreachable(['1.0.0-rc.1', '1.0.0+build-4']);

      // Assert
      expect(actual).toContain('highest: 1.0.0+build-4');
    });
  });

  describe('preflight', () => {
    it('should REFUSE a shallow clone rather than report a clear result', async () => {
      // Act
      const actual = await guard([], [], reader => {
        reader.shallow = true;
      }).checkVisibility();

      // Assert — an incomplete population cannot produce a clean verdict.
      expect(actual?.code).toBe('shallow-clone');
      expect(actual?.message).toContain('cannot be ruled out');
    });

    it('should REFUSE when the repository cannot be inspected at all', async () => {
      // Act
      const visibility = await guard([], [], reader => {
        reader.failure = new Error('not a git repository');
      }).checkVisibility();
      const version = await guard([], [], reader => {
        reader.failure = new Error('not a git repository');
      }).checkVersion('1.0.0', 'v1.0.0');

      // Assert — "I could not look" is not "I looked and it is clear".
      expect(visibility?.code).toBe('not-a-git-repo');
      expect(version?.code).toBe('not-a-git-repo');
      expect(visibility?.message).toContain('not a git repository');
    });

    it('should carry a non-Error failure through as text', async () => {
      // Act
      const actual = await guard([], [], reader => {
        reader.failure = 'permission denied' as unknown as Error;
      }).checkVisibility();

      // Assert
      expect(actual?.code).toBe('not-a-git-repo');
      expect(actual?.message).toContain('permission denied');
    });
  });

  it('should render a refusal as code-then-message so CI can grep the code', async () => {
    // Arrange
    const refusal = await guard(['v1.0.1']).checkVersion('1.0.1', 'v1.0.1');
    if (refusal === null) throw new Error('expected a refusal');

    // Act
    const actual = renderRefusal(refusal);

    // Assert
    expect(actual).toStartWith('tag-collision: ');
  });
});
