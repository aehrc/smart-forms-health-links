import { bespokeCodec } from "./bespokeCodec";
import { shlCodec } from "./shlCodec";

import type { LinkCodec } from "./codec";

/**
 * Every codec the app knows about.
 *
 * Reading a link tries all of them; creating one no longer chooses between them. An invitation is
 * minted by the server as a manifest-mode `shlink:/`, and the filler's own return link is an
 * inline `sfhl:/`, so each transport is now fixed by the direction it serves. Both stay listed so
 * links already in the wild keep opening.
 */
export const LINK_CODECS: LinkCodec[] = [bespokeCodec, shlCodec];
