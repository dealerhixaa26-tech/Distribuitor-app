/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.module.ts', '!src/main.ts', '!src/worker.ts'],
  coverageDirectory: 'coverage',
  testEnvironment: 'node',
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  // The workspace package is built to CommonJS; resolve it from dist so tests
  // exercise the same artifact the runtime loads.
  modulePaths: ['<rootDir>/../../node_modules'],
  coverageThreshold: {
    global: { statements: 60, branches: 50, functions: 55, lines: 60 },
  },
};
