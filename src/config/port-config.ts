import { z } from "zod";

/**
 * The TCP port the server binds to.
 *
 * Previously this was `Number(process.env.PORT ?? 3000)`, which silently accepted anything. `PORT=`
 * (an empty value, which is what a platform's environment editor leaves behind when a variable is
 * cleared) became `0`, and Node reads `0` as "bind whatever ephemeral port the OS hands out" — the
 * service would start, report healthy, and be unreachable at the port anyone expected. `PORT=8O80`
 * with a letter O became `NaN`, which Node also treats as an ephemeral port. Both are configuration
 * mistakes that must fail the deploy, not produce a running service listening in the wrong place.
 *
 * On Render this variable is **injected by the platform** and must be left unset in the service's own
 * environment. It exists here so that a hand-set value on any host is checked.
 */

/** `[D]` Unchanged from the previous implicit default, so an unset `PORT` behaves exactly as before. */
export const DEFAULT_PORT = 3000;

/**
 * `[D]` The full valid TCP range, minus `0`. Zero is a legal argument to `listen()` but it is never a
 * legitimate *configuration* value: it means "I do not care which port", which no deployment does.
 * Ports below 1024 are left permitted — they are wrong on most hosts but correct inside a container
 * that runs as root, and this is not the layer that knows which.
 */
const portSchema = z.number().int().min(1).max(65_535);

/**
 * @throws {Error} when `PORT` is set to something that is not a valid port. The message names the
 * variable and the accepted range; the offending value is not echoed, in keeping with the rule that a
 * startup log line quotes no environment value.
 */
export function loadPort(env: NodeJS.ProcessEnv = process.env): number {
  const rawPort = env.PORT?.trim();

  if (rawPort === undefined || rawPort === "") {
    return DEFAULT_PORT;
  }

  const result = portSchema.safeParse(Number(rawPort));

  if (!result.success) {
    throw new Error("Invalid environment configuration: PORT (must be an integer from 1 to 65535)");
  }

  return result.data;
}
