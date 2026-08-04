import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import shared from '@hixaa/config/eslint/next';

/**
 * Shared workspace rules, plus Next.js's own checks.
 *
 * `next/core-web-vitals` catches a class of mistake generic TypeScript linting
 * cannot see — unoptimised images, blocking scripts, App Router conventions —
 * and its absence is what `next build` warns about.
 *
 * eslint-config-next v16 ships native flat configs, so this composes directly.
 * The FlatCompat bridge is not just unnecessary here, it fails: the config has
 * a self-referencing `react` plugin entry that the eslintrc validator cannot
 * serialise.
 */
export default [...shared, ...nextCoreWebVitals];
