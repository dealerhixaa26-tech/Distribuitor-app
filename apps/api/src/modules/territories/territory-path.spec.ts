import {
  ancestorIds,
  buildPath,
  depthOf,
  isWithinSubtree,
  rewritePath,
  subtreePattern,
  wouldCreateCycle,
} from './territory-path';

/**
 * The materialised path is what every territory-scoped query consults, so a
 * defect here silently widens or narrows someone's data boundary.
 */
describe('buildPath', () => {
  it('wraps a root in leading and trailing separators', () => {
    expect(buildPath(null, 'zone')).toBe('.zone.');
    expect(buildPath('', 'zone')).toBe('.zone.');
  });

  it('appends to a parent path', () => {
    expect(buildPath('.zone.', 'region')).toBe('.zone.region.');
    expect(buildPath('.zone.region.', 'district')).toBe('.zone.region.district.');
  });
});

describe('separator discipline', () => {
  it('prevents one id prefix-matching another', () => {
    // Without the trailing dot, '.ab.' would prefix-match '.abc.' and pull an
    // unrelated subtree into a scope check.
    expect(isWithinSubtree(buildPath(null, 'abc'), buildPath(null, 'ab'))).toBe(false);
    expect(isWithinSubtree(buildPath('.ab.', 'x'), '.ab.')).toBe(true);
  });
});

describe('depthOf', () => {
  it('counts ancestors, so a root is depth 0', () => {
    expect(depthOf('.zone.')).toBe(0);
    expect(depthOf('.zone.region.')).toBe(1);
    expect(depthOf('.zone.region.district.')).toBe(2);
  });
});

describe('ancestorIds', () => {
  it('lists ancestors root-first, excluding the node itself', () => {
    expect(ancestorIds('.zone.region.district.')).toEqual(['zone', 'region']);
    expect(ancestorIds('.zone.')).toEqual([]);
  });
});

describe('subtreePattern', () => {
  it('matches the node and everything beneath it', () => {
    const pattern = subtreePattern('.west.');
    expect(pattern).toBe('.west.%');
    // A scope assignment to a zone must include the zone itself, or a manager
    // could not see the territory they own.
    expect(isWithinSubtree('.west.', '.west.')).toBe(true);
    expect(isWithinSubtree('.west.mh.', '.west.')).toBe(true);
    expect(isWithinSubtree('.south.tn.', '.west.')).toBe(false);
  });
});

describe('rewritePath', () => {
  it('reparents a descendant when its subtree moves', () => {
    expect(rewritePath('.a.b.c.', '.a.b.', '.x.b.')).toBe('.x.b.c.');
  });

  it('rewrites the moved node itself', () => {
    expect(rewritePath('.a.b.', '.a.b.', '.x.b.')).toBe('.x.b.');
  });

  it('leaves unrelated paths alone', () => {
    expect(rewritePath('.q.r.', '.a.b.', '.x.b.')).toBe('.q.r.');
  });

  it('handles a move to root', () => {
    expect(rewritePath('.a.b.c.', '.a.b.', '.b.')).toBe('.b.c.');
  });

  it('keeps depth consistent after a move', () => {
    const moved = rewritePath('.a.b.c.', '.a.b.', '.x.y.b.');
    expect(moved).toBe('.x.y.b.c.');
    expect(depthOf(moved)).toBe(3);
  });
});

describe('wouldCreateCycle', () => {
  it('rejects moving a node beneath its own descendant', () => {
    // The tree stops being a tree: the subtree detaches into an unreachable
    // cycle and every recursive read either loops or loses rows.
    expect(wouldCreateCycle('.a.', '.a.b.')).toBe(true);
    expect(wouldCreateCycle('.a.b.', '.a.b.c.d.')).toBe(true);
  });

  it('rejects moving a node beneath itself', () => {
    expect(wouldCreateCycle('.a.b.', '.a.b.')).toBe(true);
  });

  it('allows a legitimate move to an unrelated branch', () => {
    expect(wouldCreateCycle('.a.b.', '.x.')).toBe(false);
    expect(wouldCreateCycle('.a.b.', '.x.y.')).toBe(false);
  });

  it('allows moving a node to its own parent’s sibling', () => {
    expect(wouldCreateCycle('.west.mh.', '.central.')).toBe(false);
  });
});
