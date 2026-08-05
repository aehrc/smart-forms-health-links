import type { LinkCodec } from './codec';
import { bespokeCodec } from './bespokeCodec';
import { shlCodec } from './shlCodec';

/**
 * Every codec the app knows about.
 *
 * Creating a link uses only the one named by `config.linkCodec`; reading a link tries all of them.
 * That asymmetry is what lets a transport be retired without invalidating links already in the
 * wild — `sfhl:/` is decode-only and still listed here for exactly that reason.
 */
export const LINK_CODECS: LinkCodec[] = [bespokeCodec, shlCodec];
