/**
 * Paths the OAuth flow depends on.
 *
 * Shared constants rather than literals, because `redirect_uri` must match what is registered with the
 * authorisation server *exactly* — a mismatch between the value sent at authorize time and the one
 * registered is refused, and the failure appears as an opaque error on the server's own page rather
 * than anywhere in this app.
 */

export const LAUNCH_PATH = '/launch';
export const CALLBACK_PATH = '/callback';

/**
 * Where a deployer finds what to register. Not part of the OAuth flow.
 *
 * A sibling of {@link LAUNCH_PATH} on purpose: `/launch` redirects the moment it renders, so it can
 * never carry setup instructions, and somebody who cannot complete a launch needs somewhere to read
 * that is not the thing that is failing.
 */
export const LAUNCH_SETUP_PATH = '/launch/setup';
