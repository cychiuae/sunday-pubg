/**
 * Vite config for E2E stacks (owner: qa-tester): the root vite.config.ts with HMR and file watching off, so edits
 * landing in src/ during a run cannot full-reload the page mid-test.
 */
import { mergeConfig } from 'vite';
import base from '../../../vite.config';

export default mergeConfig(base, { server: { hmr: false, watch: null } });
