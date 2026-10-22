import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { useSettingsSession } from "./settings-session-context";
import type { SettingsResourceState } from "@/runtime/settings-resource";

const inactive = (): (() => void) => () => undefined;

export function useSettingsResource<Value>(
  key: string,
  loader: () => Promise<Value>,
  enabled = true,
): SettingsResourceState<Value> & { reload: () => Promise<void> } {
  const resource = useSettingsSession().resource(key, loader);
  const state = useSyncExternalStore(enabled ? resource.subscribe : inactive, resource.snapshot, resource.snapshot);
  useLayoutEffect(() => {
    resource.configure(loader);
  }, [resource, loader]);
  useEffect(() => {
    if (enabled) void resource.load();
  }, [resource, enabled]);
  return { ...state, reload: resource.reload };
}
