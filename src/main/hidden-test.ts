import { isAbsolute, join } from "node:path";

type HiddenTestPaths = {
  root: string;
  userData: string;
  sessionData: string;
  aloProfile: string;
};

/** Opt-in development presentation isolation; never changes command policy. */
export function hiddenTestPaths(env: NodeJS.ProcessEnv, packaged: boolean): HiddenTestPaths | null {
  const root = env.VERBO_HIDDEN_TEST_ROOT;
  if (!root) return null;
  if (packaged || !isAbsolute(root)) throw new Error("Hidden acceptance requires an absolute development campaign root.");
  const paths = {
    root,
    userData: join(root, "user-data"),
    sessionData: join(root, "session-data"),
    aloProfile: join(root, "alo-profile", "alo.sqlite"),
  };
  if (
    !env.VERBO_ALO_NODE ||
    !isAbsolute(env.VERBO_ALO_NODE) ||
    !env.VERBO_ALO_ENTRY ||
    !isAbsolute(env.VERBO_ALO_ENTRY) ||
    env.VERBO_ALO_PROFILE !== paths.aloProfile
  )
    throw new Error("Hidden acceptance requires all three isolated Alo overrides.");
  return paths;
}
