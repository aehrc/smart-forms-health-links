import type { LinkCodec } from './codec';
import { bespokeCodec } from './bespokeCodec';
import { shlCodec } from './shlCodec';

/**
 * Every codec the app knows about.
 *
 * Creating a link uses only the one named by `config.linkCodec`; reading a link tries all of them.
 * That asymmetry is what lets Phase 2 roll out without invalidating links already in the wild.
 */
export const LINK_CODECS: LinkCodec[] = [bespokeCodec, shlCodec];
