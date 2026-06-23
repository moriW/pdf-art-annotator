# Repository Guidelines

## Project Structure & Module Organization

This is an Obsidian community plugin built with TypeScript and bundled to root-level `main.js`.

- `src/main.ts` wires plugin lifecycle, settings, commands, ribbon actions, and workspace events.
- `src/commands.ts`, `src/tool-view.ts`, `src/native-overlay.ts`, `src/leaf-state.ts`, and `src/page-overlay.ts` contain the command palette, right-sidebar UI, native PDF overlay scheduling, per-leaf state, and page canvas behavior.
- `src/storage.ts` owns annotation JSON persistence under `PDF Art Annotations/`.
- `src/types.ts` defines shared annotation and settings types.
- `tests/` contains Vitest tests; `__mocks__/obsidian.ts` provides the Obsidian API mock.
- Root files such as `manifest.json`, `styles.css`, `build.js`, and `versions.json` are plugin distribution/config assets.

## Build, Test, and Development Commands

- `npm ci` installs exact dependencies from `package-lock.json`.
- `npm run dev` runs `node build.js` with inline sourcemaps for local development.
- `npm run typecheck` runs strict TypeScript checks without emitting files.
- `npm run build` runs typecheck, then creates the production bundle.
- `npm test` or `npm run test` runs the Vitest suite once.

## Coding Style & Naming Conventions

Use TypeScript targeting ES2022 with strict mode enabled. Follow the existing style: 2-space indentation, semicolons, double-quoted imports/strings, `PascalCase` classes/types, `camelCase` functions and variables, and concise module-level constants in `SCREAMING_SNAKE_CASE` when appropriate. UI text should remain Chinese; code identifiers should remain English. Prefer Obsidian-native APIs and direct DOM integration with the native PDF viewer rather than introducing a custom viewer.

## Testing Guidelines

Tests use Vitest and should live in `tests/*.test.ts`. Keep unit tests focused on stable behavior and edge cases, especially storage migration, path normalization, annotation mutation, and pointer/overlay behavior when practical. Use the Obsidian mock instead of importing real app state. Run `npm test` and `npm run typecheck` before submitting changes that touch source.

## Commit & Pull Request Guidelines

Recent history uses short imperative commits, sometimes Conventional Commit prefixes such as `feat:`. Prefer `type: concise summary` when useful, for example `fix: preserve highlighter opacity`. Pull requests should include a clear behavior summary, linked issue or motivation, test results, and screenshots or short recordings for visible PDF overlay or sidebar UI changes.

## Agent-Specific Notes

Keep changes narrow. Annotation storage intentionally uses `vault.adapter` instead of `vault.create`, `vault.read`, or `vault.process` to reduce sync-plugin churn during drawing; preserve that design unless the persistence strategy is explicitly being revised. Avoid unrelated generated output churn in `main.js` unless the task is a build or release step.
