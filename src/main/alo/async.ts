/** App-facing stores await Alo; local engine fixtures may keep synchronous ports. */
export type AsyncMethods<Store> = {
  [Key in keyof Store]: Store[Key] extends (...args: infer Args) => infer Result ? (...args: Args) => Promise<Awaited<Result>> : Store[Key];
};
