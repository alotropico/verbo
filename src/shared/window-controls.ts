export type WindowState = {
  nativeControls: boolean;
  maximized: boolean;
};

export type WindowControlsApi = {
  getState: () => Promise<WindowState>;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  subscribe: (listener: (state: WindowState) => void) => () => void;
};
